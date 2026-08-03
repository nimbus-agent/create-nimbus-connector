import type { AstNode } from "../ast.ts";

/**
 * The inverse of src/emit/server/path-template.ts's rendering.
 *
 * `argExpression` (in the forward emitter) wraps an argument's reference according to its
 * path-DSL mode: "raw"/"bool" leave it bare, "num" wraps it in `String(...)`, and "enc" wraps
 * it in `encodeURIComponent(...)`. The bare reference is either the hoisted local (when the
 * arg was hoisted — a default value or a boolean) or `p.<name>` directly (when it was not).
 * Recovering a placeholder is reading that same shape back off: unwrap the mode's wrapper (if
 * any), then resolve the bare reference through `locals` or a direct property read.
 *
 * A bare hoisted-local Identifier always recovers as `|bool}`, never plain `|raw}` (the
 * default when a placeholder carries no mode suffix): renderHoists's boolean branch and its
 * default-value branch both produce a bare identifier, so the two are indistinguishable from
 * the emitted AST alone. `|bool}` is the shape that actually appears in the corpus's
 * bare-hoisted-local usage (newrelic's `only_open`); a raw-mode bare hoisted default is not
 * observed here, and if one exists elsewhere it would be mis-recovered as `|bool}` rather than
 * rejected — a real gap, not a defect this recognizer can close without more information than
 * the emitted source carries.
 */
export function recognizePath(
  node: AstNode,
  locals: ReadonlyMap<string, string>,
): string | undefined {
  if (node.type === "StringLiteral") {
    return typeof node["value"] === "string" ? node["value"] : undefined;
  }
  if (node.type !== "TemplateLiteral") return undefined;

  const quasis = node["quasis"] as AstNode[];
  const expressions = node["expressions"] as AstNode[];
  let out = "";

  for (const [i, quasi] of quasis.entries()) {
    const cooked = (quasi["value"] as { cooked?: unknown })["cooked"];
    if (typeof cooked !== "string") return undefined;
    out += cooked;

    const expression = expressions[i];
    if (expression === undefined) continue;

    const placeholder = placeholderFor(expression, locals);
    if (placeholder === undefined) return undefined;
    out += placeholder;
  }
  return out;
}

/** The two modes whose forward rendering wraps the bare reference in a named call. */
const WRAPPER_MODES: Readonly<Record<string, "num" | "enc">> = {
  String: "num",
  encodeURIComponent: "enc",
};

/**
 * Resolves the arg name behind a bare reference: a hoisted local via `locals`, or a direct
 * `p.<name>` property read — the two forms a mode's wrapper argument (or an unwrapped raw
 * placeholder) can take.
 */
function argNameFromExpr(
  expression: AstNode,
  locals: ReadonlyMap<string, string>,
): string | undefined {
  if (expression.type === "Identifier") {
    return locals.get(String(expression["name"]));
  }
  if (expression.type === "MemberExpression") {
    const object = expression["object"] as AstNode;
    const property = expression["property"] as AstNode;
    if (object.type === "Identifier" && property.type === "Identifier") {
      return String(property["name"]);
    }
  }
  return undefined;
}

function placeholderFor(
  expression: AstNode,
  locals: ReadonlyMap<string, string>,
): string | undefined {
  if (expression.type === "Identifier") {
    const argName = locals.get(String(expression["name"]));
    return argName === undefined ? undefined : `\${arg.${argName}|bool}`;
  }
  if (expression.type === "MemberExpression") {
    const argName = argNameFromExpr(expression, locals);
    return argName === undefined ? undefined : `\${arg.${argName}}`;
  }
  if (expression.type === "CallExpression") {
    const callee = expression["callee"] as AstNode;
    if (callee.type !== "Identifier") return undefined;
    const calleeName = String(callee["name"]);
    const args = expression["arguments"] as AstNode[];

    // A wrapper name (String/encodeURIComponent) is pinned to its mode's exact arity — one
    // argument — rather than falling through to the env-accessor branch below on a mismatch.
    // Falling through would recover `String()` as `${env.String}`, a wrong match rather than
    // the rejection a zero-argument call to that name should produce.
    const wrapperMode = WRAPPER_MODES[calleeName];
    if (wrapperMode !== undefined) {
      if (args.length !== 1) return undefined;
      const argName = argNameFromExpr(args[0] as AstNode, locals);
      return argName === undefined ? undefined : `\${arg.${argName}|${wrapperMode}}`;
    }

    if (args.length === 0) return `\${env.${calleeName}}`;
    return undefined;
  }
  return undefined;
}
