import { type FieldEntry, isPathEntry, resolveKeyedShape } from "../spec.ts";
import type { AstNode } from "./ast.ts";
import { parseModule } from "./ast.ts";
import { type Blocker, blockerFor } from "./blockers.ts";
import { createClaimSet } from "./claims.ts";
import {
  arrayElements,
  arrayElementType,
  arrowFn,
  binary,
  blockBody,
  boolLit,
  callTo,
  callToAny,
  constDecl,
  constDeclTypeName,
  exportedDeclaration,
  functionBody,
  functionName,
  functionParams,
  functionReturnType,
  hasLeadingComment,
  identName,
  identTypeAnnotation,
  ifStatement,
  importNames,
  importSource,
  isAsyncFunction,
  isIdent,
  isNullLiteral,
  newOf,
  objectProps,
  returnArgument,
  stringLit,
  throwArgument,
  typeAliasName,
  typeAliasRhsName,
  typeOperator,
  unionTypes,
} from "./read.ts";

/**
 * The inverse of src/emit/search-filter.ts's `emitSearchFilter`. This is the first file this
 * deriver reads that is not src/server.ts, so `recognizeSearchFilter` below carries its OWN
 * totality rule over its own statement list — the same discipline server.ts's `deriveSpec`
 * applies, applied to the second file rather than assumed away.
 */

/** One tool's recovered filter — `fields` omitted means the throwing stub. */
export type FilterEntry = { readonly export: string; readonly fields?: FieldEntry[] };

export type SearchFilterResult = {
  /**
   * "Zzsearch" from "ZzsearchSearchMatchOptions" — the caller (index.ts) turns this into
   * `spec.title` when it differs from the schema's own default.
   */
  readonly titleFragment: string;
  /**
   * One entry per exported filter, in FILE order — the same order
   * `spec.tools.filter(t => t.impl === "search")` iterates, since both derive from the identical
   * `spec.tools` array.
   */
  readonly filters: readonly FilterEntry[];
};

export type SearchFilterDerivation =
  | { ok: true; result: SearchFilterResult }
  | { ok: false; blockers: Blocker[] };

function blocked(kind: string, detail: string): SearchFilterDerivation {
  return { ok: false, blockers: [{ kind, detail, line: 0 }] };
}

const TITLE_SUFFIX = "SearchMatchOptions";

/**
 * `export type <Title>SearchMatchOptions = SearchMatchOptions;` — the only place `spec.title` is
 * recoverable for a hand-rolled/read-only-kit connector (rest-kit recovers it from the registrar
 * name instead — see index.ts's `recognizeRestTitle`). Both the alias's own name and its
 * right-hand side are pinned: the RHS is always the bare `SearchMatchOptions` reference.
 */
function matchTitleAlias(stmt: AstNode): string | undefined {
  const decl = exportedDeclaration(stmt);
  const aliasName = typeAliasName(decl);
  if (aliasName === undefined || typeAliasRhsName(decl) !== "SearchMatchOptions") {
    return undefined;
  }
  if (!aliasName.endsWith(TITLE_SUFFIX) || aliasName.length === TITLE_SUFFIX.length) {
    return undefined;
  }
  return aliasName.slice(0, -TITLE_SUFFIX.length);
}

/**
 * `stringField(row, "<key>")` / `nestedString(row, [...])` / `tagText(row)` /
 * `tagNamesFromObjects(row)` — one element of the extractor's returned array, the inverse of
 * `renderEntry`.
 */
function matchEntryCall(node: AstNode): FieldEntry | undefined {
  const stringArgs = callTo(node, "stringField", 2);
  if (stringArgs !== undefined) {
    return isIdent(stringArgs[0], "row") ? stringLit(stringArgs[1]) : undefined;
  }

  const nestedArgs = callTo(node, "nestedString", 2);
  if (nestedArgs !== undefined) {
    if (!isIdent(nestedArgs[0], "row")) return undefined;
    const elements = arrayElements(nestedArgs[1]);
    if (elements === undefined) return undefined;
    const path: string[] = [];
    for (const el of elements) {
      const s = stringLit(el);
      if (s === undefined) return undefined;
      path.push(s);
    }
    // SearchFilterSchema's own superRefine (src/spec.ts) rejects a "path" entry with fewer
    // than two segments — a one-segment path is indistinguishable from the plain-key form, so
    // the emitter never writes one and this recognizer must not accept it either.
    return path.length >= 2 ? { path } : undefined;
  }

  const objectsArgs = callTo(node, "tagNamesFromObjects", 1);
  if (objectsArgs !== undefined) {
    return isIdent(objectsArgs[0], "row") ? { tags: "objects" } : undefined;
  }

  const textArgs = callTo(node, "tagText", 1);
  if (textArgs !== undefined) {
    return isIdent(textArgs[0], "row") ? { tags: "text" } : undefined;
  }

  return undefined;
}

/** `readonly string[] | null` — `fieldsOf`'s fixed return-type annotation, exactly. */
function matchFieldsOfReturnType(node: AstNode | undefined): boolean {
  const members = unionTypes(node);
  if (members?.length !== 2) return false;
  const [arrayOperand, nullType] = members as [AstNode, AstNode];
  if (nullType.type !== "TSNullKeyword") return false;

  const op = typeOperator(arrayOperand);
  if (op?.operator !== "readonly") return false;
  return arrayElementType(op.typeAnnotation)?.type === "TSStringKeyword";
}

/**
 * `function fieldsOf(item: unknown): readonly string[] | null { const row = asObjectish(item);
 * if (row === undefined) { return null; } return [ <entries> ]; }` — the bespoke-extractor form,
 * pinned to every gap docs/ROADMAP.md's "Known limitations" records as the reason almost none of
 * the 26 expressible corpus files byte-match: the guard is always `asObjectish` (never
 * `asRecord`), the declaration is always a named `function` (never an arrow with a type
 * annotation), the function is always named exactly `fieldsOf`, and it carries no doc comment.
 */
function matchExtractorFunction(stmt: AstNode): FieldEntry[] | undefined {
  if (stmt.type !== "FunctionDeclaration" || isAsyncFunction(stmt)) return undefined;
  if (functionName(stmt) !== "fieldsOf" || hasLeadingComment(stmt)) return undefined;

  const params = functionParams(stmt);
  if (params?.length !== 1) return undefined;
  const param = params[0];
  if (identName(param) !== "item" || identTypeAnnotation(param)?.type !== "TSUnknownKeyword") {
    return undefined;
  }
  if (!matchFieldsOfReturnType(functionReturnType(stmt))) return undefined;

  const body = functionBody(stmt);
  if (body?.length !== 3) return undefined;
  const [rowStmt, guardStmt, returnStmt] = body as [AstNode, AstNode, AstNode];

  const rowDecl = constDecl(rowStmt);
  if (rowDecl?.name !== "row") return undefined;
  const guardArgs = callTo(rowDecl.init, "asObjectish", 1);
  if (guardArgs === undefined || !isIdent(guardArgs[0], "item")) return undefined;

  // `if (row === undefined) { return null; }` — matched exactly, no `else`.
  const guard = ifStatement(guardStmt);
  if (guard === undefined || guard.alternate !== undefined) return undefined;
  const test = binary(guard.test);
  if (test?.operator !== "===" || !isIdent(test.left, "row") || !isIdent(test.right, "undefined")) {
    return undefined;
  }
  const guardBody = blockBody(guard.consequent);
  if (guardBody?.length !== 1 || !isNullLiteral(returnArgument(guardBody[0]))) return undefined;

  // `return [ <entries> ];`
  const elements = arrayElements(returnArgument(returnStmt));
  if (elements === undefined || elements.length === 0) return undefined;
  const entries: FieldEntry[] = [];
  for (const el of elements) {
    const entry = matchEntryCall(el);
    if (entry === undefined) return undefined;
    entries.push(entry);
  }
  // emitSearchFilter writes the extractor form ONLY when resolveKeyedShape refuses the field list
  // (see its `keyedShape`); for a keys-expressible list it writes `fieldsFromKeys([...])` instead.
  // Recovering these entries would derive a spec that regenerates a DIFFERENT file — the
  // wrong-claim class, which the totality rule cannot see because the statement was claimed, just
  // claimed wrongly. Same source of truth as the schema's superRefine and validateSpec, so the
  // three cannot drift.
  if (resolveKeyedShape(entries) !== undefined) return undefined;
  return entries;
}

/**
 * `export const <export> = makeQueryFilter(<fieldsOf-identifier>);` — the second of the
 * extractor form's two statements, following `matchExtractorFunction` above.
 */
function matchExtractorExport(stmt: AstNode): string | undefined {
  const decl = constDecl(exportedDeclaration(stmt));
  if (decl === undefined) return undefined;
  const args = callTo(decl.init, "makeQueryFilter", 1);
  if (args === undefined || !isIdent(args[0], "fieldsOf")) return undefined;
  return decl.name;
}

/**
 * `export const <export> = makeQueryFilter(fieldsFromKeys([...] [, { tags: true }]));` — the
 * keyed form, one statement. `fieldsFromKeys` takes one or two arguments (the options object
 * only when `tags` is set), so its arity is checked here rather than through `callTo`'s fixed
 * arity. A trailing `{ tags: "text" }` FieldEntry is the reconstruction chosen when the option
 * is present — see `emitSearchFilter`'s `keyedShape`: it converges legacy `tags: true` and a
 * trailing tag entry onto identical bytes, so either recovery regenerates the same file; the
 * entry form is chosen because it stays valid even when `keys` is empty (SearchFilterSchema
 * requires `fields.min(1)`, which a bare `tags: true` with `fields: []` would violate).
 */
function matchKeyedFilter(stmt: AstNode): FilterEntry | undefined {
  const decl = constDecl(exportedDeclaration(stmt));
  if (decl === undefined) return undefined;
  const outerArgs = callTo(decl.init, "makeQueryFilter", 1);
  if (outerArgs === undefined) return undefined;

  const innerArgs = callToAny(outerArgs[0], "fieldsFromKeys");
  if (innerArgs === undefined || innerArgs.length < 1 || innerArgs.length > 2) return undefined;

  const elements = arrayElements(innerArgs[0]);
  if (elements === undefined) return undefined;
  const keys: string[] = [];
  for (const el of elements) {
    const s = stringLit(el);
    if (s === undefined) return undefined;
    keys.push(s);
  }

  let tags = false;
  if (innerArgs.length === 2) {
    const props = objectProps(innerArgs[1]);
    const only = props?.length === 1 ? props[0] : undefined;
    if (only === undefined || only.key !== "tags" || boolLit(only.value) !== true) {
      return undefined;
    }
    tags = true;
  }

  const fields: FieldEntry[] = tags ? [...keys, { tags: "text" }] : keys;
  // Unreachable from a valid spec (SearchFilterSchema requires fields.min(1)), but guarded
  // rather than assumed: `fieldsFromKeys([])` with no tags option is not a shape any spec can
  // produce, so accepting it would derive `fields: []`, itself unparseable by that same schema.
  if (fields.length === 0) return undefined;
  return { export: decl.name, fields };
}

/**
 * `export const <export>: SearchFilter = () => { throw new Error("..."); };` — the throwing
 * stub. The message text is NOT verified: it embeds the search tool's own `name`, which this
 * function (reading only the filter file) cannot cross-check — an unreadable message still
 * derives `fields: undefined` correctly, since that is the only spec shape producing a stub at
 * all, and a mismatched message surfaces as an ordinary byte mismatch downstream rather than a
 * wrong derivation.
 */
function matchStubFilter(stmt: AstNode): FilterEntry | undefined {
  const exported = exportedDeclaration(stmt);
  const decl = constDecl(exported);
  if (decl === undefined || constDeclTypeName(exported) !== "SearchFilter") return undefined;

  const arrow = arrowFn(decl.init);
  if (arrow === undefined || arrow.isAsync || !arrow.isBlock || arrow.params.length !== 0) {
    return undefined;
  }
  const body = blockBody(arrow.body);
  if (body?.length !== 1) return undefined;
  const args = newOf(throwArgument(body[0]), "Error", 1);
  if (args === undefined || stringLit(args[0]) === undefined) return undefined;

  return { export: decl.name };
}

/** Mirrors `src/emit/search-filter.ts`'s `byBareName` — sort key ignoring the `type ` prefix. */
function byBareName(a: string, b: string): number {
  return a.replace("type ", "").localeCompare(b.replace("type ", ""));
}

/** Mirrors `primitivesFor` — the shared primitives one extractor's entries name. */
function primitivesForEntries(entries: readonly FieldEntry[]): string[] {
  const names = new Set<string>(["asObjectish"]);
  for (const e of entries) {
    if (typeof e === "string") names.add("stringField");
    else if (isPathEntry(e)) names.add("nestedString");
    else names.add(e.tags === "objects" ? "tagNamesFromObjects" : "tagText");
  }
  return [...names];
}

/**
 * Mirrors `filterImportNames` — the import list the emitter would have written for this
 * recognized set of filters. Computed from the BODY (this function's caller has already
 * recognized every filter statement) rather than read off the preamble, so the preamble becomes
 * a cross-check on the body instead of an obstacle to it.
 */
function expectedFilterNames(
  keyedCount: number,
  extractorEntriesList: readonly (readonly FieldEntry[])[],
): string[] {
  const names: string[] = [];
  if (keyedCount > 0) names.push("fieldsFromKeys");
  if (keyedCount > 0 || extractorEntriesList.length > 0) names.push("makeQueryFilter");
  for (const entries of extractorEntriesList) {
    for (const n of primitivesForEntries(entries)) {
      if (!names.includes(n)) names.push(n);
    }
  }
  names.push("type SearchMatchOptions");
  return names.sort(byBareName);
}

const SHARED = "../../shared/search-filter.ts";
const SEARCH_TOOL = "../../shared/mcp-search-tool.ts";
const KIT = "@nimbus-dev/sdk/connector-kit";

/**
 * One plain named-import clause: every specifier a value import bound to its own name (the
 * emitter never aliases one of these), or a `type` import — matched against `expected`'s exact
 * name SET and ORDER, not merely its members. `renderBlockImport`'s one-line-vs-wrapped choice
 * is pure formatting and carries no AST distinction, so it is not (and need not be) checked here.
 */
function matchPlainNamedImport(stmt: AstNode, from: string, expected: readonly string[]): boolean {
  if (importSource(stmt) !== from) return false;
  const names = importNames(stmt);
  if (names === undefined || names.some((n) => n.imported !== n.local)) return false;
  const actual = names.map((n) => (n.isType ? `type ${n.imported}` : n.imported));
  return actual.length === expected.length && actual.every((n, i) => n === expected[i]);
}

/**
 * The monorepo import shape: one statement from `../../shared/search-filter.ts` naming every
 * primitive the body uses, preceded — only when at least one filter is a throwing stub — by a
 * second statement importing `type SearchFilter` from `../../shared/mcp-search-tool.ts` (the
 * ONLY place that type is declared; emitting it from `search-filter.ts` would be an unresolved
 * import in the generated package's own `tsc`, per `renderImportLines`'s own comment).
 */
function matchMonorepoImports(
  preamble: readonly AstNode[],
  filterNames: readonly string[],
  anyStub: boolean,
): AstNode[] | undefined {
  if (anyStub) {
    if (preamble.length !== 2) return undefined;
    const [stubStmt, mainStmt] = preamble as [AstNode, AstNode];
    if (!matchPlainNamedImport(stubStmt, SEARCH_TOOL, ["type SearchFilter"])) return undefined;
    if (!matchPlainNamedImport(mainStmt, SHARED, filterNames)) return undefined;
    return [stubStmt, mainStmt];
  }
  if (preamble.length !== 1) return undefined;
  const [mainStmt] = preamble as [AstNode];
  return matchPlainNamedImport(mainStmt, SHARED, filterNames) ? [mainStmt] : undefined;
}

/** The standalone import shape: one barrel import naming every primitive plus, when any filter is a stub, `type SearchFilter` too — both sorted together by `byBareName`, as `renderImportLines`'s standalone branch writes them. */
function matchStandaloneImports(
  preamble: readonly AstNode[],
  filterNames: readonly string[],
  anyStub: boolean,
): AstNode[] | undefined {
  if (preamble.length !== 1) return undefined;
  const expected = (anyStub ? [...filterNames, "type SearchFilter"] : [...filterNames]).sort(
    byBareName,
  );
  const [stmt] = preamble as [AstNode];
  return matchPlainNamedImport(stmt, KIT, expected) ? [stmt] : undefined;
}

function matchImports(
  preamble: readonly AstNode[],
  filterNames: readonly string[],
  anyStub: boolean,
): AstNode[] | undefined {
  return (
    matchMonorepoImports(preamble, filterNames, anyStub) ??
    matchStandaloneImports(preamble, filterNames, anyStub)
  );
}

/** One filter statement (or two, for the extractor form), plus which BUCKET it counts toward for `expectedFilterNames`. */
type FilterMatch = {
  readonly entry: FilterEntry;
  readonly consumed: AstNode[];
  readonly kind: "keyed" | "extractor" | "stub";
};

function matchOneFilter(statements: readonly AstNode[], i: number): FilterMatch | undefined {
  const stmt = statements[i];
  if (stmt === undefined) return undefined;

  const keyed = matchKeyedFilter(stmt);
  if (keyed !== undefined) return { entry: keyed, consumed: [stmt], kind: "keyed" };

  const stub = matchStubFilter(stmt);
  if (stub !== undefined) return { entry: stub, consumed: [stmt], kind: "stub" };

  const next = statements[i + 1];
  if (next === undefined) return undefined;
  const fields = matchExtractorFunction(stmt);
  if (fields === undefined) return undefined;
  const exportName = matchExtractorExport(next);
  if (exportName === undefined) return undefined;
  return { entry: { export: exportName, fields }, consumed: [stmt, next], kind: "extractor" };
}

/**
 * The inverse of `emitSearchFilter` (src/emit/search-filter.ts). `source` is `src/search-filter.ts`'s
 * own text — a SEPARATE file from `src/server.ts`, so this function carries its own totality
 * rule over its own statement list rather than assuming the preamble away: every statement here
 * must be claimed by SOMETHING or the derivation refuses, the identical discipline
 * `src/derive/index.ts`'s `deriveSpec` applies to the server file.
 *
 * The type alias is matched first (it is always the emitted file's second top-level construct,
 * after its import(s), and is found by scanning rather than assumed at a fixed index — see its
 * own docstring). Everything after it is walked positionally, recognizing one filter per
 * iteration; everything before it is checked LAST, against the import list the recognized
 * filters imply — the emitter's own ordering ("the recognizer reads the body first, computes
 * the import list the emitter would have written") rather than an assumption about the preamble.
 *
 * `titleFragment` (folded into `spec.title` by the caller — index.ts's `deriveSharedStyleSpec`)
 * is checked against only ONE of `spec.title`'s two consumers here — the type alias itself — the
 * same shape docs/ROADMAP.md's "Known limitations" records as unsound for rest-kit's
 * `recognizeRestTitle`: that recovery verifies the registrar-name round trip and leaves
 * `src/emit/readme.ts`'s independent use of `spec.title` unchecked, and because
 * `registrarNameFor` (src/spec.ts) is a LOSSY `replaceAll(/[^A-Za-z0-9]/g, "")`, a title that
 * reproduces the sanitized registrar name is not guaranteed to reproduce `README.md`'s bytes —
 * bounded by the `all-identical` tier rather than silent, but still a real gap.
 *
 * That gap does NOT apply here, and the reason is `emitSearchFilter` itself: `` `export type
 * ${spec.title}SearchMatchOptions = SearchMatchOptions;` `` splices `spec.title` into the alias
 * name with NO sanitization — unlike `registrarNameFor`, nothing is stripped, so the extraction
 * (`aliasName.slice(0, -TITLE_SUFFIX.length)`) is an exact inverse for every string this
 * generator's own emitter can produce, not merely a round-trip check on a lossy formula. Since
 * `emitReadme`'s two templates (`src/emit/readme.ts`) also splice `spec.title` verbatim with no
 * sanitization of their own, a `titleFragment` that reproduces THIS alias reproduces `README.md`
 * byte-for-byte too.
 *
 * Scoped deliberately to what `generate()` actually emits — `src/emit/wiring.ts`'s
 * `titleIdentifier` applies the SAME lossy `replaceAll(/[^A-Za-z0-9]/g, "")` regex to
 * `spec.title` that `registrarNameFor` does, so a third, independently-lossy consumer of
 * `spec.title` does exist in this codebase. It does not undermine the argument above only
 * because `emitWiring`/`renderWiringInstructions` are not part of `generate()`'s output (see
 * `src/emit/index.ts`) and therefore outside both the round-trip test's file set and the
 * `all-identical` byte-diff tier — a claim about round-tripping every file `generate()` produces
 * has nothing to say about a file it does not produce.
 */
export function recognizeSearchFilter(source: string): SearchFilterDerivation {
  let statements: AstNode[];
  try {
    statements = parseModule(source);
  } catch (err) {
    return blocked("search-filter:parse-error", err instanceof Error ? err.message : String(err));
  }

  const claims = createClaimSet();

  const aliasIdx = statements.findIndex((s) => matchTitleAlias(s) !== undefined);
  if (aliasIdx === -1) {
    return blocked(
      "search-filter:no-type-alias",
      "no export type <Title>SearchMatchOptions alias was found",
    );
  }
  const aliasStmt = statements[aliasIdx];
  if (aliasStmt === undefined) {
    return blocked(
      "search-filter:no-type-alias",
      "no export type <Title>SearchMatchOptions alias was found",
    );
  }
  const titleFragment = matchTitleAlias(aliasStmt);
  if (titleFragment === undefined) {
    return blocked(
      "search-filter:no-type-alias",
      "no export type <Title>SearchMatchOptions alias was found",
    );
  }
  claims.claim(aliasStmt, "type-alias");

  const preamble = statements.slice(0, aliasIdx);
  const rest = statements.slice(aliasIdx + 1);

  const filters: FilterEntry[] = [];
  const claimedFilterStatements: AstNode[] = [];
  let keyedCount = 0;
  const extractorEntriesList: FieldEntry[][] = [];
  let anyStub = false;

  let i = 0;
  while (i < rest.length) {
    const match = matchOneFilter(rest, i);
    if (match === undefined) break;
    filters.push(match.entry);
    claimedFilterStatements.push(...match.consumed);
    if (match.kind === "keyed") keyedCount++;
    else if (match.kind === "extractor" && match.entry.fields !== undefined) {
      extractorEntriesList.push(match.entry.fields);
    } else if (match.kind === "stub") anyStub = true;
    i += match.consumed.length;
  }
  claims.claim(claimedFilterStatements, "filter");

  const filterNames = expectedFilterNames(keyedCount, extractorEntriesList);
  const importStatements = matchImports(preamble, filterNames, anyStub);
  if (importStatements !== undefined) claims.claim(importStatements, "import");

  const unclaimed = claims.unclaimed(statements);
  if (unclaimed.length > 0) {
    return { ok: false, blockers: unclaimed.map((n) => blockerFor(n, source)) };
  }

  // Totality passing is vacuous for an empty file (nothing to leave unclaimed) — refuse
  // explicitly rather than deriving a filter-less result, the same reason recognizeTools
  // refuses zero reg() calls rather than deriving `{ tools: [] }`.
  if (filters.length === 0) {
    return blocked("search-filter:no-filters", "no export const <name> = ... filter was found");
  }

  return { ok: true, result: { titleFragment, filters } };
}
