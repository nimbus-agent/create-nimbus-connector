import type { AstNode } from "../ast.ts";

/**
 * A hoisted local, as the caller (Task 9, reading the hoist statement itself) resolves it:
 * which spec arg it came from, and whether the hoist was the boolean form or the
 * default-value form. Both forms produce a bare identifier reference at the *use* site — the
 * two are indistinguishable from a path-template expression alone — so the mode has to be
 * carried in from where it's actually decided, `renderHoists`' choice of hoist statement:
 *
 *   const <local> = <param>.<name> === true ? "true" : "false";   // boolean  -> bool: true
 *   const <local> = <param>.<name> ?? <default>;                  // default  -> bool: false
 */
export type PathLocal = { arg: string; bool: boolean };

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
 * A bare hoisted-local Identifier recovers as `|bool}` when `locals` says it came from the
 * boolean hoist form, and as an unsuffixed raw placeholder when it says it came from the
 * default-value form — see `PathLocal`. An identifier not present in `locals` at all is not a
 * hoisted local this recognizer can name, and returns undefined rather than guessing.
 */
export function recognizePath(
  node: AstNode,
  locals: ReadonlyMap<string, PathLocal>,
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
 * placeholder) can take. Only the name is relevant here — a wrapper's mode (num/enc) is fixed
 * by the wrapper function itself, not by whether the hoist was the boolean or default form.
 */
function argNameFromExpr(
  expression: AstNode,
  locals: ReadonlyMap<string, PathLocal>,
): string | undefined {
  if (expression.type === "Identifier") {
    return locals.get(String(expression["name"]))?.arg;
  }
  if (expression.type === "MemberExpression") {
    // A computed member (`p[key]`) has an Identifier `property` too — it's the KEY variable's
    // name, not a property name. Reading it unguarded would name an arg after whatever local
    // happens to be used as the index (`${arg.key}`), an arg the connector never declared.
    // recognizeArgs in args.ts:53 already guards this exact hazard on object keys; this is the
    // same guard on the read side. Computed member reads are out of this recognizer's modeled
    // shapes, so reject rather than misname.
    if (expression["computed"] === true) return undefined;
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
  locals: ReadonlyMap<string, PathLocal>,
): string | undefined {
  if (expression.type === "Identifier") {
    const local = locals.get(String(expression["name"]));
    if (local === undefined) return undefined;
    return local.bool ? `\${arg.${local.arg}|bool}` : `\${arg.${local.arg}}`;
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
