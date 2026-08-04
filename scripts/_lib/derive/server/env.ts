import type { AstNode } from "../ast.ts";
import type { ClaimSet } from "../claims.ts";

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

/** `process.env["VAR"]?.trim()` -> `VAR`. */
function envVarRead(init: AstNode | undefined): string | undefined {
  if (init?.type !== "OptionalCallExpression") return undefined;
  const callee = init["callee"] as AstNode;
  if (callee.type !== "OptionalMemberExpression" && callee.type !== "MemberExpression") {
    return undefined;
  }
  if ((callee["property"] as AstNode)["name"] !== "trim") return undefined;
  const member = callee["object"] as AstNode;
  if (member.type !== "MemberExpression") return undefined;
  const object = member["object"] as AstNode;
  if (object.type !== "MemberExpression") return undefined;
  if ((object["object"] as AstNode)["name"] !== "process") return undefined;
  if ((object["property"] as AstNode)["name"] !== "env") return undefined;
  const key = member["property"] as AstNode;
  return typeof key["value"] === "string" ? key["value"] : undefined;
}

function bodyStatements(fn: AstNode): AstNode[] {
  return ((fn["body"] as AstNode | undefined)?.["body"] as AstNode[] | undefined) ?? [];
}

type ReadLine = { var: string; binding: string; default?: string };

/**
 * One `const <binding> = process.env["<VAR>"]?.trim();` line, or its defaulted form
 * `... || "<default>"` — the two shapes `readLines` in src/emit/server/env.ts writes.
 */
function parseReadLine(stmt: AstNode): ReadLine | undefined {
  if (stmt.type !== "VariableDeclaration") return undefined;
  const declarations = stmt["declarations"] as AstNode[] | undefined;
  if (declarations === undefined || declarations.length !== 1) return undefined;
  const declarator = declarations[0]!;
  const binding = (declarator["id"] as AstNode | undefined)?.["name"];
  if (typeof binding !== "string") return undefined;
  const init = declarator["init"] as AstNode | undefined;
  if (init === undefined) return undefined;

  if (init.type === "LogicalExpression" && init["operator"] === "||") {
    const variable = envVarRead(init["left"] as AstNode);
    const right = init["right"] as AstNode;
    if (variable === undefined || right.type !== "StringLiteral") return undefined;
    return { var: variable, binding, default: right["value"] as string };
  }

  const variable = envVarRead(init);
  if (variable === undefined) return undefined;
  return { var: variable, binding };
}

/** Flatten a left-associative chain of `||` into its leaves, in source order. */
function flattenOr(node: AstNode): AstNode[] {
  if (node.type === "LogicalExpression" && node["operator"] === "||") {
    return [...flattenOr(node["left"] as AstNode), ...flattenOr(node["right"] as AstNode)];
  }
  return [node];
}

/** `<binding> === undefined` or `<binding> === ""`, one leaf of the guard's `||` chain. */
function isBindingCompare(node: AstNode, binding: string, rhs: "undefined" | ""): boolean {
  if (node.type !== "BinaryExpression" || node["operator"] !== "===") return false;
  const left = node["left"] as AstNode;
  if (left.type !== "Identifier" || left["name"] !== binding) return false;
  const right = node["right"] as AstNode;
  if (rhs === "undefined") return right.type === "Identifier" && right["name"] === "undefined";
  return right.type === "StringLiteral" && right["value"] === "";
}

/**
 * Verify the guard is exactly `guardLines` in src/emit/server/env.ts: for each read, in order,
 * the two-leaf pair `<binding> === undefined || <binding> === ""`, ORed across reads, throwing
 * `Error("<VAR> is not set")` (one var) or `Error("<VAR1> and <VAR2> ... must be set")` (many).
 * Anything else — a different message, a reordered condition, extra statements in the block —
 * is not this shape and must not be treated as though it were.
 */
function verifyGuard(ifStmt: AstNode, reads: readonly ReadLine[]): boolean {
  if (ifStmt.type !== "IfStatement") return false;
  const leaves = flattenOr(ifStmt["test"] as AstNode);
  if (leaves.length !== reads.length * 2) return false;
  for (let i = 0; i < reads.length; i++) {
    const binding = reads[i]!.binding;
    if (!isBindingCompare(leaves[2 * i]!, binding, "undefined")) return false;
    if (!isBindingCompare(leaves[2 * i + 1]!, binding, "")) return false;
  }

  const consequent = ifStmt["consequent"] as AstNode | undefined;
  const body =
    consequent?.type === "BlockStatement"
      ? (consequent["body"] as AstNode[] | undefined)
      : undefined;
  if (body === undefined || body.length !== 1) return false;
  const throwStmt = body[0]!;
  if (throwStmt.type !== "ThrowStatement") return false;
  const errExpr = throwStmt["argument"] as AstNode | undefined;
  if (errExpr?.type !== "NewExpression") return false;
  const callee = errExpr["callee"] as AstNode | undefined;
  if (callee?.type !== "Identifier" || callee["name"] !== "Error") return false;
  const args = (errExpr["arguments"] as AstNode[] | undefined) ?? [];
  if (args.length !== 1) return false;
  const msg = args[0]!;
  if (msg.type !== "StringLiteral") return false;

  const expected =
    reads.length === 1
      ? `${reads[0]!.var} is not set`
      : `${reads.map((r) => r.var).join(" and ")} must be set`;
  return msg["value"] === expected;
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
  if (node.type === "Identifier" && node["name"] === binding) return {};
  if (node.type !== "CallExpression") return undefined;

  const callee = node["callee"] as AstNode;
  const args = (node["arguments"] as AstNode[] | undefined) ?? [];

  if (callee.type === "Identifier" && callee["name"] === "trimTrailingSlash") {
    if (args.length === 1 && args[0]?.type === "Identifier" && args[0]["name"] === binding) {
      return { transform: "trimTrailingSlashFn" };
    }
    return undefined;
  }

  if (callee.type === "MemberExpression") {
    const object = callee["object"] as AstNode;
    const property = callee["property"] as AstNode;
    if (
      object.type === "Identifier" &&
      object["name"] === binding &&
      property.type === "Identifier" &&
      property["name"] === "replace" &&
      args.length === 2 &&
      args[0]?.type === "RegExpLiteral" &&
      args[0]["pattern"] === "\\/$" &&
      args[0]["flags"] === "" &&
      args[1]?.type === "StringLiteral" &&
      args[1]["value"] === ""
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

  if (arg.type !== "TemplateLiteral") return undefined;
  const quasis = (arg["quasis"] as AstNode[] | undefined) ?? [];
  const expressions = (arg["expressions"] as AstNode[] | undefined) ?? [];
  if (quasis.length !== 2 || expressions.length !== 1) return undefined;

  const inner = matchTransformExpr(expressions[0]!, binding);
  if (inner === undefined) return undefined;

  const prefix = (quasis[0]!["value"] as { cooked?: string } | undefined)?.cooked;
  const suffix = (quasis[1]!["value"] as { cooked?: string } | undefined)?.cooked;
  if (typeof prefix !== "string" || typeof suffix !== "string") return undefined;

  return { ...inner, prefix, suffix };
}

/** An object-literal property key as `field()` in src/emit/server/env.ts would print it. */
function plainKeyName(key: AstNode): string | undefined {
  if (key.type === "Identifier") return key["name"] as string;
  if (key.type === "StringLiteral") return key["value"] as string;
  return undefined;
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
  if (arg.type !== "ObjectExpression") return undefined;
  const properties = (arg["properties"] as AstNode[] | undefined) ?? [];
  if (properties.length !== reads.length + 1) return undefined;
  if (properties.some((p) => p.type !== "ObjectProperty")) return undefined;

  const last = properties.at(-1)!;
  const lastKey = last["key"] as AstNode;
  const lastValue = last["value"] as AstNode;
  if (lastKey.type !== "Identifier" || lastKey["name"] !== "Accept") return undefined;
  if (lastValue.type !== "StringLiteral" || lastValue["value"] !== "application/json") {
    return undefined;
  }

  const rest = properties.slice(0, -1);

  if (rest.length === 1 && reads.length === 1) {
    const prop = rest[0]!;
    const key = prop["key"] as AstNode;
    const value = prop["value"] as AstNode;
    if (
      key.type === "Identifier" &&
      key["name"] === "Authorization" &&
      value.type === "TemplateLiteral"
    ) {
      const quasis = (value["quasis"] as AstNode[] | undefined) ?? [];
      const expressions = (value["expressions"] as AstNode[] | undefined) ?? [];
      const head = (quasis[0]?.["value"] as { cooked?: string } | undefined)?.cooked;
      const tail = (quasis[1]?.["value"] as { cooked?: string } | undefined)?.cooked;
      const expr = expressions[0];
      if (
        quasis.length === 2 &&
        expressions.length === 1 &&
        head === "Bearer " &&
        tail === "" &&
        expr?.type === "Identifier" &&
        expr["name"] === reads[0]!.binding
      ) {
        return { auth: "bearer" };
      }
    }
  }

  if (rest.length === reads.length) {
    const headerNames: string[] = [];
    for (let i = 0; i < rest.length; i++) {
      const prop = rest[i]!;
      const key = plainKeyName(prop["key"] as AstNode);
      const value = prop["value"] as AstNode;
      if (key === undefined || value.type !== "Identifier" || value["name"] !== reads[i]!.binding) {
        return undefined;
      }
      headerNames.push(key);
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
  if (fn.type !== "FunctionDeclaration") return undefined;
  const statements = bodyStatements(fn);
  if (statements.length === 0 || statements.at(-1)?.type !== "ReturnStatement") return undefined;

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

  const arg = returnStmt["argument"] as AstNode | undefined;
  if (arg === undefined) return undefined;

  const local = String(fn["id"] ? (fn["id"] as AstNode)["name"] : "");
  if (local === "") return undefined;

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
