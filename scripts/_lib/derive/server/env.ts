import type { AstNode } from "../ast.ts";
import type { ClaimSet } from "../claims.ts";

export type EnvEntry = {
  vars: string[];
  local: string;
  bindings: string[];
  required: boolean;
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

/**
 * One env accessor, as src/emit/server/env.ts writes it:
 *
 *   function <local>(): string {
 *     const <binding> = process.env["<VAR>"]?.trim();
 *     [if (<binding> === undefined || <binding> === "") { throw … }]   // only when required
 *     return <binding>;
 *   }
 *
 * The guard's presence IS `required`, and the binding identifier IS `bindings[0]` — the emitter
 * writes `e.bindings?.[i] ?? camel(e.vars[i])`, so a spec that omitted the binding would emit a
 * camelCased name instead of whatever is on the page. Recovering the identifier verbatim is what
 * makes the round trip byte-exact rather than merely equivalent.
 */
function recognizeOne(fn: AstNode): EnvEntry | undefined {
  if (fn.type !== "FunctionDeclaration") return undefined;
  const statements = bodyStatements(fn);
  const first = statements[0];
  if (first?.type !== "VariableDeclaration") return undefined;

  const declarator = (first["declarations"] as AstNode[])[0];
  const binding = (declarator?.["id"] as AstNode | undefined)?.["name"];
  const variable = envVarRead(declarator?.["init"] as AstNode | undefined);
  if (typeof binding !== "string" || variable === undefined) return undefined;

  // Exactly two shapes are modelled: read + return, and read + guard + return. Anything else
  // is left unclaimed rather than approximated — a multi-var accessor lands here, and lands in
  // the histogram as function:<name>, which is the honest answer.
  const guarded = statements.length === 3 && statements[1]?.type === "IfStatement";
  const plain = statements.length === 2;
  if (!guarded && !plain) return undefined;
  if (statements.at(-1)?.type !== "ReturnStatement") return undefined;

  return { vars: [variable], local: String(fn["id"] ? (fn["id"] as AstNode)["name"] : ""), bindings: [binding], required: guarded };
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
