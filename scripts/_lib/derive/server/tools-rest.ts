import type { AstNode } from "../ast.ts";
import type { ClaimSet } from "../claims.ts";
import {
  arrowFn,
  binary,
  blockBody,
  boolLit,
  callArgs,
  calleeOf,
  callTo,
  conditional,
  constDecl,
  expressionOf,
  identName,
  isIdent,
  logical,
  memberName,
  memberObject,
  numericValue,
  objectProps,
  returnArgument,
  stringLit,
} from "../read.ts";
import { recognizeArgs } from "./args.ts";
import { type PathLocal, recognizePath } from "./path-template.ts";
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
  if (props === undefined || props.length !== 4) return undefined;

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

/**
 * `<anything>.<name>` -> "<name>", the same lax read tools-hand.ts's `memberArgName`
 * documents — deliberately not checking that the object identifier is the handler's own
 * parameter (renderTool's `PARAM` is `"parsed"` here, `"p"` in tools-hand.ts; path-template.ts's
 * own `argNameFromExpr` already resolves a bare member read this same way, so pinning a check
 * here that the use site doesn't make would only create a second, inconsistent notion of "the
 * param"). Duplicated rather than imported: tools-hand.ts does not export this, and the shape
 * — not the param name — is what the two files share.
 *
 * `memberName`/`memberObject` carry the same computed-member guard tools-hand.ts's copy does: a
 * computed member (`p[key]`) has an Identifier `property` too — the KEY variable's name, not a
 * property name.
 */
function memberArgName(node: AstNode | undefined): string | undefined {
  if (identName(memberObject(node)) === undefined) return undefined;
  return memberName(node);
}

/**
 * `parsed.only_open === true ? "true" : "false"` -> "only_open" — the boolean hoist form,
 * pinned to every part of renderHoists's exact shape (see tools-hand.ts's `booleanHoistArg`,
 * which this mirrors: same AST shape, different `PARAM`, which this check never looks at).
 */
function booleanHoistArg(init: AstNode): string | undefined {
  const c = conditional(init);
  if (c === undefined) return undefined;
  if (stringLit(c.consequent) !== "true" || stringLit(c.alternate) !== "false") return undefined;

  const test = binary(c.test);
  if (test === undefined || test.operator !== "===" || boolLit(test.right) !== true) {
    return undefined;
  }
  return memberArgName(test.left);
}

/** A literal `renderHoists` can write as a `??` default's right-hand side — see tools-hand.ts's `hoistDefaultLiteral`, which this mirrors verbatim. */
function hoistDefaultLiteral(node: AstNode): string | number | boolean | undefined {
  const s = stringLit(node);
  if (s !== undefined) return s;
  const n = numericValue(node);
  if (n !== undefined) return n;
  return boolLit(node);
}

/** `parsed.scope ?? "all"` -> `{ arg: "scope", default: "all" }` — see tools-hand.ts's `defaultHoistArg`, which this mirrors verbatim. */
function defaultHoistArg(
  init: AstNode,
): { arg: string; default: string | number | boolean } | undefined {
  const l = logical(init);
  if (l === undefined || l.operator !== "??") return undefined;
  const arg = memberArgName(l.left);
  if (arg === undefined) return undefined;
  const value = hoistDefaultLiteral(l.right);
  if (value === undefined) return undefined;
  return { arg, default: value };
}

/**
 * One hoisted-argument const statement — see tools-hand.ts's `hoistedLocal`, which this
 * mirrors: `renderHoists` (src/emit/server/args.ts) writes an identical shape regardless of
 * style, parameterised only by `PARAM` ("parsed" here, "p" there), which neither form reads.
 */
function hoistedLocal(
  statement: AstNode,
): { local: string; pathLocal: PathLocal; default?: string | number | boolean } | undefined {
  const decl = constDecl(statement);
  if (decl === undefined || decl.init === undefined) return undefined;
  const local = decl.name;

  const boolArg = booleanHoistArg(decl.init);
  if (boolArg !== undefined) return { local, pathLocal: { arg: boolArg, bool: true } };

  const defaultHoist = defaultHoistArg(decl.init);
  if (defaultHoist !== undefined) {
    return {
      local,
      pathLocal: { arg: defaultHoist.arg, bool: false },
      default: defaultHoist.default,
    };
  }

  return undefined;
}

/**
 * One `<registrar>(name, description, schema, pathFn)` call — arity 4 only. Arity 5 (a 5th
 * `initFn` argument) carries a non-`GET` method (see renderTool's `initArg`) and is plan 2's
 * territory: refused here, rather than read for its first four arguments only, so a connector
 * that needs it blocks visibly on a named blocker instead of deriving a `GET` the real
 * connector never had.
 *
 * `pathFn` has three in-scope forms — `() => <pathExpr>`, `(parsed) => <pathExpr>`, and
 * `(parsed) => { <hoists> return <pathExpr>; }` — modeled the same way tools-hand.ts's
 * `recognizeOne` models its block form. The query branch (a block whose body contains `const u
 * = new URL(...)`) is plan 2's too: it is not a hoist, so the loop below refuses it the same
 * way it refuses any other unrecognized non-last statement, with no special case needed.
 *
 * Refuses an `async` path fn: `src/emit/server/tools-rest.ts` never writes `async` on this arrow,
 * the same pin `read.ts`'s `isAsync` documents and `readOnlyWrapper` (server/index.ts) already
 * applies to its own arrow. Without it, `async (parsed) => <pathExpr>` read exactly like the
 * non-async form and was claimed for a shape the emitter cannot produce.
 */
function recognizeOneCall(call: AstNode): ToolFields | undefined {
  const args = callArgs(call);
  if (args === undefined || args.length !== 4) return undefined;

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

  const toolArgs = recognizeArgs(schemaNode);
  if (toolArgs === undefined) return undefined;

  const arrow = arrowFn(pathFnNode);
  if (arrow === undefined || arrow.params.length > 1 || arrow.isAsync) return undefined;

  // Forms 1/2: `() => <pathExpr>` / `(parsed) => <pathExpr>` — expression-bodied. recognizePath
  // resolves a bare `parsed.<name>` member read without checking the receiver at all (see
  // memberArgName above), so neither form needs to be told which one it is.
  if (!arrow.isBlock) {
    const path = recognizePath(arrow.body, new Map());
    return path === undefined ? undefined : { name, description, args: toolArgs, path };
  }

  // Form 3's block always takes exactly one parameter — renderTool's `needsParam` is forced
  // true whenever a hoist is emitted, so `param` is always "(parsed)" here, never "()". A
  // zero-param block is a shape this emitter cannot produce.
  if (arrow.params.length !== 1) return undefined;

  const statements = blockBody(arrow.body);
  if (statements === undefined || statements.length === 0) return undefined;

  const locals = new Map<string, PathLocal>();
  const hoistMeta = new Map<string, { local: string; default?: string | number | boolean }>();
  for (const statement of statements.slice(0, -1)) {
    const hoist = hoistedLocal(statement);
    if (hoist === undefined) return undefined;
    locals.set(hoist.local, hoist.pathLocal);
    hoistMeta.set(hoist.pathLocal.arg, { local: hoist.local, default: hoist.default });
  }

  const last = statements.at(-1)!;
  if (last.type !== "ReturnStatement") return undefined;
  const returned = returnArgument(last);
  const path = returned === undefined ? undefined : recognizePath(returned, locals);
  if (path === undefined) return undefined;

  // Gap A / Gap B, same as tools-hand.ts: renderZodSchema never encodes `local` or `default` in
  // the schema text itself, so both are only visible here, at the hoist statement.
  let mergedArgs = toolArgs;
  if (hoistMeta.size > 0) {
    mergedArgs = { ...toolArgs };
    for (const [argName, meta] of hoistMeta) {
      const arg = mergedArgs[argName];
      if (arg === undefined) return undefined;
      mergedArgs[argName] = {
        ...arg,
        ...(meta.local !== argName ? { local: meta.local } : {}),
        ...(meta.default !== undefined ? { default: meta.default } : {}),
      };
    }
  }

  return { name, description, args: mergedArgs, path };
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
export function recognizeRestTools(
  statements: readonly AstNode[],
  claims: ClaimSet,
  registrar: string,
): ToolFields[] | undefined {
  const calls = statements
    .map((statement) => ({ statement, call: isRegistrarCall(statement, registrar) }))
    .filter((entry): entry is { statement: AstNode; call: AstNode } => entry.call !== undefined);

  const tools: ToolFields[] = [];
  for (const { call } of calls) {
    const fields = recognizeOneCall(call);
    if (fields === undefined) return undefined;
    tools.push(fields);
  }

  claims.claim(
    calls.map((entry) => entry.statement),
    "rest-tools",
  );
  return tools;
}
