import type { AstNode } from "../ast.ts";
import type { ClaimSet } from "../claims.ts";
import {
  binary,
  blockBody,
  callArgs,
  calleeOf,
  computedMember,
  constDecl,
  functionBody,
  functionName,
  ifStatement,
  isIdent,
  logical,
  memberName,
  memberObject,
  memberOn,
  newOf,
  objectProps,
  optionalCallCallee,
  optionalMemberName,
  optionalMemberObject,
  regExpLit,
  returnArgument,
  stringLit,
  templateLiteral,
  throwArgument,
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
  auth?: "bearer" | "headers";
  headerNames?: string[];
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
  if (decl === undefined || decl.init === undefined) return undefined;
  const binding = decl.name;
  const init = decl.init;

  const or = logical(init);
  if (or !== undefined && or.operator === "||") {
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
  if (or !== undefined && or.operator === "||") {
    return [...flattenOr(or.left), ...flattenOr(or.right)];
  }
  return [node];
}

/** `<binding> === undefined` or `<binding> === ""`, one leaf of the guard's `||` chain. */
function isBindingCompare(node: AstNode, binding: string, rhs: "undefined" | ""): boolean {
  const b = binary(node);
  if (b === undefined || b.operator !== "===" || !isIdent(b.left, binding)) return false;
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
  if (body === undefined || body.length !== 1) return false;
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
      re?.pattern === "\\/$" &&
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
  if (t === undefined || t.expressions.length !== 1) return undefined;

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
  if (properties === undefined || properties.length !== reads.length + 1) return undefined;

  const last = properties.at(-1)!;
  if (last.key !== "Accept" || stringLit(last.value) !== "application/json") return undefined;

  const rest = properties.slice(0, -1);

  if (rest.length === 1 && reads.length === 1) {
    const prop = rest[0]!;
    const t = templateLiteral(prop.value);
    if (
      prop.key === "Authorization" &&
      t !== undefined &&
      t.expressions.length === 1 &&
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
  const statements = functionBody(fn);
  if (statements === undefined || statements.length === 0) return undefined;
  if (statements.at(-1)?.type !== "ReturnStatement") return undefined;

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
  const defaultValue = reads[0]!.default;

  const rest = statements.slice(i);
  let guardNode: AstNode | undefined;
  let returnStmt: AstNode;
  if (rest.length === 2) {
    guardNode = rest[0]!;
    returnStmt = rest[1]!;
  } else if (rest.length === 1) {
    returnStmt = rest[0]!;
  } else {
    return undefined;
  }
  if (returnStmt.type !== "ReturnStatement") return undefined;

  // guardLines never emits a guard once a default is present, regardless of required/auth.
  if (defaultValue !== undefined && guardNode !== undefined) return undefined;
  if (guardNode !== undefined && !verifyGuard(guardNode, reads)) return undefined;

  const arg = returnArgument(returnStmt);
  if (arg === undefined) return undefined;

  const local = functionName(fn);
  if (local === undefined) return undefined;

  const vars = reads.map((r) => r.var);
  const bindings = reads.map((r) => r.binding);

  if (arg.type === "ObjectExpression") {
    // needsGuard = required || auth !== undefined, so a guard is mandatory here unless a
    // default suppressed it — an auth-shaped return with neither is not producible and must
    // not be accepted as though it were.
    if (guardNode === undefined && defaultValue === undefined) return undefined;
    const authShape = classifyAuthReturn(arg, reads);
    if (authShape === undefined) return undefined;
    // `required` cannot be recovered here: needsGuard is true for any auth entry regardless of
    // the spec's `required`, so both values regenerate identical bytes. `false` is the schema
    // default and keeps the derived spec minimal.
    return {
      vars,
      local,
      bindings,
      required: false,
      auth: authShape.auth,
      ...(authShape.auth === "headers" ? { headerNames: authShape.headerNames } : {}),
      ...(defaultValue !== undefined ? { default: defaultValue } : {}),
    };
  }

  // Every non-auth return uses only bindings[0] (transformed/wrapped) — a multi-var entry
  // without auth is not a shape the schema (or the emitter) can produce.
  if (reads.length !== 1) return undefined;
  const plainShape = classifyPlainReturn(arg, reads[0]!.binding);
  if (plainShape === undefined) return undefined;

  return {
    vars,
    local,
    bindings,
    required: guardNode !== undefined,
    ...(defaultValue !== undefined ? { default: defaultValue } : {}),
    ...(plainShape.transform !== undefined ? { transform: plainShape.transform } : {}),
    ...(plainShape.prefix !== undefined ? { prefix: plainShape.prefix } : {}),
    ...(plainShape.suffix !== undefined ? { suffix: plainShape.suffix } : {}),
  };
}

export function recognizeEnv(statements: readonly AstNode[], claims: ClaimSet): EnvEntry[] {
  const entries: EnvEntry[] = [];
  for (const s of statements) {
    const entry = recognizeOne(s);
    if (entry === undefined) continue;
    claims.claim(s, "env");
    entries.push(entry);
  }
  return entries;
}
