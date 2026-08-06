import type { AstNode } from "../ast.ts";
import {
  callArgs,
  calleeOf,
  isIdent,
  memberName,
  memberObject,
  numericValue,
  objectProps,
  startLine,
} from "../read.ts";

export type ArgFields = {
  type: "string" | "number" | "boolean";
  optional?: true;
  int?: true;
  min?: number;
  max?: number;
  /**
   * The hoisted const name, when it differs from the arg's own key. Not recoverable from the
   * `z.object({...})` schema this file reads — `renderZodSchema` never encodes it — so it is
   * left unset here and filled in by tools-hand.ts's `recognizeOne`, which reads it off the
   * hoist statement itself (renderHoists writes `a.local ?? name`; see Gap A).
   */
  local?: string;
  /**
   * Same story as `local`: `renderZodSchema` never encodes a default value in the schema text
   * (`.optional()` is the only trace an optional-with-default arg leaves there), so this is
   * left unset here and filled in by tools-hand.ts from the `?? <default>` hoist statement
   * (Gap B).
   */
  default?: string | number | boolean;
};

const BASE_TYPES = new Set(["string", "number", "boolean"]);

/** `recognizeArgs`'s result: the args record it always produced, plus the inline/expanded
 * evidence this tool's own schema carries — see `recognizeArgs`'s docstring. */
export type ArgsResult = {
  args: Record<string, ArgFields>;
  /**
   * "inline" when the `z.object(...)` argument and its first property share a source line,
   * "expanded" when they do not, and omitted for an empty `z.object({})` — identical under
   * both conventions, so it is not evidence of either. index.ts's `voteArgsSchemaStyle`
   * consumes this across every tool; see that function's docstring for why the two labels are
   * NOT treated symmetrically.
   */
  schemaStyle?: "inline" | "expanded";
};

/**
 * Unwind `z.number().int().min(1).optional()` from the outside in.
 *
 * Returns undefined on the first modifier this recognizer does not model. That is deliberate:
 * silently dropping `.email()` would derive a spec that regenerates a DIFFERENT schema and then
 * report the byte mismatch as a mystery, instead of naming the modifier as the blocker.
 */
export function recognizeArgs(node: AstNode): ArgsResult | undefined {
  const args = callArgs(node);
  if (args?.length !== 1) return undefined;
  // A computed member (`z[object](...)`) can have an Identifier `property` too — the KEY
  // variable's name, not a property name. Unguarded, this would accept `z[object](...)` as
  // `z.object(...)` whenever the index variable happened to be named "object". Same hazard as
  // `objectProps` below guards on an object literal's OWN keys (a computed `{ [KEY]:
  // z.string() }` would otherwise derive an arg literally named "KEY", the identifier's own
  // name, rather than being refused) and server/index.ts's isConnect guards on a member call's
  // receiver. `memberName`/`memberObject` carry this guard already.
  const callee = calleeOf(node);
  if (memberName(callee) !== "object") return undefined;
  if (!isIdent(memberObject(callee), "z")) return undefined;

  const objectNode = args[0];
  const props = objectProps(objectNode);
  if (props === undefined) return undefined;

  const out: Record<string, ArgFields> = {};
  for (const property of props) {
    const parsed = recognizeOne(property.value);
    if (parsed === undefined) return undefined;
    out[property.key] = parsed;
  }

  // An empty object has no first property to compare against — "inline" and "expanded" both
  // spell it `z.object({})` (renderZodSchema's own empty-object special case), so it carries no
  // evidence either way and schemaStyle stays unset.
  const first = props[0];
  const schemaStyle: "inline" | "expanded" | undefined =
    first === undefined
      ? undefined
      : startLine(objectNode) === startLine(first.value)
        ? "inline"
        : "expanded";

  return { args: out, ...(schemaStyle === undefined ? {} : { schemaStyle }) };
}

type Modifier = { name: string; args: AstNode[] };

/**
 * Peel a `z.<base>().<mod>()...` chain outside-in into its calls — outermost first, so the base
 * call (`z.number()`) lands LAST — or undefined when any step is not a plain `.name(...)` member
 * call, or the innermost receiver is not `z`.
 */
function unwindModifiers(node: AstNode): Modifier[] | undefined {
  const modifiers: Modifier[] = [];
  let current: AstNode | undefined = node;

  while (current?.type === "CallExpression") {
    // Same computed-member hazard as recognizeArgs above: `z.number()[int]()` would otherwise
    // be read as the `.int()` modifier whenever the index variable was named "int".
    const callee = calleeOf(current);
    const property = memberName(callee);
    if (property === undefined) return undefined;
    const callArgList = callArgs(current);
    if (callArgList === undefined) return undefined;
    modifiers.push({ name: property, args: callArgList });
    current = memberObject(callee);
  }

  // The innermost receiver must be `z`.
  return isIdent(current, "z") ? modifiers : undefined;
}

/** `.optional()` / `.int()` — the two flag modifiers, both of which take no arguments. */
function applyFlagModifier(out: ArgFields, name: "optional" | "int", args: AstNode[]): boolean {
  if (args.length !== 0) return false;
  if (name === "optional") out.optional = true;
  else out.int = true;
  return true;
}

/**
 * `.min(n)` / `.max(n)` — the two single-argument bound modifiers.
 *
 * `numericValue`, not `numberLit`: ArgSchema permits a negative bound, so `.min(-5)` must
 * recognize rather than block on a sign this schema never rejects.
 */
function applyBoundModifier(out: ArgFields, name: "min" | "max", args: AstNode[]): boolean {
  if (args.length !== 1) return false;
  const value = numericValue(args[0]);
  if (value === undefined) return false;
  if (name === "min") out.min = value;
  else out.max = value;
  return true;
}

/**
 * Fold one modifier call onto the fields recognized so far, or `false` for a modifier — or an
 * argument list — this recognizer does not model, which `recognizeOne` turns into the same
 * refusal `recognizeArgs`'s docstring describes: block on it rather than drop it.
 */
function applyModifier(out: ArgFields, modifier: Modifier): boolean {
  const { name, args } = modifier;
  if (name === "optional" || name === "int") return applyFlagModifier(out, name, args);
  if (name === "min" || name === "max") return applyBoundModifier(out, name, args);
  return false;
}

function recognizeOne(node: AstNode): ArgFields | undefined {
  const modifiers = unwindModifiers(node);
  if (modifiers === undefined) return undefined;

  // The innermost call is the base type — `unwindModifiers` pushes it last.
  const base = modifiers.pop();
  if (base === undefined || !BASE_TYPES.has(base.name)) return undefined;
  // `z.string` takes no arguments; a base call with args is not the plain-base shape this
  // recognizer models (e.g. a custom error-message argument would silently vanish otherwise).
  if (base.args.length !== 0) return undefined;

  const out: ArgFields = { type: base.name as ArgFields["type"] };
  // Innermost modifier first, matching the order they were written in.
  for (const modifier of modifiers.toReversed()) {
    if (!applyModifier(out, modifier)) return undefined;
  }
  return out;
}
