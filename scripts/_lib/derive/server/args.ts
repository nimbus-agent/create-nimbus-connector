import type { AstNode } from "../ast.ts";

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

/**
 * Unwind `z.number().int().min(1).optional()` from the outside in.
 *
 * Returns undefined on the first modifier this recognizer does not model. That is deliberate:
 * silently dropping `.email()` would derive a spec that regenerates a DIFFERENT schema and then
 * report the byte mismatch as a mystery, instead of naming the modifier as the blocker.
 */
export function recognizeArgs(node: AstNode): Record<string, ArgFields> | undefined {
  if (node.type !== "CallExpression") return undefined;
  const callee = node["callee"] as AstNode;
  if (callee.type !== "MemberExpression") return undefined;
  if ((callee["object"] as AstNode)["name"] !== "z") return undefined;
  if ((callee["property"] as AstNode)["name"] !== "object") return undefined;

  const args = node["arguments"] as AstNode[];
  if (args.length !== 1) return undefined;
  const arg = args[0] as AstNode;
  if (arg.type !== "ObjectExpression") return undefined;
  const properties = (arg["properties"] as AstNode[]) ?? [];

  const out: Record<string, ArgFields> = {};
  for (const property of properties) {
    if (property.type !== "ObjectProperty") return undefined;
    const key = property["key"] as AstNode;
    const name = typeof key["value"] === "string" ? key["value"] : String(key["name"] ?? "");
    const parsed = recognizeOne(property["value"] as AstNode);
    if (name === "" || parsed === undefined) return undefined;
    out[name] = parsed;
  }
  return out;
}

function recognizeOne(node: AstNode): ArgFields | undefined {
  const modifiers: { name: string; args: AstNode[] }[] = [];
  let current = node;

  while (current.type === "CallExpression") {
    const callee = current["callee"] as AstNode;
    if (callee.type !== "MemberExpression") return undefined;
    const property = (callee["property"] as AstNode)["name"];
    modifiers.push({ name: String(property), args: current["arguments"] as AstNode[] });
    current = callee["object"] as AstNode;
  }

  // The innermost receiver must be `z`, and the innermost call its base type.
  if (current.type !== "Identifier" || current["name"] !== "z") return undefined;
  const base = modifiers.pop();
  if (base === undefined || !BASE_TYPES.has(base.name)) return undefined;
  // `z.string` takes no arguments; a base call with args is not the plain-base shape this
  // recognizer models (e.g. a custom error-message argument would silently vanish otherwise).
  if (base.args.length !== 0) return undefined;

  const out: ArgFields = { type: base.name as ArgFields["type"] };
  for (const modifier of modifiers.reverse()) {
    if (modifier.name === "optional") {
      if (modifier.args.length !== 0) return undefined;
      out.optional = true;
    } else if (modifier.name === "int") {
      if (modifier.args.length !== 0) return undefined;
      out.int = true;
    } else if (modifier.name === "min") {
      if (modifier.args.length !== 1) return undefined;
      const value = modifier.args[0]?.["value"];
      if (typeof value !== "number") return undefined;
      out.min = value;
    } else if (modifier.name === "max") {
      if (modifier.args.length !== 1) return undefined;
      const value = modifier.args[0]?.["value"];
      if (typeof value !== "number") return undefined;
      out.max = value;
    } else {
      return undefined;
    }
  }
  return out;
}
