import type { StaticPathStyle } from "../../spec.ts";
import type { AstNode } from "../ast.ts";
import type { ClaimSet } from "../claims.ts";
import {
  arrowFn,
  callArgs,
  calleeOf,
  callTo,
  constDecl,
  expressionOf,
  identName,
  isIdent,
  objectProps,
  stringLit,
} from "../read.ts";
import { recognizeArgs, type SchemaShape } from "./args.ts";
import { recognizeBodyExpr } from "./body.ts";
import { mergeHoistedArgs, recognizeHoistedBlock } from "./hoists.ts";
import { recognizePath } from "./path-template.ts";
import { type BasePrefix, recognizeQueryBlock } from "./query.ts";
import { recognizeStubHandler, type ToolFields } from "./tools-hand.ts";

/**
 * The inverse of src/emit/server/tools-rest.ts's `renderRestKitTools` — recovers the
 * `makeRestToolRegistrar` factory's fields (`recognizeRestRegistrar`) and every
 * `<registrar>(...)` call's declared spec fields (`recognizeRestTools`), as two SEPARATE exports
 * rather than one. `ToolFields` is the same type tools-hand.ts's recognizer produces: `method`
 * and `body` are omitted for an arity-4 call (always a `GET`) and recovered from the arity-5
 * call's own 5th argument otherwise — see `recognizeOneCall` and `recognizeInitFn`.
 *
 * The split exists because the two halves have different claiming rules, and collapsing them
 * into one function's return value would hide that. The factory is WIRING, not a registration —
 * the rest-kit analogue of `createZodToolRegistrar(...)`, which `recognizeFrame` already claims
 * unconditionally as one of its five wiring elements, regardless of whether tool recognition
 * later succeeds (see server/index.ts). `recognizeRestRegistrar` claims the factory the moment
 * its own four-key shape is recognized, independent of what the calls do. `recognizeRestTools`
 * stays strictly all-or-nothing over the calls, matching `recognizeTools`: one unrecognized call
 * and it claims none of them.
 *
 * This is safe — it changes only which HISTOGRAM BUCKET an unrecognized module reports, never
 * the outcome — because the unrecognized calls still stay unclaimed either way, so the totality
 * rule still blocks the connector and no spec is ever produced from a partial call set. Without
 * the split, `circleci`, `github-actions` and `pagerduty` (each of which mixes bare `reg(...)`
 * calls and a query-branch call among their `register<X>Tool(...)` calls — both out of this
 * plan's scope) would keep reporting `const-call:makeRestToolRegistrar` as their blocker: a
 * false claim that the factory recognizer does not exist, pointed the other way — sending a
 * future maintainer to build one that is already here.
 */
type Factory = {
  readonly statement: AstNode;
  readonly registrar: string;
  readonly serviceLabel: string;
  readonly tokenEnv: string;
  readonly fetchLocal: string;
};

/**
 * `const <registrar> = makeRestToolRegistrar({ registrar: reg, tokenEnv: "...", serviceLabel:
 * "...", fetch: <local> });` — checked key-for-key against renderRestKitTools's factory
 * literal: exactly these four keys, in this order (the emitter never writes them any other
 * way), `registrar` bound to the literal identifier `reg` (wiring() in server/index.ts always
 * names it that, for both hand-rolled and rest-kit), and `fetch` an identifier — the read
 * helper's own name, recovered here as `fetchLocal`. A fifth key, a reordering, or a
 * `registrar` bound to anything but `reg` is a shape the emitter cannot produce and is
 * rejected wholesale, not merely ignored.
 */
function recognizeFactory(statement: AstNode): Factory | undefined {
  const decl = constDecl(statement);
  if (decl === undefined) return undefined;
  const args = callTo(decl.init, "makeRestToolRegistrar", 1);
  if (args === undefined) return undefined;

  const props = objectProps(args[0]);
  if (props?.length !== 4) return undefined;

  const registrarProp = props[0];
  const tokenEnvProp = props[1];
  const serviceLabelProp = props[2];
  const fetchProp = props[3];
  if (
    registrarProp === undefined ||
    tokenEnvProp === undefined ||
    serviceLabelProp === undefined ||
    fetchProp === undefined
  ) {
    return undefined;
  }

  if (registrarProp.key !== "registrar" || !isIdent(registrarProp.value, "reg")) return undefined;

  if (tokenEnvProp.key !== "tokenEnv") return undefined;
  const tokenEnv = stringLit(tokenEnvProp.value);
  if (tokenEnv === undefined) return undefined;

  if (serviceLabelProp.key !== "serviceLabel") return undefined;
  const serviceLabel = stringLit(serviceLabelProp.value);
  if (serviceLabel === undefined) return undefined;

  if (fetchProp.key !== "fetch") return undefined;
  const fetchLocal = identName(fetchProp.value);
  if (fetchLocal === undefined) return undefined;

  return { statement, registrar: decl.name, serviceLabel, tokenEnv, fetchLocal };
}

/** `<registrar>(...)` as a top-level ExpressionStatement — the same shape tools-hand.ts's `isRegCall` checks, but against a dynamic name rather than the literal `reg`. */
function isRegistrarCall(node: AstNode, registrar: string): AstNode | undefined {
  const call = expressionOf(node);
  return isIdent(calleeOf(call), registrar) ? call : undefined;
}

type RegistrarCallParts = {
  readonly name: string;
  readonly description: string;
  readonly schemaNode: AstNode;
  readonly pathFnNode: AstNode;
  /**
   * The 5th `initFn` argument, present exactly when the call is arity 5 — a non-`GET` method,
   * and optionally a body (`renderTool`'s `initArg`, src/emit/server/tools-rest.ts). Undefined
   * for arity 4, which is always a `GET`.
   */
  readonly initFnNode: AstNode | undefined;
};

/**
 * `<registrar>(name, description, schema, pathFn)`'s four arguments, with the two string-literal
 * ones already read, plus the optional 5th `initFn` argument — arity 4 or arity 5 only.
 * `renderTool` never writes a bare 3 or a padded 6, so no other arity is a shape this recognizer
 * needs to model.
 *
 * Arity 5 used to be refused wholesale here (see `recognizeOneCall`'s docstring for the history);
 * this function only READS the 5th argument's presence, so widening it to accept arity 5 carries
 * none of that risk itself — `recognizeOneCall` is what decides whether the 5th argument's own
 * shape is one `recognizeInitFn` can actually interpret, and refuses the whole call when it is
 * not.
 *
 * The per-element `undefined` checks are `noUncheckedIndexedAccess` bookkeeping, not a second
 * arity test: the length check above them already fixed the count at four or five.
 */
function registrarCallParts(call: AstNode): RegistrarCallParts | undefined {
  const args = callArgs(call);
  if (args?.length !== 4 && args?.length !== 5) return undefined;

  const nameNode = args[0];
  const descriptionNode = args[1];
  const schemaNode = args[2];
  const pathFnNode = args[3];
  if (
    nameNode === undefined ||
    descriptionNode === undefined ||
    schemaNode === undefined ||
    pathFnNode === undefined
  ) {
    return undefined;
  }

  let initFnNode: AstNode | undefined;
  if (args.length === 5) {
    initFnNode = args[4];
    if (initFnNode === undefined) return undefined;
  }

  const name = stringLit(nameNode);
  const description = stringLit(descriptionNode);
  if (name === undefined || description === undefined) return undefined;

  return { name, description, schemaNode, pathFnNode, initFnNode };
}

/**
 * One `<registrar>(...)` call's fields, plus the same two connector-wide style votes'
 * per-tool evidence tools-hand.ts's `ToolShape` carries — see that type's docstring for why
 * neither `staticStyle` nor `schemaShape` belongs on `ToolFields` itself.
 *
 * `basePrefix` is a third piece of per-tool evidence with the same character: set only for a
 * query tool, whose `new URL(...)` was rendered with the fetch helper's base spliced in ahead of
 * the path. It is not a spec field — it is a fact about this module that only the assembly can
 * check, against the fetch helper recognized separately from the same file. See `BasePrefix`.
 */
type ToolShape = {
  readonly fields: ToolFields;
  readonly staticStyle?: StaticPathStyle;
  readonly schemaShape: SchemaShape;
  readonly basePrefix?: BasePrefix;
};

/**
 * Every `pathFn` branch's own recognized fields, before the optional `initFn` is read. `path` is
 * re-required here (Task 7 made `ToolFields.path` optional, for the stub shape alone): every one
 * of the four `pathFn` forms below always recovers a real path string — none of them is the stub
 * branch, which `recognizeOneCall` reads through a completely separate arm before ever reaching
 * these — so widening `ToolFields.path` must not widen this type along with it.
 */
type BaseToolFields = Omit<ToolFields, "method" | "body" | "path"> & { path: string };

/**
 * Mirrors tools-hand.ts's own (unexported) `WRITE_METHODS` rather than importing it — the two
 * recognizers otherwise share nothing, and a private name reused across files by convention alone
 * (not by an import) is exactly the kind of coupling that drifts silently. Both sides are pinned
 * to `ToolSchema`'s own `z.enum(["GET", "POST", "PUT", "PATCH", "DELETE"])` (src/spec.ts) minus
 * "GET", so a schema change would need both updated in step regardless of who owns the constant.
 */
const WRITE_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);

/**
 * The optional 5th argument — `() => ({ method: "DELETE" })` or
 * `(parsed) => ({ method: "POST", body: JSON.stringify({ … }) })` — recovered against `tool`,
 * the fields the `pathFn` already produced.
 *
 * The object literal has exactly one or two keys, `method` always first: `renderTool`'s
 * `initArg` writes `{ method: ${JSON.stringify(tool.method)}${bodyPart} }`, where `bodyPart` is
 * either `""` or `, body: ${bodyExpr}` — never a third key, never `body` alone, never reordered.
 *
 * **The parameter/body correspondence is pinned in both directions.** `renderTool`'s `initParam`
 * is `"()"` exactly when `bodyExpr` is undefined and `"(parsed)"` exactly when it is not — forced
 * by the generated package's `noUnusedParameters`, since an unreferenced `parsed` fails its own
 * typecheck. So a `body` key with a zero-param arrow, or a one-param arrow with no `body` key,
 * is a shape `renderTool` cannot write, and each is refused rather than partially read.
 *
 * `hoistsInScope: false` is passed to `recognizeBodyExpr`, not because nothing was hoisted in
 * this connector, but because the init callback is a SEPARATE arrow from the path callback —
 * `renderTool` builds it with an empty `hoisted` map, since nothing the path callback's hoists
 * declared is in scope here. A defaulted arg is therefore ALWAYS the inlined `?? <default>` form
 * in this callback, never the hoisted const's own name, whatever the path callback did with the
 * same arg — see body.ts's `bodyValueArg` docstring for the two forms this distinguishes, and
 * `recognizeBodyExpr`'s own "contract for the rest-kit caller" tests for the both-directions
 * check that a wrong value here would fail rather than derive quietly.
 */
function recognizeInitFn(
  node: AstNode,
  tool: BaseToolFields,
): { method: "POST" | "PUT" | "PATCH" | "DELETE"; body?: Record<string, string> } | undefined {
  const arrow = arrowFn(node);
  if (arrow === undefined || arrow.isBlock || arrow.isAsync || arrow.params.length > 1) {
    return undefined;
  }

  const props = objectProps(arrow.body);
  if (props === undefined || (props.length !== 1 && props.length !== 2)) return undefined;

  const methodProp = props[0];
  if (methodProp === undefined || methodProp.key !== "method") return undefined;
  const method = stringLit(methodProp.value);
  if (method === undefined || !WRITE_METHODS.has(method)) return undefined;
  const typedMethod = method as "POST" | "PUT" | "PATCH" | "DELETE";

  if (props.length === 1) {
    // No `body` key — `initParam` is `"()"` here, so a parameter is a shape the emitter cannot
    // write: `(parsed) => ({ method: "DELETE" })` is refused, not read as a bodyless write.
    return arrow.params.length === 0 ? { method: typedMethod } : undefined;
  }

  // A `body` key — `initParam` is `"(parsed)"` here: `() => ({ method: "POST", body: … })` is
  // refused the same way, from the other side.
  if (arrow.params.length !== 1) return undefined;
  const bodyProp = props[1];
  if (bodyProp === undefined || bodyProp.key !== "body") return undefined;

  const body = recognizeBodyExpr(
    bodyProp.value,
    { args: tool.args, path: tool.path, query: tool.query, method: typedMethod },
    false,
  );
  if (body === undefined) return undefined;

  return { method: typedMethod, ...body };
}

/**
 * The step every `pathFn` branch in `recognizeOneCall` funnels through: attaches `method`/`body`
 * when the call is arity 5 (`initFnNode` set), and leaves both unset — a `GET`, via
 * `ToolSchema`'s `.default("GET")` — when it is arity 4. Centralised here rather than repeated in
 * each branch, so the three `pathFn` forms and the one `initFn` form stay independent axes: any
 * of the three path shapes can pair with either arity, and this is the only place that pairing
 * happens.
 */
function withInitFn(
  fields: BaseToolFields,
  staticStyle: StaticPathStyle | undefined,
  schemaShape: SchemaShape,
  basePrefix: BasePrefix | undefined,
  initFnNode: AstNode | undefined,
): ToolShape | undefined {
  if (initFnNode === undefined) {
    return { fields, staticStyle, schemaShape, basePrefix };
  }
  const init = recognizeInitFn(initFnNode, fields);
  if (init === undefined) return undefined;
  return { fields: { ...fields, ...init }, staticStyle, schemaShape, basePrefix };
}

/**
 * One `<registrar>(name, description, schema, pathFn[, initFn])` call — arity 4 (always a `GET`)
 * or arity 5 (a non-`GET` method, and optionally a body). Arity 5 used to be refused wholesale:
 * "refused here, rather than read for its first four arguments only, so a connector that needs
 * it blocks visibly on a named blocker instead of deriving a `GET` the real connector never
 * had" — correct only while nothing could read the 5th argument. `recognizeInitFn` now can, so
 * the widening changes nothing about the four `pathFn` shapes below: each still recognizes (or
 * refuses) exactly as before, and `withInitFn` is the one new step layered on top, refusing the
 * whole call when the 5th argument does not match what `recognizeInitFn` accepts.
 *
 * `pathFn` has four in-scope forms — `() => <pathExpr>`, `(parsed) => <pathExpr>`,
 * `(parsed) => { <hoists> return <pathExpr>; }` and the query branch
 * `(parsed) => { <hoists> const u = new URL(...); <query lines> return `${u}`; }` — the first
 * three modeled the same way tools-hand.ts's `recognizeOne` models its block form, and through
 * the same shared reader (`hoists.ts`'s `recognizeHoistedBlock`); the fourth by
 * `recognizeQueryBlock` (server/query.ts), which takes a different tail off the same
 * `splitHoists`.
 *
 * Refuses an `async` path fn: `src/emit/server/tools-rest.ts` never writes `async` on this arrow,
 * the same pin `read.ts`'s `isAsync` documents and `readOnlyWrapper` (server/index.ts) already
 * applies to its own arrow. Without it, `async (parsed) => <pathExpr>` read exactly like the
 * non-async form and was claimed for a shape the emitter cannot produce.
 *
 * A stub (`renderTool`'s `if (tool.impl === "stub")` branch, tools-rest.ts:62-67) is a FIFTH
 * shape, checked before any of the four `pathFn` forms below: it is arity 4 always — a stub
 * issues no request, so ToolSchema's refine forbids the 5th `initFn` argument entirely — and its
 * "pathFn" position is the identical throw-block tools-hand.ts's own `reg()` stub writes, just
 * never `async` (`recognizeStubHandler`'s `requireAsync: false` is what tells the two apart).
 */
function recognizeOneCall(call: AstNode): ToolShape | undefined {
  const parts = registrarCallParts(call);
  if (parts === undefined) return undefined;
  const { name, description, schemaNode, pathFnNode, initFnNode } = parts;

  const argsResult = recognizeArgs(schemaNode);
  if (argsResult === undefined) return undefined;
  const schemaShape = {
    propertyCount: Object.keys(argsResult.args).length,
    oneLine: argsResult.schemaStyle === "inline",
  };

  // Checked before the pathFn forms below because none of THEM is a zero-parameter block —
  // recognizeStubHandler is the only reader for that shape, and `initFnNode === undefined` is
  // the arity-4 gate: a stub-shaped throw block paired with a 5th argument is not a shape
  // `renderTool` can write, so it is left to fall through and be refused there instead of
  // silently discarding the initFn's method/body.
  if (initFnNode === undefined && recognizeStubHandler(pathFnNode, name, false)) {
    return { fields: { name, description, args: argsResult.args, impl: "stub" }, schemaShape };
  }

  const arrow = arrowFn(pathFnNode);
  if (arrow === undefined || arrow.params.length > 1 || arrow.isAsync) return undefined;

  // Forms 1/2: `() => <pathExpr>` / `(parsed) => <pathExpr>` — expression-bodied. recognizePath
  // resolves a bare `parsed.<name>` member read without checking the receiver at all (see
  // hoists.ts's memberArgName), so neither form needs to be told which one it is.
  if (!arrow.isBlock) {
    const recognized = recognizePath(arrow.body, new Map());
    if (recognized === undefined) return undefined;
    return withInitFn(
      { name, description, args: argsResult.args, path: recognized.path },
      recognized.staticStyle,
      schemaShape,
      undefined,
      initFnNode,
    );
  }

  // Forms 3 and 4 both always take exactly one parameter, by two different clauses of the same
  // `needsParam` expression (renderTool, src/emit/server/tools-rest.ts). Form 3: a block is
  // emitted only when `used.size > 0`, i.e. a hoist exists, which forces `needsParam` true.
  // Form 4: the query branch emits a block whatever the hoists do, but every `query` entry whose
  // arg is NOT hoisted contributes `(query ?? []).some((q) => !hoisted.has(q.arg))` — and an
  // entry whose arg IS hoisted contributes through `used` via `queryArgsUsed`, so a non-empty
  // `query` forces `needsParam` true either way. A zero-param block is a shape this emitter
  // cannot produce under either form.
  if (arrow.params.length !== 1) return undefined;

  const block = recognizeHoistedBlock(arrow.body);
  if (block !== undefined) {
    // Unlike tools-hand.ts, what the block returns IS the path expression — there is no
    // `jsonResult(await ...)` wrapper to unwrap first.
    const recognized =
      block.returned === undefined ? undefined : recognizePath(block.returned, block.locals);
    if (recognized === undefined) return undefined;

    // Gap A / Gap B, same as tools-hand.ts: renderZodSchema never encodes `local` or `default` in
    // the schema text itself, so both are only visible at the hoist statement.
    const mergedArgs = mergeHoistedArgs(argsResult.args, block.hoistMeta);
    if (mergedArgs === undefined) return undefined;

    return withInitFn(
      { name, description, args: mergedArgs, path: recognized.path },
      recognized.staticStyle,
      schemaShape,
      undefined,
      initFnNode,
    );
  }

  // The query branch — src/emit/server/tools-rest.ts's `if (query !== undefined)` block. Tried
  // only once the plain hoists-then-return form has failed, so no shape that already recognized
  // changes meaning: the two are disjoint by construction (that reader requires exactly one
  // statement after the hoists, and this one requires at least three).
  //
  // `staticStyle` is deliberately absent from what this returns — see `QueryBlock`'s docstring
  // for why a query tool carries no evidence of the connector's `staticPathStyle` at all.
  const query = recognizeQueryBlock(arrow.body, argsResult.args, "returns-url");
  if (query === undefined) return undefined;

  const mergedArgs = mergeHoistedArgs(argsResult.args, query.hoistMeta);
  if (mergedArgs === undefined) return undefined;

  return withInitFn(
    { name, description, args: mergedArgs, path: query.path, query: query.query },
    undefined,
    schemaShape,
    query.basePrefix,
    initFnNode,
  );
}

export type RestRegistrarFields = {
  readonly registrar: string;
  readonly serviceLabel: string;
  readonly tokenEnv: string;
  readonly fetchLocal: string;
};

/**
 * The `makeRestToolRegistrar` factory const — WIRING, claimed the moment its own four-key shape
 * is recognized (see `recognizeFactory`), independent of whether any `<registrar>(...)` call
 * later recognizes. See this module's header for why that independence is deliberate.
 *
 * Two factories is not a shape the emitter writes (`renderRestKitTools` emits exactly one), so
 * the first match is taken; a module with two would leave the second one's own statement
 * unclaimed and reported by the totality rule, same as any other unmodeled statement.
 */
export function recognizeRestRegistrar(
  statements: readonly AstNode[],
  claims: ClaimSet,
): RestRegistrarFields | undefined {
  const factory = statements
    .map((statement) => recognizeFactory(statement))
    .find((f): f is Factory => f !== undefined);
  if (factory === undefined) return undefined;

  claims.claim(factory.statement, "rest-factory");
  return {
    registrar: factory.registrar,
    serviceLabel: factory.serviceLabel,
    tokenEnv: factory.tokenEnv,
    fetchLocal: factory.fetchLocal,
  };
}

/**
 * Every `<registrar>(...)` call — REGISTRATIONS, not wiring. All-or-nothing, matching
 * tools-hand.ts's `recognizeTools`: a connector with nine recognized calls and one bespoke
 * handler is not nine-tenths regenerable, it is blocked, and nothing is claimed unless every
 * call succeeds — a partial claim here WOULD risk deriving a spec missing a tool (the exact
 * "wrong-derivation" risk `recognizeRestRegistrar`'s unconditional claim does not carry, since
 * the factory alone can never produce a wrong tool).
 *
 * Zero matching calls is not refused as ambiguous the way tools-hand.ts's zero-`reg()` case is:
 * `registrar` is supplied by the caller, already positively identified by
 * `recognizeRestRegistrar`'s own four-key match — there is no "did the recognizer even run"
 * question left open here the way there is for tools-hand.ts's sole signal. A rest-kit spec
 * with `tools: []` genuinely emits just the factory and nothing else.
 */
export type RestToolsResult = {
  readonly tools: ToolFields[];
  readonly staticPathStyles: readonly (StaticPathStyle | undefined)[];
  readonly schemaShapes: readonly SchemaShape[];
  /**
   * Parallel to `tools`, and `undefined` for every tool that is not a query tool — the same
   * per-index shape `staticPathStyles` uses. The caller reads it alongside `tools[i]`, which is
   * what lets a `literal` prefix's base be taken off that tool's own path; see `BasePrefix`.
   */
  readonly basePrefixes: readonly (BasePrefix | undefined)[];
};

export function recognizeRestTools(
  statements: readonly AstNode[],
  claims: ClaimSet,
  registrar: string,
): RestToolsResult | undefined {
  const calls = statements
    .map((statement) => ({ statement, call: isRegistrarCall(statement, registrar) }))
    .filter((entry): entry is { statement: AstNode; call: AstNode } => entry.call !== undefined);

  const shapes: ToolShape[] = [];
  for (const { call } of calls) {
    const shape = recognizeOneCall(call);
    if (shape === undefined) return undefined;
    shapes.push(shape);
  }

  claims.claim(
    calls.map((entry) => entry.statement),
    "rest-tools",
  );
  return {
    tools: shapes.map((s) => s.fields),
    staticPathStyles: shapes.map((s) => s.staticStyle),
    schemaShapes: shapes.map((s) => s.schemaShape),
    basePrefixes: shapes.map((s) => s.basePrefix),
  };
}
