import type { StaticPathStyle } from "../../spec.ts";
import type { AstNode } from "../ast.ts";
import type { ClaimSet } from "../claims.ts";
import {
  arrowFn,
  awaited,
  blockBody,
  callArgs,
  calleeOf,
  callTo,
  expressionOf,
  isIdent,
  newOf,
  stringLit,
  throwArgument,
} from "../read.ts";
import { type ArgFields, recognizeArgs, type SchemaShape } from "./args.ts";
import { type BodyTool, recognizeBodyExpr } from "./body.ts";
import { mergeHoistedArgs, recognizeHoistedBlock } from "./hoists.ts";
import { type PathLocal, recognizePath } from "./path-template.ts";
import { type BasePrefix, PATH_LOCAL, type QueryEntry, recognizeQueryBlock } from "./query.ts";
import { recognizeSearchTool, type SearchToolFields } from "./search.ts";

/**
 * The inverse of src/emit/server/tools-hand.ts's renderTool — recovers one `reg(...)` call's
 * declared spec fields, including which of the two fetch helpers produced the call:
 * `jsonResult(await <helper>(<path>, ...))` for GET, `<helper>Send(<path>, <method>, <body>)`
 * for everything else. Reading the path argument without checking WHICH function produced it
 * used to derive a POST tool as a GET read tool — see `fetchCall`'s docstring.
 */
export type ToolFields = {
  name: string;
  description: string;
  args: Record<string, ArgFields>;
  /**
   * Omitted only for a stub (`impl: "stub"`) — `ToolSchema`'s own refine pins that pairing both
   * ways: `(t.impl === "stub") === (t.path === undefined)` (src/spec.ts). Every other shape this
   * deriver recognizes always sets it.
   */
  path?: string;
  /**
   * "stub" when the handler is the throwing placeholder `renderTool`'s `impl === "stub"` branch
   * writes, in either emitter (src/emit/server/tools-hand.ts, tools-rest.ts) —
   * `recognizeStubShape` below (and tools-rest.ts's own use of `recognizeStubHandler`) is its
   * only source. Omitted for every
   * other tool kind, the same omit-the-default discipline `method` already uses below, so a
   * non-stub tool's derived spec is byte-unchanged by this field's existence.
   */
  impl?: "stub";
  /**
   * Omitted for GET, so ToolSchema's `.default("GET")` applies and a read connector's derived
   * spec is byte-unchanged by this field's existence. Two emitted shapes carry a method literal
   * and each has its own reader: the hand-rolled write helper's call site, read by this file, and
   * the rest-kit registrar's arity-5 init callback `{ method: "POST", … }`, read by
   * `recognizeInitFn` (server/tools-rest.ts). This docstring named only the first, which was true
   * until that callback was recognized. Always omitted for a stub — ToolSchema's refine pins one
   * to `method: "GET"`, so there is nothing non-default to record.
   */
  method?: "POST" | "PUT" | "PATCH" | "DELETE";
  /**
   * The entries recovered from a query-branch handler (see server/query.ts). Omitted for every
   * other handler shape, so a tool with none is byte-unchanged by this field's existence — the
   * same reason `method` is omitted for GET. It lives on the shared `ToolFields` rather than on
   * tools-rest.ts's own result because `renderQueryLines` writes one statement shape for both
   * styles, parameterised only by the handler's parameter name.
   */
  query?: QueryEntry[];
  /**
   * The `arg name -> API field name` mapping, recovered ONLY when the observed JSON body differs
   * from what `renderBodyExpr`'s default would have produced — see server/body.ts's header.
   * Omitted otherwise, so a tool whose body IS the default is byte-unchanged by this field's
   * existence, the same reason `method` is omitted for GET.
   */
  body?: Record<string, string>;
};

/**
 * The connector-wide `handlerStyle` recovered from the SET of recognized tools, not from any
 * one of them — `handlerStyle` is a top-level `ConnectorSpec` field
 * (`z.enum(["concise","block"]).default("concise")`, src/spec.ts), not a per-tool one.
 *
 * The result of one tool's recognition, before that aggregation: whether its handler was a
 * block body, and — only meaningful when it was — whether that block contained any hoisted
 * consts. `staticStyle`/`schemaShape` are the same per-tool evidence for the other two
 * connector-wide style votes (index.ts's `voteStaticPathStyle`/`voteArgsSchemaStyle`) — carried
 * here rather than folded into `fields`, because neither belongs on a TOOL in the derived spec:
 * both are `ConnectorSpecSchema`/`FetchHelperSchema` fields, and `ToolSchema` is a
 * `strictObject` that would reject them.
 *
 * `votesHandlerStyle` is false for the three shapes whose handler form the emitter FORCES,
 * independently of `spec.handlerStyle`, and which therefore carry no evidence for the vote below
 * — counting any of them would force `handlerStyle: "block"` on connectors that never declared
 * it, regardless of what their OTHER tools show:
 *
 *   - a search tool: `renderSearchTool` always writes a hoist-free block;
 *   - a query tool: `renderTool`'s `if (query !== undefined)` branch returns its block form
 *     BEFORE the `used.size === 0 && spec.handlerStyle === "concise"` test is ever reached
 *     (src/emit/server/tools-hand.ts), so a query tool with no hoists is a block a "concise"
 *     connector emits too;
 *   - a stub tool: `renderTool`'s `if (tool.impl === "stub")` branch returns its block form even
 *     earlier still — before the schema-and-path machinery both the query branch and the plain
 *     form share is ever reached — so a stub is a block every connector emits, "concise" or not.
 *
 * `basePrefix` is set only for a query tool, whose `new URL(...)` was rendered with the fetch
 * helper's base spliced in ahead of the path. It is not a spec field — it is a fact about this
 * module that only the assembly can check, against the fetch helper recognized separately from
 * the same file. See `BasePrefix`.
 */
type ToolShape = {
  fields: ToolFields | SearchToolFields;
  isBlock: boolean;
  hasHoists: boolean;
  votesHandlerStyle: boolean;
  staticStyle?: StaticPathStyle;
  schemaShape: SchemaShape;
  basePrefix?: BasePrefix;
};

/** `handlerStyle` omitted lets ConnectorSpecSchema's `.default("concise")` apply. `staticPathStyles`/
 * `schemaShapes` are the per-tool style evidence index.ts's two votes consume. */
export type ToolsResult = {
  tools: (ToolFields | SearchToolFields)[];
  handlerStyle?: "block";
  staticPathStyles: readonly (StaticPathStyle | undefined)[];
  schemaShapes: readonly SchemaShape[];
  /**
   * Parallel to `tools`, and `undefined` for every tool that is not a query tool — the same
   * per-index shape `staticPathStyles` uses, and the same field tools-rest.ts's `RestToolsResult`
   * carries. The caller reads it alongside `tools[i]`, which is what lets a `literal` prefix's
   * base be taken off that tool's own path; see `BasePrefix`.
   */
  basePrefixes: readonly (BasePrefix | undefined)[];
};

function isRegCall(node: AstNode): AstNode | undefined {
  const call = expressionOf(node);
  return isIdent(calleeOf(call), "reg") ? call : undefined;
}

const WRITE_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);

type FetchCall = {
  path: AstNode;
  method?: "POST" | "PUT" | "PATCH" | "DELETE";
  /**
   * The write helper's third argument, handed back UNREAD — `renderBodyExpr`'s output, or the
   * literal `undefined` for a tool that sends no body. Absent for the read helper's one-argument
   * call. Read by `readBody` below rather than here, for the same reason `QueryBlock.returned` is
   * handed back unread: interpreting it needs the tool's merged args, path and query, none of
   * which exist yet at this point.
   */
  bodyNode?: AstNode;
};

/**
 * The read helper `<local>(path)` or the write helper `<local>Send(path, "METHOD", body)`, and
 * NOTHING else. Reading args[0] without checking the callee derived a POST tool as a GET read
 * tool — losing method, effect and therefore the manifest's hitlRequired — which is a wrong
 * artifact rather than a byte mismatch, and invisible to the totality rule because the statement
 * was claimed, just claimed wrongly. deriveRestKitSpec already performs the equivalent refusal.
 */
function fetchCall(call: AstNode, helperLocal: string): FetchCall | undefined {
  const callee = calleeOf(call);
  const args = callArgs(call);
  if (args === undefined) return undefined;

  if (isIdent(callee, helperLocal)) {
    return args.length === 1 && args[0] !== undefined ? { path: args[0] } : undefined;
  }
  if (isIdent(callee, `${helperLocal}Send`)) {
    if (args.length !== 3 || args[0] === undefined || args[2] === undefined) return undefined;
    const method = stringLit(args[1]);
    if (method === undefined || !WRITE_METHODS.has(method)) return undefined;
    return {
      path: args[0],
      method: method as "POST" | "PUT" | "PATCH" | "DELETE",
      bodyNode: args[2],
    };
  }
  return undefined;
}

/**
 * The `body` half of one recognized tool: `{}` when there is nothing to record, `{ body: … }`
 * when the observed literal differs from `renderBodyExpr`'s default, `undefined` to refuse the
 * tool. Spread straight into `ToolFields`.
 *
 * `bodyNode` is absent exactly when the call went through the READ helper, which takes only a
 * path — so a call with no body argument that nonetheless recovered a `method` is a shape
 * `renderTool` cannot write (`callPath` picks the helper FROM the method) and is refused rather
 * than read as a bodyless write.
 *
 * `hoistsInScope` is `true` for every caller here: `renderTool` (src/emit/server/tools-hand.ts)
 * builds the body inside the same handler block as the hoists and passes the full
 * `hoistedLocals(tool.args)` map, so a defaulted arg always reaches the body through its hoisted
 * const. The caller that passes `false` is `recognizeInitFn` (server/tools-rest.ts), reading the
 * rest-kit registrar's arity-5 init callback, whose body is built outside any hoist block.
 */
function readBody(
  bodyNode: AstNode | undefined,
  tool: BodyTool,
): { body?: Record<string, string> } | undefined {
  if (bodyNode === undefined) return tool.method === "GET" ? {} : undefined;
  return recognizeBodyExpr(bodyNode, tool, true);
}

function awaitedCall(node: AstNode | undefined): AstNode | undefined {
  const call = awaited(node);
  return call?.type === "CallExpression" ? call : undefined;
}

/** `jsonResult(await helper(path, ...))` -> the awaited call. */
function jsonResultCall(node: AstNode | undefined): AstNode | undefined {
  const args = callTo(node, "jsonResult", 1);
  return args === undefined ? undefined : awaitedCall(args[0]);
}

/**
 * `jsonResult(await <helper|helperSend>(...))` -> its path ARGUMENT, unread, and the method.
 *
 * Split out from `pathFromJsonResult` below for the query branch, whose path argument is the bare
 * `path` binding its own tail declares rather than a path expression `recognizePath` could read.
 * One reader for both, not two: reading args[0] without checking the callee is what derived a
 * POST tool as a GET read tool once already (see `fetchCall`), and a query tool routes through
 * the same two helpers a plain tool does — `renderTool` substitutes only the path, keeping the
 * method's choice of helper (src/emit/server/tools-hand.ts's `callPath`).
 */
function fetchFromJsonResult(
  node: AstNode | undefined,
  helperLocal: string,
): FetchCall | undefined {
  const helperCall = jsonResultCall(node);
  return helperCall === undefined ? undefined : fetchCall(helperCall, helperLocal);
}

/** The declared path, its static-path-style evidence, and the method and unread body argument
 * recovered from `jsonResult(await <helper|helperSend>(...))`. */
function pathFromJsonResult(
  node: AstNode | undefined,
  locals: ReadonlyMap<string, PathLocal>,
  helperLocal: string,
):
  | {
      path: string;
      staticStyle?: StaticPathStyle;
      method?: "POST" | "PUT" | "PATCH" | "DELETE";
      bodyNode?: AstNode;
    }
  | undefined {
  const fetched = fetchFromJsonResult(node, helperLocal);
  if (fetched === undefined) return undefined;
  const recognized = recognizePath(fetched.path, locals);
  if (recognized === undefined) return undefined;
  return {
    path: recognized.path,
    ...(recognized.staticStyle === undefined ? {} : { staticStyle: recognized.staticStyle }),
    ...(fetched.method === undefined ? {} : { method: fetched.method }),
    ...(fetched.bodyNode === undefined ? {} : { bodyNode: fetched.bodyNode }),
  };
}

/**
 * `reg(name, description, schema, handler)`'s four arguments, with the two string-literal ones
 * already read — the exact starting point `recognizeOne` and `recognizeStubShape` both need,
 * shared here rather than duplicated. tools-rest.ts's own four-argument unpack is already
 * factored into `registrarCallParts` for the identical reason (see that function's own
 * docstring); leaving this one duplicated across two functions in the same file is how the two
 * *files'* recognizers drifted before hoists.ts was extracted, one level down.
 */
type RegCallParts = {
  readonly name: string;
  readonly description: string;
  readonly schemaNode: AstNode;
  readonly handlerNode: AstNode;
};

function regCallParts(call: AstNode): RegCallParts | undefined {
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
  return { name, description, schemaNode, handlerNode };
}

/** What `recognizeQueryTool` needs from the `reg()` call its caller has already read. */
type RegPreamble = {
  readonly name: string;
  readonly description: string;
  readonly args: Readonly<Record<string, ArgFields>>;
  readonly schemaShape: ToolShape["schemaShape"];
};

/**
 * The query branch — `renderTool`'s `if (query !== undefined)` block (src/emit/server/
 * tools-hand.ts). Tried only once the plain hoists-then-return reader has refused, exactly as
 * tools-rest.ts's `recognizeOneCall` orders the same pair: the two are disjoint by construction
 * (that reader requires exactly one statement after the hoists, this one at least four).
 *
 * Its own function because it is disjoint from the other two forms by that same construction, and
 * inline it was the only part of `recognizeOne` whose guards sat a level deep.
 *
 * `staticStyle` is deliberately absent from what this returns — see `QueryBlock`'s docstring for
 * why a query tool carries no evidence of the connector's `staticPathStyle` at all.
 */
function recognizeQueryTool(
  body: AstNode,
  helperLocal: string,
  preamble: RegPreamble,
): ToolShape | undefined {
  const query = recognizeQueryBlock(body, preamble.args, "binds-path");
  if (query?.returned === undefined) return undefined;

  // The tail's `return` is read by the SAME reader the two non-query forms use, so a non-GET
  // query tool recovers its `method` — and therefore its effect and the manifest's
  // hitlRequired — exactly as a non-GET plain tool does. Its path argument must be the binding
  // the tail's own `const path` declares, not merely any identifier: `renderTool` substitutes
  // the literal `"path"` for the inline path expression (`callPath`), so a call fetching
  // anything else is a shape it cannot write.
  const fetched = fetchFromJsonResult(query.returned, helperLocal);
  if (fetched === undefined || !isIdent(fetched.path, PATH_LOCAL)) return undefined;

  const queryArgs = mergeHoistedArgs(preamble.args, query.hoistMeta);
  if (queryArgs === undefined) return undefined;

  // `query.path` still carries the fetch helper's base prefix here (rebaseQueryTools, in
  // src/derive/index.ts, takes it off later) — harmless for the default body's exclusion set,
  // which reads only the path's ARG placeholders, and `defaultBodyArgs` refuses rather than
  // throws on a prefix that will not parse.
  const readBodyResult = readBody(fetched.bodyNode, {
    args: queryArgs,
    path: query.path,
    query: query.query,
    method: fetched.method ?? "GET",
  });
  if (readBodyResult === undefined) return undefined;

  return {
    fields: {
      name: preamble.name,
      description: preamble.description,
      args: queryArgs,
      path: query.path,
      ...(fetched.method === undefined ? {} : { method: fetched.method }),
      query: query.query,
      ...readBodyResult,
    },
    isBlock: true,
    hasHoists: query.hoistMeta.size > 0,
    votesHandlerStyle: false,
    schemaShape: preamble.schemaShape,
    basePrefix: query.basePrefix,
  };
}

function recognizeOne(call: AstNode, helperLocal: string): ToolShape | undefined {
  const parts = regCallParts(call);
  if (parts === undefined) return undefined;
  const { name, description, schemaNode, handlerNode } = parts;

  const arrow = arrowFn(handlerNode);
  if (arrow === undefined) return undefined;

  const argsResult = recognizeArgs(schemaNode);
  if (argsResult === undefined) return undefined;
  const schemaShape = {
    propertyCount: Object.keys(argsResult.args).length,
    oneLine: argsResult.schemaStyle === "inline",
  };

  // The concise, expression-bodied form: `async (...) => jsonResult(await helper(path))`.
  if (!arrow.isBlock) {
    const recovered = pathFromJsonResult(arrow.body, new Map(), helperLocal);
    if (recovered === undefined) return undefined;
    const { staticStyle, bodyNode, ...pathFields } = recovered;
    // No hoists exist in this form at all, so no body field can reference one — and the emitter
    // agrees: a body that reads a hoisted const adds it to `used`, which forces the block form.
    const body = readBody(bodyNode, {
      args: argsResult.args,
      path: pathFields.path,
      method: pathFields.method ?? "GET",
    });
    if (body === undefined) return undefined;
    return {
      fields: { name, description, args: argsResult.args, ...pathFields, ...body },
      isBlock: false,
      hasHoists: false,
      votesHandlerStyle: true,
      staticStyle,
      schemaShape,
    };
  }

  // The block form: zero or more hoisted-argument consts, then a single `return jsonResult(...)`.
  // A tool whose block contains anything else (a stub's `throw`, say) is a shape THIS recognizer
  // does not model, and is refused rather than partially read — hoists.ts's
  // `recognizeHoistedBlock` is where that refusal happens, shared with tools-rest.ts, which reads
  // the identical hoist statements behind a different registrar. The query branch's `new URL(...)`
  // trio is the one shape that refusal hands on rather than ends at; see below. A stub's throw is
  // the other: `recognizeTools`'s loop falls on to `recognizeStubShape` once `recognizeOne`
  // (i.e. this whole function) refuses, rather than teaching this reader a shape with no hoists
  // and no `jsonResult` at all.
  const block = recognizeHoistedBlock(arrow.body);
  if (block === undefined) {
    return recognizeQueryTool(arrow.body, helperLocal, {
      name,
      description,
      args: argsResult.args,
      schemaShape,
    });
  }

  const recovered = pathFromJsonResult(block.returned, block.locals, helperLocal);
  if (recovered === undefined) return undefined;
  const { staticStyle, bodyNode, ...pathFields } = recovered;

  // Gap A / Gap B: renderZodSchema never encodes `local` or `default` in the schema text
  // itself (recognizeArgs, above, cannot see either), so both are only visible at the hoist
  // statement — merge them back onto the matching arg now that both are known.
  const mergedArgs = mergeHoistedArgs(argsResult.args, block.hoistMeta);
  if (mergedArgs === undefined) return undefined;

  // After the merge, deliberately: two of `fieldValue`'s three cases turn on an arg's `default`
  // and `local`, neither of which the schema text carries.
  const body = readBody(bodyNode, {
    args: mergedArgs,
    path: pathFields.path,
    method: pathFields.method ?? "GET",
  });
  if (body === undefined) return undefined;

  return {
    fields: { name, description, args: mergedArgs, ...pathFields, ...body },
    isBlock: true,
    hasHoists: block.locals.size > 0,
    votesHandlerStyle: true,
    staticStyle,
    schemaShape,
  };
}

/**
 * The fallback tried when `recognizeOne` does not recognize a `reg(...)` call — a search tool's
 * handler is shaped entirely differently (`renderSearchTool` never writes `jsonResult`, so
 * `recognizeOne`'s block-form reader always and safely refuses it; see `search.ts`'s own module
 * docstring). Wraps `recognizeSearchTool`'s result into the same `ToolShape` shape `recognizeOne`
 * produces so the caller's loop, claim and votes do not need to know which recognizer fired.
 *
 * `isBlock`/`hasHoists` are reported as what `renderSearchTool` actually writes (a block with no
 * hoists) rather than a value chosen to influence the vote — `votesHandlerStyle: false` is what
 * excludes this shape from the vote outright, so these two stay honest.
 */
function recognizeSearchShape(call: AstNode, helperLocal: string): ToolShape | undefined {
  const result = recognizeSearchTool(call, helperLocal);
  if (result === undefined) return undefined;
  return {
    fields: result.fields,
    isBlock: true,
    hasHoists: false,
    votesHandlerStyle: false,
    staticStyle: result.staticStyle,
    schemaShape: result.schemaShape,
  };
}

/**
 * `{ throw new Error("<name> is not implemented"); }` — the ONE statement `renderTool`'s
 * `impl === "stub"` branch ever writes, in EITHER registration style — that branch exists in both
 * src/emit/server/tools-hand.ts, as this file's own `reg(...)` stub, and in
 * src/emit/server/tools-rest.ts, as the registrar stub. The
 * two differ only in whether the wrapping arrow is `async` — this file's own stub always is,
 * tools-rest.ts's never is — so `requireAsync` is supplied by the caller rather than fixed here;
 * it is the one thing that differs between the two shapes, and exported so tools-rest.ts reads
 * the identical block rather than growing a second copy of this check (the drift `hoists.ts` was
 * extracted to stop, restated for a third shape).
 *
 * The thrown message is DERIVED from `name` — the tool's own declared name, already read by the
 * caller — not an author-supplied string: `renderTool` always writes exactly
 * `` `${tool.name} is not implemented` ``, so anything else (even a similar message) is a
 * hand-written stub this generator was never asked to produce, and is refused. A statement before
 * the throw, a thrown value that is not `new Error(...)`, or a parameter on the arrow are each
 * refused for the same reason: none is a shape `renderTool` can write.
 */
export function recognizeStubHandler(node: AstNode, name: string, requireAsync: boolean): boolean {
  const arrow = arrowFn(node);
  if (arrow === undefined || !arrow.isBlock || arrow.isAsync !== requireAsync) return false;
  if (arrow.params.length !== 0) return false;
  const statements = blockBody(arrow.body);
  if (statements?.length !== 1) return false;
  const errArgs = newOf(throwArgument(statements[0]), "Error", 1);
  if (errArgs === undefined) return false;
  return stringLit(errArgs[0]) === `${name} is not implemented`;
}

/**
 * The fallback tried when neither `recognizeOne` nor `recognizeSearchShape` recognizes a
 * `reg(...)` call — `renderTool`'s `impl === "stub"` branch (src/emit/server/tools-hand.ts), the
 * same four-argument call shape `recognizeOne` reads (`regCallParts`, shared with it), but a
 * handler that throws rather than fetches. `recognizeStubHandler` above does the actual check,
 * requiring `async` — this file's own stub always writes it, unlike tools-rest.ts's.
 *
 * `isBlock: true, hasHoists: false` report what the emitter actually writes — the same discipline
 * `recognizeSearchShape`'s docstring states for its own two fields — and `votesHandlerStyle:
 * false` is what excludes this shape from the connector-wide vote: see `ToolShape`'s own
 * docstring for why (the identical reasoning that renamed `isSearch` to `votesHandlerStyle` in
 * the first place, restated for a third shape rather than re-derived here).
 */
function recognizeStubShape(call: AstNode): ToolShape | undefined {
  const parts = regCallParts(call);
  if (parts === undefined) return undefined;
  const { name, description, schemaNode, handlerNode } = parts;
  if (!recognizeStubHandler(handlerNode, name, true)) return undefined;

  const argsResult = recognizeArgs(schemaNode);
  if (argsResult === undefined) return undefined;

  return {
    fields: { name, description, args: argsResult.args, impl: "stub" },
    isBlock: true,
    hasHoists: false,
    votesHandlerStyle: false,
    schemaShape: {
      propertyCount: Object.keys(argsResult.args).length,
      oneLine: argsResult.schemaStyle === "inline",
    },
  };
}

/**
 * Every `reg(...)` call in the module, or undefined if any one of them is not understood.
 *
 * All-or-nothing on purpose: a connector with nine recognized tools and one bespoke handler is
 * not nine-tenths regenerable, it is blocked — deriving a spec for the nine would produce a
 * server.ts missing a tool, which then fails the byte-diff for a reason the report would
 * misattribute to formatting rather than to the real, unmodeled tenth handler.
 *
 * `handlerStyle` is recovered here, from the SET of recognized tools, not per-tool — see
 * renderTool in src/emit/server/tools-hand.ts: a hoist forces a block body regardless of
 * `spec.handlerStyle` (`used.size === 0 && spec.handlerStyle === "concise"` is the only
 * condition that renders the one-line concise form), so a block body alone is not evidence of
 * `handlerStyle: "block"` — a block body with ZERO hoists is, because that shape can only come
 * from an explicit "block" setting; a "concise" connector would have rendered that same tool
 * as the one-line form instead.
 *
 * Two style-carrying shapes are consistent with a single connector-wide value:
 *   - "concise": some tools render concise (no hoists needed), the rest render block (hoists
 *     forced it) — never a block tool with zero hoists.
 *   - "block": every tool renders block, hoisted or not — never a concise tool.
 * A module mixing a concise tool with a block-without-hoists tool matches neither, and is
 * refused as an unmodeled shape rather than guessed at.
 *
 * `helperLocal` is the fetch helper's recognized name (`FetchHelperFields.local`), threaded in
 * by the caller so `fetchCall` can verify each reg() handler's fetch call is actually the
 * connector's own helper rather than assume it. It is `undefined` when `recognizeFetchHelper`
 * itself found nothing — with no name to check a callee against, refusing every call here is the
 * only option that does not risk attributing a method/effect to a call this recognizer cannot
 * verify. Refusing claims nothing, so those reg() statements fall through to the totality rule
 * and are reported by name rather than silently inheriting the (unrelated) no-fetch-helper case.
 */
export function recognizeTools(
  statements: readonly AstNode[],
  claims: ClaimSet,
  helperLocal: string | undefined,
): ToolsResult | undefined {
  if (helperLocal === undefined) return undefined;

  const regs = statements
    .map((statement) => ({ statement, call: isRegCall(statement) }))
    .filter((entry): entry is { statement: AstNode; call: AstNode } => entry.call !== undefined);

  // A frame with zero reg() calls is not a hand-rolled connector with no tools — it is this
  // recognizer failing to find any reg() calls at all (e.g. a module this plan's recognizers
  // do not model). Deriving `{ tools: [] }` for it is accepted by parseSpec/validateSpec and
  // regenerates a connector that never existed, a false `emits`. Refuse instead.
  if (regs.length === 0) return undefined;

  const shapes: ToolShape[] = [];
  for (const { call } of regs) {
    const shape =
      recognizeOne(call, helperLocal) ??
      recognizeSearchShape(call, helperLocal) ??
      recognizeStubShape(call);
    if (shape === undefined) return undefined;
    shapes.push(shape);
  }

  // Search, query and stub shapes carry no handlerStyle evidence either way — see ToolShape's
  // own docstring — so the vote runs over the subset that does. A connector whose every tool is
  // one of those three correctly abstains entirely (both booleans false), leaving handlerStyle
  // unset.
  const votingShapes = shapes.filter((s) => s.votesHandlerStyle);
  const hasBlockWithoutHoists = votingShapes.some((s) => s.isBlock && !s.hasHoists);
  const hasConcise = votingShapes.some((s) => !s.isBlock);
  if (hasBlockWithoutHoists && hasConcise) return undefined;

  claims.claim(
    regs.map((entry) => entry.statement),
    "tools",
  );
  return {
    tools: shapes.map((s) => s.fields),
    ...(hasBlockWithoutHoists ? { handlerStyle: "block" as const } : {}),
    staticPathStyles: shapes.map((s) => s.staticStyle),
    schemaShapes: shapes.map((s) => s.schemaShape),
    basePrefixes: shapes.map((s) => s.basePrefix),
  };
}
