import type { AstNode } from "../ast.ts";
import type { ClaimSet } from "../claims.ts";
import {
  asExpression,
  assignment,
  awaited,
  bareKeyedProps,
  binary,
  blockBody,
  callArgs,
  calleeOf,
  callTo,
  computedMember,
  conditional,
  constDecl,
  expressionOf,
  functionBody,
  functionName,
  functionParams,
  functionReturnType,
  ifStatement,
  isAsyncFunction,
  isIdent,
  isNullLiteral,
  leadingCommentTexts,
  letDecl,
  logical,
  memberName,
  memberObject,
  memberOn,
  methodCallTo,
  newOf,
  numberLit,
  numericValue,
  optionalCallCallee,
  optionalMemberName,
  optionalMemberObject,
  propertySignature,
  quoteMinimalProps,
  regExpLit,
  returnArgument,
  stringLit,
  templateLiteral,
  throwArgument,
  typeAnnotationName,
  typeArguments,
  typeLiteralMembers,
  unary,
  unionTypes,
} from "../read.ts";
import { isTextStatement, isThrowGuard } from "./fetch-helper.ts";

export type EnvEntry = {
  vars: string[];
  local: string;
  bindings: string[];
  required: boolean;
  default?: string;
  transform?: "stripTrailingSlash" | "trimTrailingSlashFn";
  prefix?: string;
  suffix?: string;
  auth?: "bearer" | "basic" | "headers" | "client-credentials";
  headerNames?: string[];
  /** Split-bearer's raw-token accessor name — see matchSplitBearerReader/-Wrapper below. */
  tokenLocal?: string;
  /** The non-`Bearer` scheme word — see `matchSchemeTemplate` below. */
  authScheme?: string;
  /** The three `auth: "client-credentials"` fields — see `matchClientCredentials` below. */
  tokenUrl?: string;
  scope?: string;
  credentialsIn?: "basic" | "body";
};

/**
 * `Record<string, string>` exactly — the head name AND both type arguments.
 *
 * Every accessor this module recognizes that returns a header record returns that instantiation
 * and no other: `renderEnvAccessor`'s auth branch, `renderSplitBearer`'s wrapper, `renderBasic`,
 * and `renderClientCredentials` inside a `Promise<…>` (all in src/emit/server/env.ts). The four
 * matchers below used to pin it with `typeAnnotationName(...) === "Record"`, which reports the
 * head name only — so `Record<string, number>` and `Record<unknown, unknown>` satisfied it, and a
 * module writing either recovered IDENTICAL `EnvEntry` fields and re-emitted `Record<string,
 * string>`. Different bytes, an unchanged spec, and nothing able to see it: `diff:golden` compares
 * emitted output, the round trip emits the annotation on both legs, and the totality rule reports
 * statements nobody claimed, not statements claimed wrongly.
 *
 * Shared across all four rather than repeated at each, because the asymmetry is exactly what
 * surfaced the defect: `hasWriteHelperSignature` (server/fetch-helper.ts) had already pinned
 * `Promise`'s own argument for this reason, through the `typeArguments` accessor added for it,
 * while its sibling here still pinned by head name. A guard duplicated four times is four places
 * for the next tightening to be applied three times.
 */
function isStringRecord(node: AstNode | undefined): boolean {
  if (typeAnnotationName(node) !== "Record") return false;
  const args = typeArguments(node);
  return (
    args?.length === 2 &&
    typeAnnotationName(args[0]) === "string" &&
    typeAnnotationName(args[1]) === "string"
  );
}

/**
 * `process.env["VAR"]?.trim()` -> `VAR`.
 *
 * The `?.trim` step is a genuinely optional-chain node (OptionalCallExpression whose callee is
 * an OptionalMemberExpression), a distinct shape from the plain calls the rest of the deriver
 * reads — `optionalCallCallee`/`optionalMemberName`/`optionalMemberObject` are its guarded
 * analogues of `calleeOf`/`memberName`/`memberObject`. `process.env["VAR"]` itself is a plain,
 * deliberately COMPUTED member — the bracketed "VAR" is the point, not a hazard — so it is read
 * with `computedMember` rather than rejected the way `memberName` would reject any computed
 * member.
 */
function envVarRead(init: AstNode | undefined): string | undefined {
  const callee = optionalCallCallee(init);
  const name = optionalMemberName(callee) ?? memberName(callee);
  if (name !== "trim") return undefined;
  const member = optionalMemberObject(callee) ?? memberObject(callee);
  const computed = computedMember(member);
  if (computed === undefined) return undefined;
  return memberOn(computed.object, "process") === "env" ? computed.key : undefined;
}

type ReadLine = { var: string; binding: string; default?: string };

/**
 * One `const <binding> = process.env["<VAR>"]?.trim();` line, or its defaulted form
 * `... || "<default>"` — the two shapes `readLines` in src/emit/server/env.ts writes.
 *
 * `constDecl` carries the `kind === "const"` guard this line used to check by hand — without it,
 * `let <binding> = process.env[...]?.trim();` passed every check below and was claimed as the
 * documented `const` read line, same gap as server/index.ts's isRegistrarConst.
 */
function parseReadLine(stmt: AstNode): ReadLine | undefined {
  const decl = constDecl(stmt);
  if (decl?.init === undefined) return undefined;
  const binding = decl.name;
  const init = decl.init;

  const or = logical(init);
  if (or?.operator === "||") {
    const variable = envVarRead(or.left);
    const right = stringLit(or.right);
    if (variable === undefined || right === undefined) return undefined;
    return { var: variable, binding, default: right };
  }

  const variable = envVarRead(init);
  return variable === undefined ? undefined : { var: variable, binding };
}

/** Flatten a left-associative chain of `||` into its leaves, in source order. */
function flattenOr(node: AstNode): AstNode[] {
  const or = logical(node);
  if (or?.operator === "||") {
    return [...flattenOr(or.left), ...flattenOr(or.right)];
  }
  return [node];
}

/** `<binding> === undefined` or `<binding> === ""`, one leaf of the guard's `||` chain. */
function isBindingCompare(node: AstNode, binding: string, rhs: "undefined" | ""): boolean {
  const b = binary(node);
  if (b?.operator !== "===" || !isIdent(b.left, binding)) return false;
  return rhs === "undefined" ? isIdent(b.right, "undefined") : stringLit(b.right) === "";
}

/**
 * Verify the guard is exactly `guardLines` in src/emit/server/env.ts: for each read, in order,
 * the two-leaf pair `<binding> === undefined || <binding> === ""`, ORed across reads, throwing
 * `Error("<VAR> is not set")` (one var) or `Error("<VAR1> and <VAR2> ... must be set")` (many).
 * Anything else — a different message, a reordered condition, extra statements in the block —
 * is not this shape and must not be treated as though it were.
 */
function verifyGuard(ifStmt: AstNode | undefined, reads: readonly ReadLine[]): boolean {
  const s = ifStatement(ifStmt);
  if (s === undefined) return false;
  const leaves = flattenOr(s.test);
  if (leaves.length !== reads.length * 2) return false;
  for (let i = 0; i < reads.length; i++) {
    const binding = reads[i]!.binding;
    if (!isBindingCompare(leaves[2 * i]!, binding, "undefined")) return false;
    if (!isBindingCompare(leaves[2 * i + 1]!, binding, "")) return false;
  }

  const body = blockBody(s.consequent);
  if (body?.length !== 1) return false;
  const args = newOf(throwArgument(body[0]!), "Error", 1);
  if (args === undefined) return false;
  const msg = stringLit(args[0]);
  if (msg === undefined) return false;

  const expected =
    reads.length === 1
      ? `${reads[0]!.var} is not set`
      : `${reads.map((r) => r.var).join(" and ")} must be set`;
  return msg === expected;
}

/**
 * The value `transformed()` in src/emit/server/env.ts writes for a binding: the bare binding
 * (no transform), `<binding>.replace(/\/$/, "")` (`transform: "stripTrailingSlash"`), or
 * `trimTrailingSlash(<binding>)` (`transform: "trimTrailingSlashFn"`). Any other call or
 * expression referencing the binding is a shape this recognizer does not model.
 */
function matchTransformExpr(
  node: AstNode,
  binding: string,
): { transform?: "stripTrailingSlash" | "trimTrailingSlashFn" } | undefined {
  if (isIdent(node, binding)) return {};

  const args = callArgs(node);
  if (args === undefined) return undefined;
  const callee = calleeOf(node);

  if (isIdent(callee, "trimTrailingSlash")) {
    if (args.length === 1 && isIdent(args[0], binding)) {
      return { transform: "trimTrailingSlashFn" };
    }
    return undefined;
  }

  // `memberName`/`memberObject` carry the same computed-member guard `server/index.ts`'s
  // `isConnect` does: `binding[replace](...)` has an Identifier `property` too (the KEY
  // variable's name), which would otherwise be read as `.replace` whenever that variable was
  // named "replace".
  if (memberName(callee) === "replace" && isIdent(memberObject(callee), binding)) {
    const re = regExpLit(args[0]);
    if (
      args.length === 2 &&
      re?.pattern === String.raw`\/$` &&
      re.flags === "" &&
      stringLit(args[1]) === ""
    ) {
      return { transform: "stripTrailingSlash" };
    }
  }
  return undefined;
}

/**
 * The non-auth return shapes `returnLines`/`wrapped`/`transformed` write for a single-var
 * accessor: the (possibly transformed) binding, bare, or wrapped in a template literal when a
 * prefix or suffix is present. `prefix`/`suffix` are read from the template's cooked quasis
 * unconditionally — `wrapped()` substitutes `?? ""` for whichever of the two is unset, so an
 * empty cooked string round-trips to identical bytes whether recorded as `""` or omitted.
 */
function classifyPlainReturn(
  arg: AstNode,
  binding: string,
): Pick<EnvEntry, "transform" | "prefix" | "suffix"> | undefined {
  const direct = matchTransformExpr(arg, binding);
  if (direct !== undefined) return direct;

  const t = templateLiteral(arg);
  if (t?.expressions.length !== 1) return undefined;

  const inner = matchTransformExpr(t.expressions[0]!, binding);
  if (inner === undefined) return undefined;

  const prefix = t.quasis[0];
  const suffix = t.quasis[1];
  if (prefix === undefined || suffix === undefined) return undefined;

  return { ...inner, prefix, suffix };
}

/**
 * The Authorization template `authProps` writes — `` `<scheme> ${<value>}` `` — reporting the
 * scheme and checking the value node. Returns the scheme WITHOUT its trailing space, or
 * undefined when the node is not that shape.
 *
 * Shared between the fused reading (classifyAuthReturn) and the split one
 * (matchSplitBearerWrapper) because the emitter writes one template for both; a second copy is
 * how the two would drift, which is `src/spec.ts`'s own IDENTIFIER_RE lesson.
 */
function matchSchemeTemplate(
  node: AstNode,
  valueMatches: (expr: AstNode) => boolean,
): string | undefined {
  const t = templateLiteral(node);
  if (t?.expressions.length !== 1 || t.quasis[1] !== "") return undefined;
  const head = t.quasis[0];
  if (head === undefined || !head.endsWith(" ")) return undefined;
  const scheme = head.slice(0, -1);
  // The same allowlist EnvSchema enforces. A head this rejects is bytes no spec produces, so
  // claiming it would derive a spec that re-emits differently.
  if (!/^[A-Za-z][A-Za-z0-9-]*$/.test(scheme)) return undefined;
  return valueMatches(t.expressions[0]!) ? scheme : undefined;
}

/** `"Bearer"` is the emitter's default and is recorded as an ABSENT field, never as a value. */
function schemeField(scheme: string): Pick<EnvEntry, "authScheme"> {
  return scheme === "Bearer" ? {} : { authScheme: scheme };
}

type AuthShape =
  | ({ auth: "bearer" } & Pick<EnvEntry, "authScheme">)
  | { auth: "headers"; headerNames: string[] };

/**
 * The two auth return shapes `returnLines` writes: `auth: "bearer"`'s
 * `{ Authorization: \`Bearer ${binding}\`, Accept: "application/json" }`, and
 * `auth: "headers"`'s `{ <name>: <binding>, ..., Accept: "application/json" }` with one entry
 * per var in declaration order. Both always end with the literal `Accept: "application/json"`
 * property — anything else in that position, or a property that isn't a plain key/value pair,
 * is rejected rather than guessed at.
 */
function classifyAuthReturn(arg: AstNode, reads: readonly ReadLine[]): AuthShape | undefined {
  // The widening this comment used to disclose and accept is now closed. `objectProps` merges an
  // Identifier key and a same-named StringLiteral key into one resolved name, so
  // `{ "Authorization": …, "Accept": … }` classified the same as the bare form `returnLines`
  // actually writes — a claimed function regenerating non-identical bytes from an identical
  // `EnvEntry`, which no gate can see. `quoteMinimalProps` is the pin, NOT `bareKeyedProps`: the
  // header names here are `headerNames`, a spec field, and `returnLines` quotes one exactly when
  // `IDENTIFIER_RE` rejects it — so datadog's `"DD-API-KEY"` must arrive quoted and the trailing
  // `Accept` must not. Both mistakes are the same wrong claim, pointed opposite ways.
  const properties = quoteMinimalProps(arg);
  if (properties?.length !== reads.length + 1) return undefined;

  const last = properties.at(-1)!;
  if (last.key !== "Accept" || stringLit(last.value) !== "application/json") return undefined;

  const rest = properties.slice(0, -1);

  if (rest.length === 1 && reads.length === 1) {
    const prop = rest[0]!;
    if (prop.key === "Authorization") {
      const scheme = matchSchemeTemplate(prop.value, (expr) => isIdent(expr, reads[0]!.binding));
      if (scheme !== undefined) return { auth: "bearer", ...schemeField(scheme) };
    }
  }

  if (rest.length === reads.length) {
    const headerNames: string[] = [];
    for (let i = 0; i < rest.length; i++) {
      const prop = rest[i]!;
      if (!isIdent(prop.value, reads[i]!.binding)) return undefined;
      headerNames.push(prop.key);
    }
    return { auth: "headers", headerNames };
  }

  return undefined;
}

type ReadSection = { readonly reads: ReadLine[]; readonly rest: AstNode[] };

/**
 * The leading run of `readLines` reads, and whatever statements follow it.
 *
 * The run stops at the FIRST statement `parseReadLine` refuses rather than scanning past it: a
 * non-read statement between two reads is not a shape `readLines` writes, and skipping it would
 * splice two halves of a different function into one entry. The refused statement stays in
 * `rest`, which accepts it only as the guard or the `return` — `splitBodyTail` judges it on the
 * count, `verifyGuard` on the guard's exact shape.
 */
function collectReadLines(statements: readonly AstNode[]): ReadSection | undefined {
  const reads: ReadLine[] = [];
  let i = 0;
  while (i < statements.length) {
    const parsed = parseReadLine(statements[i]!);
    if (parsed === undefined) break;
    reads.push(parsed);
    i++;
  }
  if (reads.length === 0) return undefined;

  // A default is a per-entry property in the spec — readLines applies it to every var alike —
  // so a mix of defaulted and bare reads is not a shape this entry's spec field can produce.
  const defaults = new Set(reads.map((r) => r.default));
  if (defaults.size !== 1) return undefined;

  return { reads, rest: statements.slice(i) };
}

type BodyTail = { readonly guardNode?: AstNode; readonly returnStmt: AstNode };

/**
 * What follows the reads: exactly `[guard,] return` — a lone `return`, or one guard statement
 * then the `return`. Any other count is refused rather than having the extra statements ignored;
 * an accessor carrying a statement this recognizer does not model is not the documented shape,
 * and claiming it would drop whatever that statement does.
 */
function splitBodyTail(rest: readonly AstNode[]): BodyTail | undefined {
  const returnStmt = rest.at(-1);
  if (returnStmt?.type !== "ReturnStatement") return undefined;
  if (rest.length === 1) return { returnStmt };
  if (rest.length === 2) return { guardNode: rest[0]!, returnStmt };
  return undefined;
}

/** Everything recovered from the accessor before its `return` is classified. */
type EntryContext = {
  readonly reads: readonly ReadLine[];
  readonly vars: string[];
  readonly bindings: string[];
  readonly local: string;
  /** Whether a verified guard statement was present — the emitter's `needsGuard`. */
  readonly guarded: boolean;
  readonly defaultValue: string | undefined;
};

/** The `arg.type === "ObjectExpression"` branch of `recognizeOne` — see its docstring. */
function buildAuthEntry(arg: AstNode, ctx: EntryContext): EnvEntry | undefined {
  // needsGuard = required || auth !== undefined, so a guard is mandatory here unless a
  // default suppressed it — an auth-shaped return with neither is not producible and must
  // not be accepted as though it were.
  if (!ctx.guarded && ctx.defaultValue === undefined) return undefined;
  const authShape = classifyAuthReturn(arg, ctx.reads);
  if (authShape === undefined) return undefined;
  // `required` cannot be recovered here: needsGuard is true for any auth entry regardless of
  // the spec's `required`, so both values regenerate identical bytes. `false` is the schema
  // default and keeps the derived spec minimal.
  return {
    vars: ctx.vars,
    local: ctx.local,
    bindings: ctx.bindings,
    required: false,
    auth: authShape.auth,
    ...(authShape.auth === "headers" ? { headerNames: authShape.headerNames } : {}),
    ...(authShape.auth === "bearer" && authShape.authScheme !== undefined
      ? { authScheme: authShape.authScheme }
      : {}),
    ...(ctx.defaultValue !== undefined ? { default: ctx.defaultValue } : {}),
  };
}

/** The non-auth branch of `recognizeOne` — see its docstring. */
function buildPlainEntry(arg: AstNode, ctx: EntryContext): EnvEntry | undefined {
  // Every non-auth return uses only bindings[0] (transformed/wrapped) — a multi-var entry
  // without auth is not a shape the schema (or the emitter) can produce.
  if (ctx.reads.length !== 1) return undefined;
  const plainShape = classifyPlainReturn(arg, ctx.reads[0]!.binding);
  if (plainShape === undefined) return undefined;

  return {
    vars: ctx.vars,
    local: ctx.local,
    bindings: ctx.bindings,
    required: ctx.guarded,
    ...(ctx.defaultValue !== undefined ? { default: ctx.defaultValue } : {}),
    ...(plainShape.transform !== undefined ? { transform: plainShape.transform } : {}),
    ...(plainShape.prefix !== undefined ? { prefix: plainShape.prefix } : {}),
    ...(plainShape.suffix !== undefined ? { suffix: plainShape.suffix } : {}),
  };
}

/**
 * One env accessor, as src/emit/server/env.ts's plain-accessor branch of `renderEnvAccessor`
 * writes it. The `auth: "basic"`, `auth: "client-credentials"` and `tokenLocal` shapes are each a
 * different function shape entirely and are not modeled here — `recognizeBasicAuth`,
 * `matchClientCredentials` and `matchSplitBearerReader`/`-Wrapper` read those, and `recognizeEnv`
 * offers this function only what none of them claimed:
 *
 *   function <local>(): <string|Record<string,string>> {
 *     const <binding> = process.env["<VAR>"]?.trim() [|| "<default>"];   // once per var
 *     [if (<guard>) { throw … }]                       // present iff required || auth is set,
 *                                                       // and never together with a default
 *     return <shape>;
 *   }
 *
 * `return` is classified structurally against every shape src/emit/server/env.ts can produce
 * (see classifyPlainReturn and classifyAuthReturn). Anything the return does not exactly match
 * is left unclaimed — approximating it would silently drop the field that shape encodes, which
 * is the defect this rewrite exists to close.
 */
function recognizeOne(fn: AstNode): EnvEntry | undefined {
  // renderEnvAccessor's tail is never async.
  if (isAsyncFunction(fn)) return undefined;

  const statements = functionBody(fn);
  if (statements === undefined || statements.length === 0) return undefined;
  if (statements.at(-1)?.type !== "ReturnStatement") return undefined;

  const section = collectReadLines(statements);
  if (section === undefined) return undefined;
  const { reads, rest } = section;
  const defaultValue = reads[0]!.default;

  const tail = splitBodyTail(rest);
  if (tail === undefined) return undefined;
  const guardNode = tail.guardNode;

  // guardLines never emits a guard once a default is present, regardless of required/auth.
  if (defaultValue !== undefined && guardNode !== undefined) return undefined;
  if (guardNode !== undefined && !verifyGuard(guardNode, reads)) return undefined;

  const arg = returnArgument(tail.returnStmt);
  if (arg === undefined) return undefined;

  // renderEnvAccessor writes `(): string` for the plain branch and `(): Record<string, string>`
  // for the auth (bearer/headers) branch — the identical `arg.type === "ObjectExpression"` split
  // made just below, so the two checks must agree or this shape is not one the emitter can write.
  // `Record` goes through `isStringRecord`, not `typeAnnotationName`: the head name alone accepts
  // instantiations this branch re-emits differently. See that function.
  const returnType = functionReturnType(fn);
  const returnTypeMatches =
    arg.type === "ObjectExpression"
      ? isStringRecord(returnType)
      : typeAnnotationName(returnType) === "string";
  if (!returnTypeMatches) return undefined;

  const local = functionName(fn);
  if (local === undefined) return undefined;

  const ctx: EntryContext = {
    reads,
    vars: reads.map((r) => r.var),
    bindings: reads.map((r) => r.binding),
    local,
    guarded: guardNode !== undefined,
    defaultValue,
  };
  return arg.type === "ObjectExpression" ? buildAuthEntry(arg, ctx) : buildPlainEntry(arg, ctx);
}

/**
 * The reader half of a split-bearer pair — renderSplitBearer's first function: `readLines` +
 * `guardLines` for exactly one var, then a bare `return <binding>;`. Mirrors criterion 5 of
 * renderSplitBearer's own docstring (src/emit/server/env.ts): the field only ever carries ONE
 * var (EnvSchema's multi-var refine admits only auth "basic"/"headers"/"client-credentials",
 * none of which coexist with `tokenLocal`), and the guard is always present — `auth: "bearer"`
 * forces `guardLines`' `needsGuard` regardless of `required`, and no split-bearer entry in the
 * corpus sets a `default` (which would suppress the guard entirely).
 *
 * This shape is BYTE-IDENTICAL to a plain "required" accessor (recognizeOne's REQUIRED case in
 * the test file) — from this function alone the two are indistinguishable. What tells them
 * apart is whether a matching WRAPPER (matchSplitBearerWrapper) immediately follows, and
 * `recognizeEnv` checks that BEFORE ever offering this statement to the plain-accessor branch —
 * see its own docstring for why the ordering is load-bearing.
 */
function matchSplitBearerReader(
  fn: AstNode,
): { readonly var: string; readonly binding: string; readonly local: string } | undefined {
  // renderSplitBearer's reader half is never async and always returns exactly `string`.
  if (isAsyncFunction(fn) || typeAnnotationName(functionReturnType(fn)) !== "string") {
    return undefined;
  }

  const statements = functionBody(fn);
  if (statements === undefined || statements.length === 0) return undefined;
  if (statements.at(-1)?.type !== "ReturnStatement") return undefined;

  const section = collectReadLines(statements);
  if (section?.reads.length !== 1) return undefined;
  const read = section.reads[0]!;
  if (read.default !== undefined) return undefined;

  const tail = splitBodyTail(section.rest);
  if (tail?.guardNode === undefined) return undefined;
  if (!verifyGuard(tail.guardNode, section.reads)) return undefined;
  if (!isIdent(returnArgument(tail.returnStmt), read.binding)) return undefined;

  const local = functionName(fn);
  return local === undefined ? undefined : { var: read.var, binding: read.binding, local };
}

/**
 * The wrapper half — renderSplitBearer's second function: one statement,
 * `return { Authorization: \`Bearer ${<reader>()}\`, Accept: "application/json" };`, calling the
 * reader BY NAME with no arguments. `readerLocal` is the reader's own function name, matched here
 * rather than assumed: a wrapper calling any OTHER function is not this pair (mendeley's inline
 * `` `Bearer ${accessToken()}` `` has no wrapper at all — criterion 1 of renderSplitBearer's
 * docstring, OUT). Shape is not the only membership test: `recognizeEnv` only ever offers this
 * function the statement immediately following a matched reader, so figma/salesforce/
 * stackoverflow/vercel — whose reader and wrapper each satisfy every shape criterion above but
 * have a third accessor (`teamId`/`instanceUrl`/`teamSlug`) sitting between the two — are refused
 * on adjacency instead, correctly rather than conservatively: `renderSplitBearer` emits both
 * functions as one joined string and `renderEnvAccessors` joins `spec.env` in array order, so no
 * spec can produce a layout with a statement between them.
 */
function matchSplitBearerWrapper(
  fn: AstNode,
  readerLocal: string,
): { local: string; authScheme?: string } | undefined {
  // renderSplitBearer's wrapper half is never async and always returns `Record<string, string>`
  // — both type arguments pinned, not just the head name; see `isStringRecord`.
  if (isAsyncFunction(fn) || !isStringRecord(functionReturnType(fn))) {
    return undefined;
  }

  const statements = functionBody(fn);
  if (statements?.length !== 1) return undefined;

  const arg = returnArgument(statements[0]!);
  // Both keys hardcoded and bare — `renderSplitBearer` writes this line verbatim, so a quoted
  // spelling recovers the identical local and re-emits the bare form.
  const properties = bareKeyedProps(arg);
  if (properties?.length !== 2) return undefined;
  const [authProp, acceptProp] = properties;
  if (authProp?.key !== "Authorization") return undefined;
  if (acceptProp?.key !== "Accept") return undefined;
  if (stringLit(acceptProp.value) !== "application/json") return undefined;

  const scheme = matchSchemeTemplate(authProp.value, (expr) => {
    if (callArgs(expr)?.length !== 0) return false;
    return isIdent(calleeOf(expr), readerLocal);
  });
  if (scheme === undefined) return undefined;

  const local = functionName(fn);
  return local === undefined ? undefined : { local, ...schemeField(scheme) };
}

type BasicUser = { readonly prefix?: string; readonly suffix?: string };

/**
 * The username expression `renderBasic` passes to `encodeBasicAuthHeader`: the bare binding, or
 * `wrapped()`'s template form when a prefix/suffix decorates it (zendesk's
 * `` `${email}/token` ``) — `auth: "basic"` is the one auth mode EnvSchema still lets carry
 * `prefix`/`suffix`, since they decorate the USERNAME rather than the value the auth wrapper
 * itself replaces.
 */
function matchBasicUserExpr(node: AstNode, binding: string): BasicUser | undefined {
  if (isIdent(node, binding)) return {};
  const t = templateLiteral(node);
  if (t?.expressions.length !== 1 || !isIdent(t.expressions[0], binding)) return undefined;
  const prefix = t.quasis[0];
  const suffix = t.quasis[1];
  return prefix === undefined || suffix === undefined ? undefined : { prefix, suffix };
}

type BasicSection = { readonly reads: readonly ReadLine[]; readonly rest: readonly AstNode[] };

/**
 * The leading run of `renderBasic`'s read+guard PAIRS — one read statement immediately followed
 * by ITS OWN single-var guard (never the combined `a === "" || b === ""` form `guardLines` writes
 * for `auth: "headers"`/`"bearer"`) — and whatever follows. Stops at the first pair it cannot
 * verify, the same "stop rather than skip" rule `collectReadLines` documents: a non-pair
 * statement between two pairs is not a shape `renderBasic` writes, and skipping past it would
 * splice two halves of a different function into one entry.
 */
function collectBasicPairs(statements: readonly AstNode[]): BasicSection | undefined {
  const reads: ReadLine[] = [];
  let i = 0;
  while (i + 1 < statements.length) {
    const read = parseReadLine(statements[i]!);
    if (read === undefined) break;
    // renderBasic's readAndGuard has no defaulted form — a default suppresses the guard
    // entirely (guardLines), and renderBasic always guards every credential.
    if (read.default !== undefined) break;
    if (!verifyGuard(statements[i + 1]!, [read])) break;
    reads.push(read);
    i += 2;
  }
  return reads.length === 0 ? undefined : { reads, rest: statements.slice(i) };
}

/**
 * `auth: "basic"` — the airflow/zendesk shape `renderBasic` writes: `collectBasicPairs`' read+
 * guard pairs (EnvSchema pins this to exactly two, a username and a password) followed by one
 * `return { Authorization: encodeBasicAuthHeader(<user>, <password>), Accept:
 * "application/json" };`. Structurally distinct from every shape `recognizeOne` models — its
 * `collectReadLines` requires ALL reads before the first guard, which `renderBasic`'s interleaved
 * read/guard/read/guard never satisfies — so the two never compete for the same statement.
 */
/**
 * `renderBasic`'s returned header object — `{ Authorization: encodeBasicAuthHeader(<user>, <pass>),
 * Accept: "application/json" }` — recovering only what varies: the username's prefix/suffix.
 *
 * Split from `recognizeBasicAuth` because the two ask different questions of different nodes. That
 * function asks whether the FUNCTION has renderBasic's shape (not async, `Record<string, string>`,
 * two reads, a trailing return); this asks whether the RETURNED VALUE has it. Every guard here
 * reads the return argument and the two binding names, and nothing else — no statement list, no
 * claim, no function node — which is what makes the seam a seam rather than a cut.
 *
 * Both keys hardcoded and bare, as in `matchSplitBearerWrapper`: `renderBasic` writes this two-key
 * object verbatim, so a module writing the same two headers in the other order, or quoting a key,
 * is refused rather than normalized.
 */
function matchBasicHeaderObject(
  returnStatement: AstNode,
  userBinding: string,
  passBinding: string,
): BasicUser | undefined {
  const properties = bareKeyedProps(returnArgument(returnStatement));
  if (properties?.length !== 2) return undefined;
  const [authProp, acceptProp] = properties;
  if (authProp?.key !== "Authorization") return undefined;
  if (acceptProp?.key !== "Accept") return undefined;
  if (stringLit(acceptProp.value) !== "application/json") return undefined;

  const callArguments = callArgs(authProp.value);
  if (callArguments?.length !== 2) return undefined;
  if (!isIdent(calleeOf(authProp.value), "encodeBasicAuthHeader")) return undefined;
  if (!isIdent(callArguments[1], passBinding)) return undefined;

  return matchBasicUserExpr(callArguments[0]!, userBinding);
}

function recognizeBasicAuth(fn: AstNode): EnvEntry | undefined {
  // renderBasic is never async and always returns `Record<string, string>` — both type arguments
  // pinned, not just the head name; see `isStringRecord`.
  if (isAsyncFunction(fn) || !isStringRecord(functionReturnType(fn))) {
    return undefined;
  }

  const statements = functionBody(fn);
  if (statements === undefined || statements.length === 0) return undefined;
  if (statements.at(-1)?.type !== "ReturnStatement") return undefined;

  const section = collectBasicPairs(statements);
  if (section === undefined) return undefined;
  // "auth: basic requires exactly two vars" — src/spec.ts's EnvSchema refine.
  if (section.reads.length !== 2 || section.rest.length !== 1) return undefined;

  const local = functionName(fn);
  if (local === undefined) return undefined;

  const user = matchBasicHeaderObject(
    section.rest[0]!,
    section.reads[0]!.binding,
    section.reads[1]!.binding,
  );
  if (user === undefined) return undefined;

  return {
    vars: section.reads.map((r) => r.var),
    local,
    bindings: section.reads.map((r) => r.binding),
    // needsGuard is unconditional for auth: "basic" — renderBasic never checks it — so, like
    // buildAuthEntry's own `required: false`, the schema default is recorded rather than a
    // value the bytes cannot distinguish.
    required: false,
    auth: "basic",
    ...(user.prefix !== undefined ? { prefix: user.prefix } : {}),
    ...(user.suffix !== undefined ? { suffix: user.suffix } : {}),
  };
}

// ---------------------------------------------------------------------------
// auth: "client-credentials" — renderClientCredentials (src/emit/server/env.ts).
//
// The one emitted accessor that is FOUR module-scope statements rather than one or two:
//
//   let cachedToken: string | null = null;
//   let tokenExpiresAt = 0;
//   async function token(): Promise<string> { …the exchange… }
//   async function <local>(): Promise<Record<string, string>> { …the Bearer wrapper… }
//
// They are claimed as ONE entry, the way the split-bearer PAIR is, and for the same reason: a
// matcher that claimed any of them alone would leave the rest to the totality rule while having
// already derived a spec that regenerates all four.
//
// Only six things in those ~30 lines carry a spec field — the two reads (and the guard's own var
// names), the token URL, the `scope` line, WHERE the credentials go, and the wrapper's name.
// Everything else is a constant of this emitter, and each is pinned below rather than skipped: a
// module differing in the skew arithmetic, the cache comparison or an error message derives a
// spec that regenerates DIFFERENT bytes, and the totality rule cannot see it, because the
// statement was claimed.
//
// **Including the COMMENT.** `renderTokenFunction` writes three `//` lines above `const ttl`, and
// that is the ONLY comment any emitter in src/emit/ puts into src/server.ts — so before this
// recognizer existed, no module this deriver could claim contained one, and nothing here looked.
// A claim is a byte range, so a comment inside it is claimed along with the statements and simply
// vanishes on re-emission: `deriveSpec` returns `ok: true` for a module it provably cannot
// regenerate, which is the one thing its contract forbids. Neither `diff:golden` nor the round
// trip can see it, since both emit the comment on the way in and out.
//
// `search-filter.ts` is the precedent and this is its mirror image: there `emitSearchFilter`
// writes NO comment, so `hasLeadingComment` refusing any is the whole check. Here the emitter
// DOES write one, so the TEXT is the fact (`leadingCommentTexts`) — presence alone would accept a
// reworded comment and re-emit the original. `commentsAre` below checks both the expected comment
// and the expected ABSENCE of one on every other statement in the construct.
//
// What stays unchecked, deliberately and deriver-wide: a comment attached to a NON-statement node
// inside a claimed range (inside the fetch options object, say). The reason is structural, not
// empirical — every claim is a byte range and `leadingCommentTexts` reads statements, so any
// recognizer in this deriver drops such a comment. It is not something this construct introduces;
// what IS new here is an emitter that writes a comment at all.
//
// NO CORPUS INSTANCE IS KNOWN, and the citation that used to stand here was false: `newrelic`'s
// fetch helper does not drop a comment, because `newrelic/src/server.ts` contains no comments at
// all — nor do `datadog`, `grafana` or `sentry`, nor in fact any of the six connectors this
// deriver currently claims anything in. The SHAPE does occur in the corpus (`apple` writes three
// comments on object-literal properties, `protonmail` one), but both are `frame:no-registrar`
// connectors, so no range in either is ever claimed. Scoping this as pre-existing rests on the
// structural argument above; it never rested on an instance, and should not be written as though
// it did.
// ---------------------------------------------------------------------------

/**
 * `renderTokenFunction`'s own three comment lines, as `leadingCommentTexts` reports them — the
 * text after `//`, so each begins with the single space the emitter writes.
 */
const TTL_COMMENT: readonly string[] = [
  " Renew a little early so a token cannot expire mid-flight between this check and the",
  " request that uses it. The skew is halved for short-lived tokens, which would",
  " otherwise be treated as already expired and re-exchanged on every call.",
];

/**
 * Whether a statement's leading comments are exactly `expected` — `[]` asserting it carries none.
 * Length first, so a comment added to or removed from the block is refused rather than matched on
 * its surviving lines.
 */
function commentsAre(stmt: AstNode, expected: readonly string[]): boolean {
  const texts = leadingCommentTexts(stmt);
  if (texts?.length !== expected.length) return false;
  return texts.every((text, i) => text === expected[i]);
}

/**
 * `let cachedToken: string | null = null;` — the first of renderTokenFunction's two bindings.
 *
 * The annotation is pinned, not merely the name and the initializer: `let cachedToken: null |
 * string = null;` typechecks identically and is bytes this emitter never writes, so reading only
 * the two would claim it and re-emit `string | null` — a different file, invisible to the
 * totality rule.
 */
function isCachedTokenBinding(stmt: AstNode): boolean {
  const decl = letDecl(stmt);
  if (decl?.name !== "cachedToken" || !isNullLiteral(decl.init)) return false;
  const types = unionTypes(decl.typeAnnotation);
  if (types?.length !== 2) return false;
  return typeAnnotationName(types[0]) === "string" && typeAnnotationName(types[1]) === "null";
}

/**
 * `let tokenExpiresAt = 0;` — the second binding, deliberately UNANNOTATED. Its absence of a type
 * is as load-bearing as `cachedToken`'s presence of one: `let tokenExpiresAt: number = 0;`
 * typechecks and is a line renderTokenFunction cannot write.
 */
function isTokenExpiresAtBinding(stmt: AstNode): boolean {
  const decl = letDecl(stmt);
  if (decl?.name !== "tokenExpiresAt") return false;
  return decl.typeAnnotation === undefined && numberLit(decl.init) === 0;
}

/**
 * `if (cachedToken !== null && Date.now() < tokenExpiresAt) return cachedToken;` — the cache
 * check, whose comparison operators are the whole of the caching policy and carry no spec field.
 * The consequent is a bare `return`, not a block: the emitter writes the statement on one line
 * and Biome preserves that.
 */
function isCacheCheck(stmt: AstNode | undefined): boolean {
  const s = ifStatement(stmt);
  if (s === undefined || s.alternate !== undefined) return false;

  const and = logical(s.test);
  if (and?.operator !== "&&") return false;

  const cached = binary(and.left);
  if (cached?.operator !== "!==") return false;
  if (!isIdent(cached.left, "cachedToken") || !isNullLiteral(cached.right)) return false;

  const unexpired = binary(and.right);
  if (unexpired?.operator !== "<") return false;
  if (methodCallTo(unexpired.left, "Date", "now", 0) === undefined) return false;
  if (!isIdent(unexpired.right, "tokenExpiresAt")) return false;

  return isIdent(returnArgument(s.consequent), "cachedToken");
}

/**
 * `const body = new URLSearchParams({ grant_type: "client_credentials" });` — the key bare, which
 * is the only way `renderTokenFunction` writes it and which `IDENTIFIER_KEY_RE` accepts anyway.
 */
function isTokenBodyInit(stmt: AstNode | undefined): boolean {
  const decl = constDecl(stmt);
  if (decl?.name !== "body") return false;
  const args = newOf(decl.init, "URLSearchParams", 1);
  const props = bareKeyedProps(args?.[0]);
  if (props?.length !== 1) return false;
  const only = props[0]!;
  return only.key === "grant_type" && stringLit(only.value) === "client_credentials";
}

/** `body.set("<key>", <value>);` -> that value node, for one named key. */
function bodySetValue(stmt: AstNode | undefined, key: string): AstNode | undefined {
  const args = methodCallTo(expressionOf(stmt), "body", "set", 2);
  return args === undefined || stringLit(args[0]) !== key ? undefined : args[1];
}

/**
 * The `headers:` object of the token-exchange fetch — `renderTokenFunction`'s two `headerLines`
 * forms — reporting which one it is: `true` for the `credentialsIn: "basic"` form, which appends
 * the `encodeBasicAuthHeader(<id>, <secret>)` Authorization entry, `false` for the two-entry
 * `"body"` form. The caller holds that against the `body.set` lines, which is the OTHER half of
 * the same if/else.
 *
 * The one hardcoded literal in the deriver whose fixed spelling is MIXED: `renderTokenFunction`
 * writes `"Content-Type"` quoted and `Accept`/`Authorization` bare. `bareKeyedProps` would refuse
 * the emitter's own output here, so the pin is `quoteMinimalProps` — which for these three fixed
 * names dictates exactly that spelling, and still refuses a quoted `"Accept"`.
 */
function matchTokenHeaders(node: AstNode, id: string, secret: string): boolean | undefined {
  const props = quoteMinimalProps(node);
  if (props === undefined || props.length < 2) return undefined;
  const contentType = props[0];
  const accept = props[1];
  if (contentType === undefined || accept === undefined) return undefined;
  if (contentType.key !== "Content-Type") return undefined;
  if (stringLit(contentType.value) !== "application/x-www-form-urlencoded") return undefined;
  if (accept.key !== "Accept" || stringLit(accept.value) !== "application/json") return undefined;

  if (props.length === 2) return false;
  if (props.length !== 3) return undefined;

  const authorization = props[2]!;
  if (authorization.key !== "Authorization") return undefined;
  const args = callArgs(authorization.value);
  if (args?.length !== 2) return undefined;
  if (!isIdent(calleeOf(authorization.value), "encodeBasicAuthHeader")) return undefined;
  return isIdent(args[0], id) && isIdent(args[1], secret) ? true : undefined;
}

/**
 * `const res = await fetch("<tokenUrl>", { method: "POST", headers: {…}, body: body.toString() });`
 * — exactly these three options, in this order. `tokenUrl` is required to be a STRING LITERAL
 * because that is how `renderTokenFunction` writes it (`JSON.stringify(e.tokenUrl)`); an endpoint
 * built at runtime is one no `tokenUrl` value can regenerate.
 */
function matchTokenFetch(
  stmt: AstNode | undefined,
  id: string,
  secret: string,
): { readonly tokenUrl: string; readonly basicHeader: boolean } | undefined {
  const decl = constDecl(stmt);
  if (decl?.name !== "res") return undefined;
  const args = callTo(awaited(decl.init), "fetch", 2);
  if (args === undefined) return undefined;
  const tokenUrl = stringLit(args[0]);
  if (tokenUrl === undefined) return undefined;

  // All three option keys hardcoded and bare in `renderTokenFunction`; `tokenUrl` is the only
  // spec field in this statement, and it is the fetch's first ARGUMENT, not one of these keys.
  const options = bareKeyedProps(args[1]);
  if (options?.length !== 3) return undefined;
  const [method, headers, body] = options;
  if (method === undefined || headers === undefined || body === undefined) return undefined;
  if (method.key !== "method" || stringLit(method.value) !== "POST") return undefined;
  if (headers.key !== "headers" || body.key !== "body") return undefined;
  if (methodCallTo(body.value, "body", "toString", 0) === undefined) return undefined;

  const basicHeader = matchTokenHeaders(headers.value, id, secret);
  return basicHeader === undefined ? undefined : { tokenUrl, basicHeader };
}

/**
 * `if (!res.ok) { throw new Error(\`<serviceLabel> token exchange \${String(res.status)}:
 * \${text.slice(0, 400)}\`); }` -> the serviceLabel.
 *
 * The `if (!res.ok)` shell is `isThrowGuard`, shared with the fetch helpers rather than copied
 * (see its own docstring); everything inside the template is pinned here, including the 400-
 * character slice, which carries no spec field.
 */
function tokenExchangeLabel(stmt: AstNode | undefined): string | undefined {
  if (!isThrowGuard(stmt)) return undefined;
  const thrown = blockBody(ifStatement(stmt)?.consequent)?.[0];
  const args = newOf(throwArgument(thrown), "Error", 1);
  const t = templateLiteral(args?.[0]);
  if (t?.expressions.length !== 2) return undefined;

  const SUFFIX = " token exchange ";
  const head = t.quasis[0];
  if (!head?.endsWith(SUFFIX)) return undefined;
  if (t.quasis[1] !== ": " || t.quasis[2] !== "") return undefined;

  const status = callTo(t.expressions[0], "String", 1);
  if (status === undefined || memberOn(status[0], "res") !== "status") return undefined;
  const slice = methodCallTo(t.expressions[1], "text", "slice", 2);
  if (slice === undefined || numberLit(slice[0]) !== 0 || numberLit(slice[1]) !== 400) {
    return undefined;
  }
  return head.slice(0, -SUFFIX.length);
}

/** `parsed.<field>` — the one member expression the second half of the exchange reads. */
function isParsedField(node: AstNode | undefined, field: string): boolean {
  return memberOn(node, "parsed") === field;
}

/**
 * `const parsed = JSON.parse(text) as { access_token?: unknown; expires_in?: unknown };` — the
 * cast's two optional members pinned by name and order, because the statements below read both.
 */
function isParsedDecl(stmt: AstNode | undefined): boolean {
  const decl = constDecl(stmt);
  if (decl?.name !== "parsed") return false;
  const cast = asExpression(decl.init);
  if (cast === undefined) return false;
  const args = methodCallTo(cast.expression, "JSON", "parse", 1);
  if (args === undefined || !isIdent(args[0], "text")) return false;

  const members = typeLiteralMembers(cast.typeAnnotation);
  if (members?.length !== 2) return false;
  return ["access_token", "expires_in"].every((name, i) => {
    const member = propertySignature(members[i]);
    return (
      member?.key === name && member.optional && typeAnnotationName(member.valueType) === "unknown"
    );
  });
}

/**
 * `if (typeof parsed.access_token !== "string" || parsed.access_token === "") { throw new
 * Error("<serviceLabel> token response missing access_token"); }` — the second of the token
 * function's two throws, whose message must name the SAME service as the first. One
 * `spec.serviceLabel` writes both, so a module where they disagree is one no spec regenerates.
 */
function isMissingTokenGuard(stmt: AstNode | undefined, serviceLabel: string): boolean {
  const s = ifStatement(stmt);
  if (s === undefined || s.alternate !== undefined) return false;

  const or = logical(s.test);
  if (or?.operator !== "||") return false;
  const typeCheck = binary(or.left);
  if (typeCheck?.operator !== "!==" || stringLit(typeCheck.right) !== "string") return false;
  const typeOf = unary(typeCheck.left);
  if (typeOf?.operator !== "typeof" || !isParsedField(typeOf.argument, "access_token"))
    return false;
  const emptyCheck = binary(or.right);
  if (emptyCheck?.operator !== "===" || stringLit(emptyCheck.right) !== "") return false;
  if (!isParsedField(emptyCheck.left, "access_token")) return false;

  const body = blockBody(s.consequent);
  if (body?.length !== 1) return false;
  const args = newOf(throwArgument(body[0]!), "Error", 1);
  return stringLit(args?.[0]) === `${serviceLabel} token response missing access_token`;
}

/**
 * `const ttl = typeof parsed.expires_in === "number" && parsed.expires_in > 0 ? parsed.expires_in
 * - Math.min(60, Math.floor(parsed.expires_in / 2)) : undefined;`
 *
 * Every literal in it — the 60-second skew ceiling, the halving divisor, the `> 0` floor — is a
 * constant of this emitter with no spec field behind it, so each is pinned. This is the statement
 * the section header names: a module differing here re-emits with 60 and 2 restored.
 */
function isTtlDecl(stmt: AstNode | undefined): boolean {
  const decl = constDecl(stmt);
  if (decl?.name !== "ttl") return false;
  const c = conditional(decl.init);
  if (c === undefined) return false;

  const and = logical(c.test);
  if (and?.operator !== "&&") return false;
  const typeCheck = binary(and.left);
  if (typeCheck?.operator !== "===" || stringLit(typeCheck.right) !== "number") return false;
  const typeOf = unary(typeCheck.left);
  if (typeOf?.operator !== "typeof" || !isParsedField(typeOf.argument, "expires_in")) return false;
  const positive = binary(and.right);
  if (positive?.operator !== ">" || numberLit(positive.right) !== 0) return false;
  if (!isParsedField(positive.left, "expires_in")) return false;

  const minus = binary(c.consequent);
  if (minus?.operator !== "-" || !isParsedField(minus.left, "expires_in")) return false;
  const min = methodCallTo(minus.right, "Math", "min", 2);
  if (min === undefined || numberLit(min[0]) !== 60) return false;
  const floor = methodCallTo(min[1], "Math", "floor", 1);
  const halved = floor === undefined ? undefined : binary(floor[0]);
  if (halved?.operator !== "/" || numberLit(halved.right) !== 2) return false;
  if (!isParsedField(halved.left, "expires_in")) return false;

  return isIdent(c.alternate, "undefined");
}

/**
 * `tokenExpiresAt = ttl === undefined ? Number.POSITIVE_INFINITY : Date.now() + ttl * 1000;` —
 * the seconds-to-milliseconds factor and the unbounded-TTL sentinel are constants too.
 */
function isExpiryAssignment(stmt: AstNode | undefined): boolean {
  const a = assignment(expressionOf(stmt));
  if (a?.operator !== "=" || !isIdent(a.left, "tokenExpiresAt")) return false;
  const c = conditional(a.right);
  if (c === undefined) return false;

  const test = binary(c.test);
  if (test?.operator !== "===" || !isIdent(test.left, "ttl")) return false;
  if (!isIdent(test.right, "undefined")) return false;
  if (memberOn(c.consequent, "Number") !== "POSITIVE_INFINITY") return false;

  const sum = binary(c.alternate);
  if (sum?.operator !== "+" || methodCallTo(sum.left, "Date", "now", 0) === undefined) return false;
  const millis = binary(sum.right);
  return (
    millis?.operator === "*" && isIdent(millis.left, "ttl") && numberLit(millis.right) === 1000
  );
}

/** `cachedToken = parsed.access_token;` */
function isCacheAssignment(stmt: AstNode | undefined): boolean {
  const a = assignment(expressionOf(stmt));
  if (a?.operator !== "=" || !isIdent(a.left, "cachedToken")) return false;
  return isParsedField(a.right, "access_token");
}

/** Everything `matchTokenFunction` recovers — the spec fields, plus the serviceLabel evidence. */
type TokenExchange = {
  readonly reads: readonly ReadLine[];
  readonly tokenUrl: string;
  readonly credentialsIn: "basic" | "body";
  readonly scope: string | undefined;
  readonly defaultValue: string | undefined;
  readonly serviceLabel: string;
};

/**
 * `async function token(): Promise<string> { … }` — renderTokenFunction's whole body, walked
 * positionally so every statement is accounted for. `claims.claim` covers the function's entire
 * byte range, so a statement this walk does not reach rides along on the claim; that is the
 * defect `matchFetchHelperBody` (server/fetch-helper.ts) was rewritten to close, and this walk
 * follows it.
 *
 * The function's own name is pinned to `token` rather than recovered: `renderTokenFunction`
 * hard-codes it (which is why `token`, `cachedToken` and `tokenExpiresAt` are all in
 * `RESERVED_IDENTIFIERS`), so no spec field can vary it.
 */
/**
 * `async function token(): Promise<string>` — the declaration HEAD only, every part pinned.
 *
 * The name is pinned to `token` rather than recovered: `renderTokenFunction` hard-codes it (which
 * is why `token`, `cachedToken` and `tokenExpiresAt` are all in `RESERVED_IDENTIFIERS`), so no spec
 * field can vary it. Split from the body walk below because it reads the function NODE and never a
 * statement — it holds no cursor and cannot affect one.
 */
function matchesTokenSignature(fn: AstNode): boolean {
  if (functionName(fn) !== "token" || !isAsyncFunction(fn)) return false;
  if (functionParams(fn)?.length !== 0) return false;
  const returnType = functionReturnType(fn);
  if (typeAnnotationName(returnType) !== "Promise") return false;
  const resolved = typeArguments(returnType);
  return resolved?.length === 1 && typeAnnotationName(resolved[0]) === "string";
}

/** What `collectBodyLines` recovered, and — the part the caller needs to keep walking — how many statements it accounted for. */
type TokenBodyLines = {
  readonly scope: string | undefined;
  readonly credentialsInBody: boolean;
  readonly consumed: number;
};

/**
 * `bodyLines`' run: the `scope` line, then the two credential lines, in that order. All three are
 * optional and their ABSENCE is the fact — `scope` is omitted when the spec sets none, the
 * credential lines when `credentialsIn` is `"basic"`.
 *
 * Takes a SLICE and reports how many statements of it it accounted for, which is the same contract
 * `collectReadLines` already has in this file and the reason this split does not weaken the walk:
 * the cursor stays in `matchTokenFunction`, this function never sees it, and `consumed` can only be
 * raised by a line that positively matched. Under-reporting cannot smuggle a statement past the
 * walk either — the caller's next guard would meet a `body.set(...)` line where it requires the
 * fetch, and refuse.
 */
function collectBodyLines(
  rest: readonly AstNode[],
  id: string,
  secret: string,
): TokenBodyLines | undefined {
  let consumed = 0;
  let scope: string | undefined;
  const scopeValue = bodySetValue(rest[consumed], "scope");
  if (scopeValue !== undefined) {
    // `scope` reaches the emitted line through JSON.stringify, so a non-literal here is a shape
    // no spec value produces.
    scope = stringLit(scopeValue);
    if (scope === undefined) return undefined;
    consumed++;
  }

  const idValue = bodySetValue(rest[consumed], "client_id");
  if (idValue === undefined) return { scope, credentialsInBody: false, consumed };
  if (!isIdent(idValue, id)) return undefined;
  const secretValue = bodySetValue(rest[consumed + 1], "client_secret");
  if (secretValue === undefined || !isIdent(secretValue, secret)) return undefined;
  return { scope, credentialsInBody: true, consumed: consumed + 2 };
}

/** The HTTP exchange's three statements, plus the `serviceLabel` only its error line carries. */
type TokenResponse = {
  readonly tokenUrl: string;
  readonly serviceLabel: string;
  readonly consumed: number;
};

/**
 * `const res = await fetch(...)`, the `text` read, and the non-2xx throw whose message names the
 * service — the exchange itself, three statements with no optionality.
 *
 * `credentialsInBody` comes in as a FACT rather than being re-derived, because the check it feeds
 * cannot be made from these statements alone: the credential lines and the `Authorization` header
 * are the two arms of ONE if/else on `credentialsIn` in `renderTokenFunction`, so exactly one must
 * be present. Both, or neither, is a shape the emitter cannot write, and reading either arm alone
 * would let the other contradict it silently.
 */
function matchTokenResponse(
  rest: readonly AstNode[],
  id: string,
  secret: string,
  credentialsInBody: boolean,
): TokenResponse | undefined {
  const fetched = matchTokenFetch(rest[0], id, secret);
  if (fetched === undefined) return undefined;
  if (credentialsInBody === fetched.basicHeader) return undefined;
  if (!isTextStatement(rest[1])) return undefined;
  const serviceLabel = tokenExchangeLabel(rest[2]);
  if (serviceLabel === undefined) return undefined;
  return { tokenUrl: fetched.tokenUrl, serviceLabel, consumed: 3 };
}

/**
 * The cache-write tail: `parsed`, the missing-token guard, the two cache assignments either side of
 * the `ttl` const, and `return cachedToken;`.
 *
 * Takes the slice that must be ALL that is left and requires exactly six statements — which is
 * where "every statement is accounted for" is enforced for the back half of the walk. Six exactly:
 * not five (a body cannot end before the return) and not seven (an extra statement here is exactly
 * the class of mutation this walk exists to catch). Reports where the `ttl` const sits, because
 * that is the one statement allowed to carry a comment and the caller checks that over the whole
 * body, not over this slice.
 */
function matchCacheEpilogue(
  rest: readonly AstNode[],
  serviceLabel: string,
): { readonly ttlOffset: number } | undefined {
  if (rest.length !== 6) return undefined;
  if (!isParsedDecl(rest[0])) return undefined;
  if (!isMissingTokenGuard(rest[1], serviceLabel)) return undefined;
  if (!isCacheAssignment(rest[2])) return undefined;
  if (!isTtlDecl(rest[3])) return undefined;
  if (!isExpiryAssignment(rest[4])) return undefined;
  if (!isIdent(returnArgument(rest[5]), "cachedToken")) return undefined;
  return { ttlOffset: 3 };
}

/**
 * The comment sweep — see this section's header. Checked over the WHOLE body rather than at the
 * `ttl` statement alone: the claim covers this function's entire byte range, so a comment above ANY
 * of these statements is claimed with it and vanishes on re-emission just the same.
 *
 * `ttlIndex` is the one position `renderTokenFunction` writes a comment at. It is a position in the
 * body, not a walk cursor — this function never advances it and never reads a statement relative to
 * it.
 */
function commentsClearExcept(body: readonly AstNode[], ttlIndex: number): boolean {
  return body.every((stmt, i) => commentsAre(stmt, i === ttlIndex ? TTL_COMMENT : []));
}

function matchTokenFunction(fn: AstNode): TokenExchange | undefined {
  if (!matchesTokenSignature(fn)) return undefined;

  const body = functionBody(fn);
  // Past the end `body[idx]` is `undefined`, and every matcher this walk calls already refuses
  // that — so the bound is enforced once, by the type, instead of nine times by hand. The walk
  // itself is untouched: `idx` still advances one statement at a time and still never leaves this
  // function, which is the property `claims.claim` covering the whole byte range depends on.
  if (body === undefined || !isCacheCheck(body[0])) return undefined;
  let idx = 1;

  const section = collectReadLines(body.slice(idx));
  // EnvSchema: 'auth: "client-credentials" requires exactly two "vars"'.
  if (section?.reads.length !== 2) return undefined;
  idx += section.reads.length;
  const defaultValue = section.reads[0]!.default;

  // guardLines writes nothing once a `default` is present, whatever `required`/`auth` say; with
  // no default, `auth` alone forces the combined multi-var guard.
  if (defaultValue === undefined) {
    if (!verifyGuard(body[idx], section.reads)) return undefined;
    idx++;
  }

  if (!isTokenBodyInit(body[idx])) return undefined;
  idx++;

  const id = section.reads[0]!.binding;
  const secret = section.reads[1]!.binding;
  const bodyLines = collectBodyLines(body.slice(idx), id, secret);
  if (bodyLines === undefined) return undefined;
  const { scope, credentialsInBody } = bodyLines;
  idx += bodyLines.consumed;

  const response = matchTokenResponse(body.slice(idx), id, secret, credentialsInBody);
  if (response === undefined) return undefined;
  idx += response.consumed;

  const epilogue = matchCacheEpilogue(body.slice(idx), response.serviceLabel);
  if (epilogue === undefined) return undefined;
  if (!commentsClearExcept(body, idx + epilogue.ttlOffset)) return undefined;

  return {
    reads: section.reads,
    tokenUrl: response.tokenUrl,
    credentialsIn: credentialsInBody ? "body" : "basic",
    scope,
    defaultValue,
    serviceLabel: response.serviceLabel,
  };
}

/**
 * `async function <local>(): Promise<Record<string, string>> { return { Authorization: \`Bearer
 * ${await token()}\`, Accept: "application/json" }; }` -> that local.
 *
 * Structurally the split-bearer wrapper with an `await` in it, but NOT shared with
 * `matchSplitBearerWrapper`: that one is pinned non-async and `(): Record<string, string>` (task
 * 1), which is exactly what stops the plain-accessor pass from claiming THIS function, and
 * widening it to accept both would give that pin away.
 *
 * The return type is pinned two levels deep — `Promise`'s single argument, and that argument's own
 * two — because both levels are constants of `renderClientCredentials` and neither carries a spec
 * field. `Promise<Record<string, number>>` is the shape the outer pin alone let through.
 */
function matchClientCredentialsWrapper(fn: AstNode): string | undefined {
  if (!isAsyncFunction(fn)) return undefined;
  const returnType = functionReturnType(fn);
  if (typeAnnotationName(returnType) !== "Promise") return undefined;
  const resolved = typeArguments(returnType);
  if (resolved?.length !== 1 || !isStringRecord(resolved[0])) return undefined;
  if (functionParams(fn)?.length !== 0) return undefined;

  const statements = functionBody(fn);
  if (statements?.length !== 1) return undefined;
  // renderClientCredentials writes no comment in the wrapper — see the section header.
  if (!commentsAre(statements[0]!, [])) return undefined;
  // Both keys hardcoded and bare, as in the two synchronous header objects above.
  const properties = bareKeyedProps(returnArgument(statements[0]!));
  if (properties?.length !== 2) return undefined;
  const [authProp, acceptProp] = properties;
  if (authProp === undefined || acceptProp === undefined) return undefined;
  if (authProp.key !== "Authorization" || acceptProp.key !== "Accept") return undefined;
  if (stringLit(acceptProp.value) !== "application/json") return undefined;

  const t = templateLiteral(authProp.value);
  if (t?.expressions.length !== 1 || t.quasis[0] !== "Bearer " || t.quasis[1] !== "") {
    return undefined;
  }
  // `await token()`, not `token()`: the un-awaited form interpolates a Promise and is bytes
  // renderClientCredentials cannot write.
  if (callTo(awaited(t.expressions[0]), "token", 0) === undefined) return undefined;

  return functionName(fn);
}

/** What `matchClientCredentials` recovers: the entry, and the serviceLabel that is not one. */
type ClientCredentials = { readonly entry: EnvEntry; readonly serviceLabel: string };

/**
 * The four-statement group starting at `statements[i]`, or undefined.
 *
 * All four are required to be ADJACENT and in this order, which is not a convenience: emitted
 * accessors are joined in `spec.env` array order by `renderEnvAccessors`, and
 * `renderClientCredentials` builds these four as ONE string, so no spec can produce a layout with
 * anything between them — the same adjacency argument `matchSplitBearerWrapper` makes.
 *
 * The four `=== undefined` checks below are redundant with the loop bound `recognizeEnv` calls
 * this under (`i + 3 < statements.length`) and exist only to narrow the destructured type; they
 * are not a boundary condition any caller can reach.
 */
function matchClientCredentials(
  statements: readonly AstNode[],
  i: number,
): ClientCredentials | undefined {
  const group = statements.slice(i, i + 4);
  const [cached, expiry, tokenFn, wrapper] = group;
  if (cached === undefined || expiry === undefined) return undefined;
  if (tokenFn === undefined || wrapper === undefined) return undefined;
  if (!isCachedTokenBinding(cached) || !isTokenExpiresAtBinding(expiry)) return undefined;
  // None of the four carries a comment of its own — see the section header. The `ttl` statement
  // INSIDE the token function is the only place in this whole construct that does.
  if (!group.every((stmt) => commentsAre(stmt, []))) return undefined;

  const exchange = matchTokenFunction(tokenFn);
  if (exchange === undefined) return undefined;
  const local = matchClientCredentialsWrapper(wrapper);
  if (local === undefined) return undefined;

  return {
    entry: {
      vars: exchange.reads.map((r) => r.var),
      local,
      bindings: exchange.reads.map((r) => r.binding),
      // Unobservable, exactly as in buildAuthEntry: `needsGuard` is true for any entry carrying
      // `auth`, so both values of `required` regenerate identical bytes. The schema default keeps
      // the derived spec minimal.
      required: false,
      auth: "client-credentials",
      tokenUrl: exchange.tokenUrl,
      credentialsIn: exchange.credentialsIn,
      ...(exchange.scope === undefined ? {} : { scope: exchange.scope }),
      ...(exchange.defaultValue === undefined ? {} : { default: exchange.defaultValue }),
    },
    serviceLabel: exchange.serviceLabel,
  };
}

/**
 * Whether a statement is exactly src/emit/server/env.ts's `TRIM_TRAILING_SLASH_FN`, mirrored as
 * TEXT here rather than imported — `src/derive/` never imports from `src/emit/` (see read.ts's
 * own module header on why the boundary is deliberate). The body is
 * `s.endsWith("/") ? s.slice(0, -1) : s`, NOT `.replace(/\/$/, "")` (that is
 * `stripTrailingSlash`'s inlined shape, matched by `matchTransformExpr` above) — a matcher
 * written against the regex form would match nothing this emitter actually produces for the
 * shared helper.
 */
function matchTrimTrailingSlashFn(node: AstNode): boolean {
  if (functionName(node) !== "trimTrailingSlash") return false;
  const params = functionParams(node);
  if (params?.length !== 1 || !isIdent(params[0], "s")) return false;

  const statements = functionBody(node);
  if (statements?.length !== 1) return false;
  const c = conditional(returnArgument(statements[0]!));
  if (c === undefined) return false;

  const endsWithArgs = methodCallTo(c.test, "s", "endsWith", 1);
  if (endsWithArgs === undefined || stringLit(endsWithArgs[0]) !== "/") return false;

  const sliceArgs = methodCallTo(c.consequent, "s", "slice", 2);
  if (sliceArgs === undefined) return false;
  if (numberLit(sliceArgs[0]) !== 0 || numericValue(sliceArgs[1]) !== -1) return false;

  return isIdent(c.alternate, "s");
}

/** What `recognizeEnv` hands back: the spec entries, and the one recovered fact that is not one. */
export type RecognizedEnv = {
  readonly entries: EnvEntry[];
  /**
   * The service each recognized `auth: "client-credentials"` token function names in its own two
   * error messages. Evidence, not an `EnvEntry` field: `spec.serviceLabel` is ONE top-level field,
   * recovered from the fetch helper (`serviceLabelFrom`, server/fetch-helper.ts), and
   * `renderTokenFunction` interpolates it — so a module whose token function names a different
   * service is one no spec regenerates. `deriveSharedStyleSpec` holds these against the helper's
   * own, the same caller-side cross-check `agreesWithReadHelper` and
   * `rest-fetch-helper-name-mismatch` apply, and for the same reason: two recognizers producing
   * one fact independently is how they drift.
   */
  readonly tokenServiceLabels: string[];
};

/**
 * Group A at `statements[i]`: the split bearer reader and the wrapper that names it, as one entry.
 *
 * Shaped to match `matchClientCredentials`, which the next loop in `recognizeEnv` already calls the
 * same way — the two loops were asymmetric only because this one built its entry inline, which is
 * also what put every guard in it a level deep. Claiming stays with the caller, as it does there.
 */
function matchSplitBearerPair(statements: readonly AstNode[], i: number): EnvEntry | undefined {
  const reader = matchSplitBearerReader(statements[i]!);
  if (reader === undefined) return undefined;
  const wrapper = matchSplitBearerWrapper(statements[i + 1]!, reader.local);
  if (wrapper === undefined) return undefined;

  return {
    vars: [reader.var],
    local: wrapper.local,
    tokenLocal: reader.local,
    bindings: [reader.binding],
    required: false,
    auth: "bearer",
    ...(wrapper.authScheme !== undefined ? { authScheme: wrapper.authScheme } : {}),
  };
}

/**
 * The shared `trimTrailingSlash` helper, claimed only once an entry actually carries the transform
 * that calls it — gated on that, not on the function's name alone, so a same-named helper doing
 * something else is left unclaimed rather than silently absorbed.
 *
 * Not one of `recognizeEnv`'s three passes and not ordered against them: it reads the entries they
 * produced, never a statement they might still claim, and it is the only part of that function that
 * does not touch `consumed`, `indexed` or `tokenServiceLabels`. Split out for exactly that reason.
 */
function claimTrimTrailingSlashHelper(
  statements: readonly AstNode[],
  entries: readonly EnvEntry[],
  claims: ClaimSet,
): void {
  if (!entries.some((entry) => entry.transform === "trimTrailingSlashFn")) return;
  const helperIndex = statements.findIndex((s) => matchTrimTrailingSlashFn(s));
  if (helperIndex !== -1) claims.claim(statements[helperIndex]!, "env");
}

/**
 * Every env accessor in `statements`, in DECLARATION order — not "every group, then every plain
 * entry", which would scramble the array position `renderEnvAccessors` depends on to regenerate
 * byte-identical output (it emits `spec.env` in array order, unconditionally). A multi-statement
 * group sorts by its FIRST statement's index, since that is where its emitted text begins.
 *
 * Three sequential passes, and the ORDER of them is the point:
 *
 *   A.  the split-bearer PAIR, over the whole list;
 *   A′. the client-credentials GROUP of four, over the whole list;
 *   B.  the single-statement plain/basic accessors.
 *
 * Pass A is the fix for the hazard `matchSplitBearerReader`'s own docstring names: that shape is
 * byte-identical to a plain "required" accessor, so a walk that tried the plain branch first
 * would claim the reader alone — individually plausible, and wrong, because the wrapper right
 * after it would then be the ONLY thing standing between a wrong spec and the totality rule.
 *
 * Pass A′ is a separate pass rather than an extension of A, because the two share no structure at
 * all: A pairs two non-async functions found by shape, A′ matches a fixed four-statement run
 * beginning with two `let` bindings. It runs BEFORE B for the same reason A does — a wrapper
 * claimed as a standalone accessor is the wrong-claim class, and `matchClientCredentialsWrapper`
 * refusing the group must not leave B free to pick that function up. What actually closes that
 * today is task 1's pin: `recognizeOne` and `recognizeBasicAuth` both refuse an `async` function
 * outright, and both halves of this group are async. The ordering is defence in depth, and a
 * reader must not take it for the only thing standing there — nor the pin, which is why
 * test/derive/env.test.ts asserts all four statements stay unclaimed for every refusal.
 *
 * A and A′ cannot compete for a statement: A's two halves are non-async `(): string` /
 * `(): Record<string, string>` functions, A′'s are two `let`s and two `async` functions. Nothing
 * satisfies both, so A′ needs no `consumed` check of its own.
 *
 * The three passes stay INLINE, and that is a decision rather than an omission. They share four
 * accumulators — `consumed`, `indexed`, `tokenServiceLabels` and `claims` — and the order in which
 * they write to them is the correctness property the paragraphs above spend their length on;
 * lifting a pass out would hand three mutable accumulators across a function boundary and put the
 * ordering contract on the caller, which is the coupling `matchFetchHelperBody` was rewritten to
 * remove. This is one decision expressed at length, so it is written at length.
 */
export function recognizeEnv(statements: readonly AstNode[], claims: ClaimSet): RecognizedEnv {
  const consumed = new Set<number>();
  const indexed: { readonly index: number; readonly entry: EnvEntry }[] = [];
  const tokenServiceLabels: string[] = [];

  for (let i = 0; i < statements.length - 1; i++) {
    const entry = matchSplitBearerPair(statements, i);
    if (entry === undefined) continue;

    claims.claim([statements[i]!, statements[i + 1]!], "env");
    consumed.add(i);
    consumed.add(i + 1);
    indexed.push({ index: i, entry });
  }

  for (let i = 0; i + 3 < statements.length; i++) {
    const group = matchClientCredentials(statements, i);
    if (group === undefined) continue;

    claims.claim(statements.slice(i, i + 4), "env");
    for (let k = 0; k < 4; k++) consumed.add(i + k);
    indexed.push({ index: i, entry: group.entry });
    tokenServiceLabels.push(group.serviceLabel);
  }

  for (let i = 0; i < statements.length; i++) {
    if (consumed.has(i)) continue;
    const s = statements[i]!;
    const entry = recognizeBasicAuth(s) ?? recognizeOne(s);
    if (entry === undefined) continue;
    claims.claim(s, "env");
    indexed.push({ index: i, entry });
  }

  const entries = indexed.toSorted((a, b) => a.index - b.index).map(({ entry }) => entry);
  claimTrimTrailingSlashHelper(statements, entries, claims);
  return { entries, tokenServiceLabels };
}
