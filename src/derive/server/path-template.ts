import type { StaticPathStyle } from "../../spec.ts";
import type { AstNode } from "../ast.ts";
import {
  callArgs,
  calleeOf,
  identName,
  memberName,
  memberObject,
  stringLit,
  templateLiteral,
} from "../read.ts";

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

/** A recovered path, plus the static-path-style evidence it carries — see `recognizePath`. */
export type RecognizedPath = {
  path: string;
  /**
   * Set only when this path is UNAMBIGUOUS staticPathStyle evidence: a plain string literal
   * ("quoted") or a template literal with zero expressions — a fully static path someone chose
   * to spell with backticks ("template"). A template WITH expressions is forced to render that
   * way regardless of the spec's `staticPathStyle` (src/emit/server/path-template.ts's
   * `RenderContext.staticStyle` docstring: it "has no effect on a path with any dynamic
   * segment"), so it is not evidence of either convention and is left unset.
   */
  staticStyle?: StaticPathStyle;
};

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
): RecognizedPath | undefined {
  const lit = stringLit(node);
  if (lit !== undefined) return { path: lit, staticStyle: "quoted" };

  const t = templateLiteral(node);
  if (t === undefined) return undefined;

  let out = "";
  for (const [i, cooked] of t.quasis.entries()) {
    out += cooked;

    const expression = t.expressions[i];
    if (expression === undefined) continue;

    const placeholder = placeholderFor(expression, locals);
    if (placeholder === undefined) return undefined;
    out += placeholder;
  }
  return { path: out, ...(t.expressions.length === 0 ? { staticStyle: "template" as const } : {}) };
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
 *
 * `memberName`/`memberObject` carry the same computed-member guard this used to check by hand:
 * a computed member (`p[key]`) has an Identifier `property` too — it's the KEY variable's
 * name, not a property name. Reading it unguarded would name an arg after whatever local
 * happens to be used as the index (`${arg.key}`), an arg the connector never declared.
 * `recognizeArgs` in args.ts guards this exact hazard on object keys; this is the same guard on
 * the read side. A member whose object is not itself an Identifier (`a.b.c`, say) is likewise
 * out of this recognizer's modeled shapes, hence the extra `identName(memberObject(...))` check.
 */
function argNameFromExpr(
  expression: AstNode,
  locals: ReadonlyMap<string, PathLocal>,
): string | undefined {
  const asIdent = identName(expression);
  if (asIdent !== undefined) return locals.get(asIdent)?.arg;

  if (identName(memberObject(expression)) === undefined) return undefined;
  return memberName(expression);
}

/**
 * The call-expression placeholder forms: a mode wrapper around a bare reference
 * (`String(x)` / `encodeURIComponent(x)`), or a zero-argument call to an env accessor.
 */
function callPlaceholder(
  expression: AstNode,
  args: readonly AstNode[],
  locals: ReadonlyMap<string, PathLocal>,
): string | undefined {
  const calleeName = identName(calleeOf(expression));
  if (calleeName === undefined) return undefined;

  // A wrapper name (String/encodeURIComponent) is pinned to its mode's exact arity — one
  // argument — rather than falling through to the env-accessor branch below on a mismatch.
  // Falling through would recover `String()` as `${env.String}`, a wrong match rather than
  // the rejection a zero-argument call to that name should produce.
  const wrapperMode = WRAPPER_MODES[calleeName];
  if (wrapperMode !== undefined) {
    if (args.length !== 1) return undefined;
    const argName = argNameFromExpr(args[0]!, locals);
    return argName === undefined ? undefined : `\${arg.${argName}|${wrapperMode}}`;
  }

  if (args.length === 0) return `\${env.${calleeName}}`;
  return undefined;
}

function placeholderFor(
  expression: AstNode,
  locals: ReadonlyMap<string, PathLocal>,
): string | undefined {
  const name = identName(expression);
  if (name !== undefined) {
    const local = locals.get(name);
    if (local === undefined) return undefined;
    return local.bool ? `\${arg.${local.arg}|bool}` : `\${arg.${local.arg}}`;
  }

  if (expression.type === "MemberExpression") {
    const argName = argNameFromExpr(expression, locals);
    return argName === undefined ? undefined : `\${arg.${argName}}`;
  }

  const args = callArgs(expression);
  return args === undefined ? undefined : callPlaceholder(expression, args, locals);
}
