import type { ToolSpec } from "../../spec.ts";

const IDENT = /^[A-Za-z_$][A-Za-z0-9_$]*$/;

/**
 * The JSON body expression for a tool, or undefined when it sends none.
 *
 * The args object IS the body by default, which is the shape the corpus uses
 * (`JSON.stringify({ issueId, status })`). Arg values are referenced directly rather
 * than interpolated into a string, so a number arg stays a number in the JSON.
 */
export function renderBodyExpr(tool: ToolSpec, param: string): string | undefined {
  if (tool.method === "GET") return undefined;

  const pairs =
    tool.body === undefined
      ? Object.keys(tool.args).map((a) => [a, a] as const)
      : Object.entries(tool.body).map(([arg, field]) => [field, arg] as const);

  if (pairs.length === 0) return undefined;

  const fields = pairs
    .map(([field, arg]) => `${IDENT.test(field) ? field : JSON.stringify(field)}: ${param}.${arg}`)
    .join(", ");
  return `JSON.stringify({ ${fields} })`;
}
