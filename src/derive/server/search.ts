import type { StaticPathStyle } from "../../spec.ts";
import type { AstNode } from "../ast.ts";
import type { ClaimSet } from "../claims.ts";
import {
  arrayElementType,
  arrowFn,
  asExpression,
  awaited,
  blockBody,
  callArgs,
  calleeOf,
  callTo,
  constDecl,
  identName,
  importNames,
  importSource,
  isIdent,
  numberLit,
  optionalMemberName,
  optionalMemberObject,
  propertySignature,
  returnArgument,
  stringLit,
  typeLiteralMembers,
  unionTypes,
} from "../read.ts";
import { type ArgFields, recognizeArgs, type SchemaShape } from "./args.ts";
import { recognizePath } from "./path-template.ts";
import type { ToolFields } from "./tools-hand.ts";

/**
 * The inverse of src/emit/server/search.ts's `renderSearchTool` — recovers one search `reg(...)`
 * call's declared spec fields. `ToolFields` (name/description/args/path) is reused as-is;
 * `method` never appears (ToolSchema pins a search tool to GET, see src/spec.ts's refine), so
 * this type never sets it.
 */
export type SearchToolFields = ToolFields & {
  impl: "search";
  rows?: string;
  maxLimit: number;
  filter: { export: string };
};

/**
 * `recognizeSearchTool`'s result, paired with the same per-tool style evidence
 * tools-hand.ts's `ToolShape` carries for a hand-rolled tool (see that type's docstring for why
 * `staticStyle`/`schemaShape` live beside `fields` rather than on it): a search tool's path is
 * rendered through the identical `renderPath` call, and its schema — when it declares its own
 * args — is a genuine `z.object(...)` carrying the same inline/expanded evidence.
 */
export type SearchToolResult = {
  fields: SearchToolFields;
  staticStyle?: StaticPathStyle;
  schemaShape: SchemaShape;
};

/** `z.string().min(1)` — the search schema's fixed `query` field, exactly. */
const QUERY_FIELD: ArgFields = { type: "string", min: 1 };

/** `z.number().int().min(1).max(<maxLimit>).optional()` — the search schema's fixed `limit` field. */
function limitFieldFor(maxLimit: number): ArgFields {
  return { type: "number", int: true, min: 1, max: maxLimit, optional: true };
}

/** Both sides are flat records with no nested values, so a key-by-key compare is exact. */
function fieldsEqual(a: ArgFields, b: ArgFields): boolean {
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]) as Set<keyof ArgFields>;
  return [...keys].every((k) => a[k] === b[k]);
}

type SchemaRecovery = {
  args: Record<string, ArgFields>;
  maxLimit: number;
  schemaShape: SchemaShape;
};

/**
 * `renderSchema`'s two forms: `searchToolInputSchema(N)` for a tool with no args of its own, or
 * the inlined merged `z.object({ ...tool.args, query, limit })` for one that has some. Whichever
 * form fires, `maxLimit` is recovered from it — `.max(N)` is the only place it is visible once
 * emitted, `ToolSchema.maxLimit` never appearing in the schema text any other way.
 */
function recognizeSchema(node: AstNode): SchemaRecovery | undefined {
  const bareArgs = callTo(node, "searchToolInputSchema", 1);
  if (bareArgs !== undefined) {
    const maxLimit = numberLit(bareArgs[0]);
    // A tool with no args of its own carries no z.object at all, so this branch's schema
    // shape must abstain from the argsSchemaStyle vote exactly the way an empty object does —
    // see voteArgsSchemaStyle's own docstring ("a search tool with no args of its own ... emits
    // searchToolInputSchema(n) rather than a z.object at all").
    return maxLimit === undefined
      ? undefined
      : { args: {}, maxLimit, schemaShape: { propertyCount: 0, oneLine: false } };
  }

  const merged = recognizeArgs(node);
  if (merged === undefined) return undefined;

  // The merged object's OWN property order is preserved by recognizeArgs's insertion order
  // (childList walks the ObjectExpression's properties in source order, and none of these
  // names can collide with a numeric-like key under IDENTIFIER_RE) — so the trailing two keys
  // are exactly what renderSchema appended last, in the order it appended them.
  const keys = Object.keys(merged.args);
  if (keys.at(-2) !== "query" || keys.at(-1) !== "limit") return undefined;

  const queryField = merged.args["query"];
  const limitField = merged.args["limit"];
  if (queryField === undefined || limitField === undefined) return undefined;
  if (!fieldsEqual(queryField, QUERY_FIELD)) return undefined;
  const maxLimit = limitField.max;
  if (maxLimit === undefined || !fieldsEqual(limitField, limitFieldFor(maxLimit))) {
    return undefined;
  }

  const ownArgs = { ...merged.args };
  delete ownArgs["query"];
  delete ownArgs["limit"];
  // renderSchema only ever takes this branch when `Object.keys(tool.args).length > 0` — a
  // merged z.object recovering ZERO own args is a shape the emitter would instead have written
  // as searchToolInputSchema(N), so accepting it here would derive a spec that regenerates
  // different bytes (the wrong schema form) for this exact tool.
  if (Object.keys(ownArgs).length === 0) return undefined;

  return {
    args: ownArgs,
    maxLimit,
    schemaShape: {
      propertyCount: keys.length,
      oneLine: merged.schemaStyle === "inline",
    },
  };
}

/** `await <helperLocal>(<path>)` -> the path argument, cross-checked against the connector's own recognized fetch helper — see recognizeTools's `fetchCall` for why the callee identity is checked rather than assumed. */
function matchFetchArg(node: AstNode | undefined, helperLocal: string): AstNode | undefined {
  const call = awaited(node);
  if (call?.type !== "CallExpression") return undefined;
  const args = callArgs(call);
  if (args?.length !== 1 || !isIdent(calleeOf(call), helperLocal)) return undefined;
  return args[0];
}

/** `matchesResult(...)` with exactly 3 arguments — the call every search handler ends in. */
function matchesResultArgs(node: AstNode | undefined): AstNode[] | undefined {
  return callTo(node, "matchesResult", 3);
}

/**
 * `(root as { <rows>?: unknown[] } | null)?.<rows>` — the rows-narrowing expression
 * `renderSearchTool` writes when `tool.rows` is set, pinned exactly: a TSAsExpression over the
 * Identifier `root`, typed as a two-member union (the type literal first, `null` second — the
 * only order renderSearchTool writes), one optional TSPropertySignature typed `unknown[]`, and
 * the optional member access itself — all three occurrences of `rows` are required to be the
 * SAME name, because renderSearchTool interpolates one variable into all three positions. Every
 * check here rejects a shape the emitter cannot have written; approving one derives a spec that
 * regenerates different bytes for this one statement.
 */
function matchRowsNarrowing(node: AstNode | undefined, rows: string): boolean {
  if (optionalMemberName(node) !== rows) return false;
  const asExpr = asExpression(optionalMemberObject(node));
  if (asExpr === undefined || !isIdent(asExpr.expression, "root")) return false;

  const members = unionTypes(asExpr.typeAnnotation);
  if (members?.length !== 2) return false;
  const [literal, nullType] = members;
  if (nullType?.type !== "TSNullKeyword") return false;

  const typeMembers = typeLiteralMembers(literal);
  if (typeMembers?.length !== 1) return false;
  const prop = propertySignature(typeMembers[0]);
  if (prop === undefined || prop.key !== rows || !prop.optional) return false;

  const arrayType = prop.valueType;
  if (arrayType?.type !== "TSArrayType") return false;
  return arrayElementType(arrayType)?.type === "TSUnknownKeyword";
}

type SearchBody = { path: AstNode; filterExport: string; rows?: string };

/** `return matchesResult(<fetchExpr>, <filterExport>, <param>);` — the no-`rows` handler body, exactly one statement. */
function recognizeNoRowsBody(
  statements: readonly AstNode[],
  helperLocal: string,
  param: string,
): SearchBody | undefined {
  if (statements.length !== 1) return undefined;
  const args = matchesResultArgs(returnArgument(statements[0]));
  if (args === undefined) return undefined;
  const [fetchNode, filterNode, paramNode] = args;

  const path = matchFetchArg(fetchNode, helperLocal);
  if (path === undefined) return undefined;
  const filterExport = identName(filterNode);
  if (filterExport === undefined || !isIdent(paramNode, param)) return undefined;
  return { path, filterExport };
}

/**
 * `const root = <fetchExpr>; const <rows> = (root as ...)?.<rows>; return
 * matchesResult(<rows>, <filterExport>, <param>);` — the `rows` handler body, exactly three
 * statements, matched positionally the same way server/fetch-helper.ts's `matchFetchHelperBody`
 * walks its own body rather than searching for known shapes independently.
 */
function recognizeRowsBody(
  statements: readonly AstNode[],
  helperLocal: string,
  param: string,
): SearchBody | undefined {
  if (statements.length !== 3) return undefined;
  const [rootStmt, rowsStmt, returnStmt] = statements;

  const rootDecl = constDecl(rootStmt);
  if (rootDecl?.name !== "root") return undefined;
  const path = matchFetchArg(rootDecl.init, helperLocal);
  if (path === undefined) return undefined;

  const rowsDecl = constDecl(rowsStmt);
  if (rowsDecl === undefined || !matchRowsNarrowing(rowsDecl.init, rowsDecl.name)) {
    return undefined;
  }
  const rows = rowsDecl.name;

  const args = matchesResultArgs(returnArgument(returnStmt));
  if (args === undefined) return undefined;
  const [rowsArg, filterNode, paramNode] = args;
  if (!isIdent(rowsArg, rows)) return undefined;
  const filterExport = identName(filterNode);
  if (filterExport === undefined || !isIdent(paramNode, param)) return undefined;

  return { path, filterExport, rows };
}

/**
 * The inverse of `renderSearchTool` (src/emit/server/search.ts). `call` is one `reg(...)`
 * CallExpression — the same shape tools-hand.ts's `recognizeOne` reads, tried first by the
 * caller; this is the fallback for the one it does not recognize, a search tool's handler being
 * shaped entirely differently (always an async block, never `jsonResult`).
 *
 * `helperLocal` is threaded in by the caller exactly as tools-hand.ts's `recognizeOne` receives
 * it, so the awaited call's callee can be cross-checked against the connector's own recognized
 * fetch helper rather than assumed — the same landmine `fetchCall`'s docstring there names.
 */
export function recognizeSearchTool(
  call: AstNode,
  helperLocal: string,
): SearchToolResult | undefined {
  const args = callArgs(call);
  if (args?.length !== 4) return undefined;
  const [nameNode, descriptionNode, schemaNode, handlerNode] = args as [
    AstNode,
    AstNode,
    AstNode,
    AstNode,
  ];
  const name = stringLit(nameNode);
  const description = stringLit(descriptionNode);
  if (name === undefined || description === undefined) return undefined;

  // renderSearchTool always writes an async, single-parameter, BLOCK-bodied handler — never
  // the concise expression-bodied form tools-hand.ts's recognizeOne also models (that is the
  // trap: counting this shape in the handlerStyle vote would force "block" on every connector
  // with a search tool — excluded by the caller, not here).
  const arrow = arrowFn(handlerNode);
  if (arrow === undefined || !arrow.isBlock || !arrow.isAsync || arrow.params.length !== 1) {
    return undefined;
  }
  const param = identName(arrow.params[0]);
  if (param === undefined) return undefined;

  const schema = recognizeSchema(schemaNode);
  if (schema === undefined) return undefined;

  const statements = blockBody(arrow.body);
  if (statements === undefined) return undefined;

  const body =
    recognizeNoRowsBody(statements, helperLocal, param) ??
    recognizeRowsBody(statements, helperLocal, param);
  if (body === undefined) return undefined;

  const recognizedPath = recognizePath(body.path, new Map());
  if (recognizedPath === undefined) return undefined;

  return {
    fields: {
      name,
      description,
      args: schema.args,
      path: recognizedPath.path,
      impl: "search",
      ...(body.rows === undefined ? {} : { rows: body.rows }),
      maxLimit: schema.maxLimit,
      filter: { export: body.filterExport },
    },
    staticStyle: recognizedPath.staticStyle,
    schemaShape: schema.schemaShape,
  };
}

// ---------------------------------------------------------------------------
// The two search-specific server.ts imports — src/emit/server/index.ts's `searchKitNames`
// (`matchesResult`, `searchToolInputSchema`) and `filterImport` (the local re-export of every
// filter this server calls). Neither is written by `renderSearchTool` above; both are written
// only once ANY search tool exists, and claimed here only by the caller, and only once a search
// tool is positively recognized — the same scoping `recognizeReadOnlyFrame`
// (src/derive/server/index.ts) uses for its own frame imports. Claiming them unconditionally
// would let a non-search module have an unrelated import claimed.
// ---------------------------------------------------------------------------

const SEARCH_TOOL_IMPORT = "../../shared/mcp-search-tool.ts";
const LOCAL_FILTER_IMPORT = "./search-filter.ts";

/** `import { matchesResult[, searchToolInputSchema] } from ".../mcp-search-tool.ts";` — plain names, no aliasing, no type, in that fixed order. */
function matchSearchKitImport(node: AstNode, needsInputSchema: boolean): boolean {
  if (importSource(node) !== SEARCH_TOOL_IMPORT) return false;
  const names = importNames(node);
  if (names === undefined) return false;
  const expected = needsInputSchema
    ? ["matchesResult", "searchToolInputSchema"]
    : ["matchesResult"];
  return (
    names.length === expected.length &&
    names.every((n, i) => !n.isType && n.imported === n.local && n.imported === expected[i])
  );
}

/**
 * Biome's `assist/source/organizeImports` ordering for a clause of plain, untyped,
 * un-aliased names (every filter export — see `filterImport`'s own docstring in
 * src/emit/server/index.ts): case-folded first character, tie-broken by a plain string
 * compare. The full `biomeNamedImportOrder` algorithm there also weighs `type`/alias status,
 * which never applies to a filter export name, so this is that algorithm specialised to the
 * one shape this import ever carries.
 */
function biomeFilterNameOrder(names: readonly string[]): string[] {
  return [...names].sort((a, b) => {
    const la = a.charAt(0).toLowerCase();
    const lb = b.charAt(0).toLowerCase();
    if (la !== lb) return la < lb ? -1 : 1;
    return a < b ? -1 : a > b ? 1 : 0;
  });
}

/** `import { <export>, ... } from "./search-filter.ts";` — every search tool's own filter export, Biome-ordered. */
function matchLocalFilterImport(node: AstNode, exportNames: readonly string[]): boolean {
  if (importSource(node) !== LOCAL_FILTER_IMPORT) return false;
  const names = importNames(node);
  if (names === undefined || names.some((n) => n.isType || n.imported !== n.local)) return false;
  const expected = biomeFilterNameOrder(exportNames);
  const actual = names.map((n) => n.imported);
  return actual.length === expected.length && actual.every((n, i) => n === expected[i]);
}

/**
 * Claims the two search-specific imports, found anywhere in `statements` (the frame's
 * `verifyStatements`) — each independently, so a mismatch on one does not block claiming the
 * other. An import this cannot match stays unclaimed and is reported by the ordinary totality
 * rule (`import-from:<source>`), the same way a mismatched src/search-filter.ts import is
 * reported by that file's own totality rule — no separate named blocker is needed for either.
 *
 * This models only the monorepo import shape; the standalone barrel form is
 * `search-filter.ts`'s own `matchStandaloneImports`' job, so a standalone search connector's
 * server.ts always blocks here, unclaimed, before its filter file is ever read — a branch
 * exercised only by that function's own unit test, not by any fixture in this repository.
 */
export function claimSearchImports(
  statements: readonly AstNode[],
  claims: ClaimSet,
  searchTools: readonly SearchToolFields[],
): void {
  if (searchTools.length === 0) return;

  const needsInputSchema = searchTools.some((t) => Object.keys(t.args).length === 0);
  const exportNames = searchTools.map((t) => t.filter.export);

  const kitImport = statements.find((s) => matchSearchKitImport(s, needsInputSchema));
  const filterImport = statements.find((s) => matchLocalFilterImport(s, exportNames));

  const toClaim = [
    ...(kitImport === undefined ? [] : [kitImport]),
    ...(filterImport === undefined ? [] : [filterImport]),
  ];
  if (toClaim.length > 0) claims.claim(toClaim, "search-imports");
}
