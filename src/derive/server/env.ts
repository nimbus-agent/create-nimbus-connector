import type { AstNode } from "../ast.ts";
import type { ClaimSet } from "../claims.ts";
import {
  binary,
  blockBody,
  callArgs,
  calleeOf,
  computedMember,
  conditional,
  constDecl,
  functionBody,
  functionName,
  functionParams,
  functionReturnType,
  ifStatement,
  isAsyncFunction,
  isIdent,
  logical,
  memberName,
  memberObject,
  memberOn,
  methodCallTo,
  newOf,
  numberLit,
  numericValue,
  objectProps,
  optionalCallCallee,
  optionalMemberName,
  optionalMemberObject,
  regExpLit,
  returnArgument,
  stringLit,
  templateLiteral,
  throwArgument,
  typeAnnotationName,
} from "../read.ts";

export type EnvEntry = {
  vars: string[];
  local: string;
  bindings: string[];
  required: boolean;
  default?: string;
  transform?: "stripTrailingSlash" | "trimTrailingSlashFn";
  prefix?: string;
  suffix?: string;
  auth?: "bearer" | "basic" | "headers";
  headerNames?: string[];
  /** Split-bearer's raw-token accessor name — see matchSplitBearerReader/-Wrapper below. */
  tokenLocal?: string;
};

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
function verifyGuard(ifStmt: AstNode, reads: readonly ReadLine[]): boolean {
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

type AuthShape = { auth: "bearer" } | { auth: "headers"; headerNames: string[] };

/**
 * The two auth return shapes `returnLines` writes: `auth: "bearer"`'s
 * `{ Authorization: \`Bearer ${binding}\`, Accept: "application/json" }`, and
 * `auth: "headers"`'s `{ <name>: <binding>, ..., Accept: "application/json" }` with one entry
 * per var in declaration order. Both always end with the literal `Accept: "application/json"`
 * property — anything else in that position, or a property that isn't a plain key/value pair,
 * is rejected rather than guessed at.
 */
function classifyAuthReturn(arg: AstNode, reads: readonly ReadLine[]): AuthShape | undefined {
  // Undisclosed-until-review widening (see task-2-report.md's fix report): `objectProps` merges
  // an Identifier key and a same-named StringLiteral key into the one resolved name via
  // `identName ?? stringLit`, so `{ "Authorization": …, "Accept": … }` — string-literal keys —
  // now classifies the same as the bare `{ Authorization: …, Accept: … }` form `returnLines`
  // actually writes. The pre-retrofit code required an Identifier specifically at both
  // positions and would have refused the string-literal form. This is the same merge the task
  // 2 brief explicitly sanctioned at server/index.ts's getMcpServerInfo (its Step 5, item 4);
  // it is bounded to a byte mismatch (a claimed function whose `auth` return is a form the
  // emitter never writes regenerates non-identical bytes, not a wrong `EnvEntry`) rather than a
  // silent behavioural success, so it is accepted rather than special-cased back out.
  const properties = objectProps(arg);
  if (properties?.length !== reads.length + 1) return undefined;

  const last = properties.at(-1)!;
  if (last.key !== "Accept" || stringLit(last.value) !== "application/json") return undefined;

  const rest = properties.slice(0, -1);

  if (rest.length === 1 && reads.length === 1) {
    const prop = rest[0]!;
    const t = templateLiteral(prop.value);
    if (
      prop.key === "Authorization" &&
      t?.expressions.length === 1 &&
      t.quasis[0] === "Bearer " &&
      t.quasis[1] === "" &&
      isIdent(t.expressions[0], reads[0]!.binding)
    ) {
      return { auth: "bearer" };
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
 * writes it (the `auth: "basic"`, `auth: "client-credentials"` and `tokenLocal` shapes are
 * each a different function shape entirely and are not modeled here — they are left unclaimed):
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
  const expectedReturnType = arg.type === "ObjectExpression" ? "Record" : "string";
  if (typeAnnotationName(functionReturnType(fn)) !== expectedReturnType) return undefined;

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
  if (section === undefined || section.reads.length !== 1) return undefined;
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
function matchSplitBearerWrapper(fn: AstNode, readerLocal: string): string | undefined {
  // renderSplitBearer's wrapper half is never async and always returns `Record<string, string>`.
  if (isAsyncFunction(fn) || typeAnnotationName(functionReturnType(fn)) !== "Record") {
    return undefined;
  }

  const statements = functionBody(fn);
  if (statements?.length !== 1) return undefined;

  const arg = returnArgument(statements[0]!);
  const properties = objectProps(arg);
  if (properties?.length !== 2) return undefined;
  const [authProp, acceptProp] = properties;
  if (authProp === undefined || authProp.key !== "Authorization") return undefined;
  if (acceptProp === undefined || acceptProp.key !== "Accept") return undefined;
  if (stringLit(acceptProp.value) !== "application/json") return undefined;

  const t = templateLiteral(authProp.value);
  if (t?.expressions.length !== 1 || t.quasis[0] !== "Bearer " || t.quasis[1] !== "") {
    return undefined;
  }
  const call = t.expressions[0]!;
  if (callArgs(call)?.length !== 0) return undefined;
  if (!isIdent(calleeOf(call), readerLocal)) return undefined;

  return functionName(fn);
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
function recognizeBasicAuth(fn: AstNode): EnvEntry | undefined {
  // renderBasic is never async and always returns `Record<string, string>`.
  if (isAsyncFunction(fn) || typeAnnotationName(functionReturnType(fn)) !== "Record") {
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

  const arg = returnArgument(section.rest[0]!);
  const properties = objectProps(arg);
  if (properties?.length !== 2) return undefined;
  const [authProp, acceptProp] = properties;
  if (authProp === undefined || authProp.key !== "Authorization") return undefined;
  if (acceptProp === undefined || acceptProp.key !== "Accept") return undefined;
  if (stringLit(acceptProp.value) !== "application/json") return undefined;

  const callArguments = callArgs(authProp.value);
  if (callArguments?.length !== 2) return undefined;
  if (!isIdent(calleeOf(authProp.value), "encodeBasicAuthHeader")) return undefined;

  const user = matchBasicUserExpr(callArguments[0]!, section.reads[0]!.binding);
  if (user === undefined) return undefined;
  if (!isIdent(callArguments[1], section.reads[1]!.binding)) return undefined;

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

/**
 * Every env accessor in `statements`, in DECLARATION order — not "every pair, then every plain
 * entry", which would scramble the array position `renderEnvAccessors` depends on to regenerate
 * byte-identical output (it emits `spec.env` in array order, unconditionally).
 *
 * The split-bearer pair is detected in a pass over the WHOLE list, BEFORE the single-statement
 * loop below ever reaches the inner reader. This ordering is the fix for the hazard
 * `matchSplitBearerReader`'s own docstring names: that shape is byte-identical to a plain
 * "required" accessor, so a walk that tried the plain branch first would claim the reader alone
 * — individually plausible, and wrong, because the wrapper right after it would then be the ONLY
 * thing standing between a wrong spec and the totality rule. Detecting the pair first and
 * claiming both statements in one `claims.claim()` call (rather than teaching the plain branch
 * to recognize and skip a shape it does not otherwise handle) keeps that decision in one place.
 */
export function recognizeEnv(statements: readonly AstNode[], claims: ClaimSet): EnvEntry[] {
  const consumed = new Set<number>();
  const indexed: { readonly index: number; readonly entry: EnvEntry }[] = [];

  for (let i = 0; i < statements.length - 1; i++) {
    const reader = matchSplitBearerReader(statements[i]!);
    if (reader === undefined) continue;
    const wrapperLocal = matchSplitBearerWrapper(statements[i + 1]!, reader.local);
    if (wrapperLocal === undefined) continue;

    claims.claim([statements[i]!, statements[i + 1]!], "env");
    consumed.add(i);
    consumed.add(i + 1);
    indexed.push({
      index: i,
      entry: {
        vars: [reader.var],
        local: wrapperLocal,
        tokenLocal: reader.local,
        bindings: [reader.binding],
        required: false,
        auth: "bearer",
      },
    });
  }

  for (let i = 0; i < statements.length; i++) {
    if (consumed.has(i)) continue;
    const s = statements[i]!;
    const entry = recognizeBasicAuth(s) ?? recognizeOne(s);
    if (entry === undefined) continue;
    claims.claim(s, "env");
    indexed.push({ index: i, entry });
  }

  // The shared trimTrailingSlash helper is claimed only once an entry actually carries the
  // transform that calls it — gated on that, not on the function's name alone, so a same-named
  // helper doing something else is left unclaimed rather than silently absorbed.
  if (indexed.some(({ entry }) => entry.transform === "trimTrailingSlashFn")) {
    const helperIndex = statements.findIndex((s) => matchTrimTrailingSlashFn(s));
    if (helperIndex !== -1) claims.claim(statements[helperIndex]!, "env");
  }

  return indexed.sort((a, b) => a.index - b.index).map(({ entry }) => entry);
}
