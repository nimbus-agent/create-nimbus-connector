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
import { mergeHoistedArgs, recognizeHoistedBlock } from "./hoists.ts";
import { recognizePath } from "./path-template.ts";
import { type BasePrefix, recognizeQueryBlock } from "./query.ts";
import type { ToolFields } from "./tools-hand.ts";

/**
 * The inverse of src/emit/server/tools-rest.ts's `renderRestKitTools` — recovers the
 * `makeRestToolRegistrar` factory's fields (`recognizeRestRegistrar`) and every
 * `<registrar>(...)` call's declared spec fields (`recognizeRestTools`), as two SEPARATE exports
 * rather than one. `ToolFields` is the same type tools-hand.ts's recognizer produces (no
 * `method`: every call this recognizer accepts is arity 4, and arity 4 is always a GET — see
 * `recognizeOneCall`).
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
};

/**
 * `<registrar>(name, description, schema, pathFn)`'s four arguments, with the two string-literal
 * ones already read — arity 4 only, for the reason `recognizeOneCall` documents.
 *
 * The four per-element `undefined` checks are `noUncheckedIndexedAccess` bookkeeping, not a
 * second arity test: the length check above them already fixed the count at four.
 */
function registrarCallParts(call: AstNode): RegistrarCallParts | undefined {
  const args = callArgs(call);
  if (args?.length !== 4) return undefined;

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

  const name = stringLit(nameNode);
  const description = stringLit(descriptionNode);
  if (name === undefined || description === undefined) return undefined;

  return { name, description, schemaNode, pathFnNode };
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
 * One `<registrar>(name, description, schema, pathFn)` call — arity 4 only. Arity 5 (a 5th
 * `initFn` argument) carries a non-`GET` method (see renderTool's `initArg`) and is plan 2's
 * territory: refused here, rather than read for its first four arguments only, so a connector
 * that needs it blocks visibly on a named blocker instead of deriving a `GET` the real
 * connector never had.
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
 */
function recognizeOneCall(call: AstNode): ToolShape | undefined {
  const parts = registrarCallParts(call);
  if (parts === undefined) return undefined;
  const { name, description, schemaNode, pathFnNode } = parts;

  const argsResult = recognizeArgs(schemaNode);
  if (argsResult === undefined) return undefined;
  const schemaShape = {
    propertyCount: Object.keys(argsResult.args).length,
    oneLine: argsResult.schemaStyle === "inline",
  };

  const arrow = arrowFn(pathFnNode);
  if (arrow === undefined || arrow.params.length > 1 || arrow.isAsync) return undefined;

  // Forms 1/2: `() => <pathExpr>` / `(parsed) => <pathExpr>` — expression-bodied. recognizePath
  // resolves a bare `parsed.<name>` member read without checking the receiver at all (see
  // hoists.ts's memberArgName), so neither form needs to be told which one it is.
  if (!arrow.isBlock) {
    const recognized = recognizePath(arrow.body, new Map());
    if (recognized === undefined) return undefined;
    return {
      fields: { name, description, args: argsResult.args, path: recognized.path },
      staticStyle: recognized.staticStyle,
      schemaShape,
    };
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

    return {
      fields: { name, description, args: mergedArgs, path: recognized.path },
      staticStyle: recognized.staticStyle,
      schemaShape,
    };
  }

  // The query branch — src/emit/server/tools-rest.ts's `if (query !== undefined)` block. Tried
  // only once the plain hoists-then-return form has failed, so no shape that already recognized
  // changes meaning: the two are disjoint by construction (that reader requires exactly one
  // statement after the hoists, and this one requires at least three).
  //
  // `staticStyle` is deliberately absent from what this returns — see `QueryBlock`'s docstring
  // for why a query tool carries no evidence of the connector's `staticPathStyle` at all.
  const query = recognizeQueryBlock(arrow.body, argsResult.args);
  if (query === undefined) return undefined;

  const mergedArgs = mergeHoistedArgs(argsResult.args, query.hoistMeta);
  if (mergedArgs === undefined) return undefined;

  return {
    fields: { name, description, args: mergedArgs, path: query.path, query: query.query },
    schemaShape,
    basePrefix: query.basePrefix,
  };
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
