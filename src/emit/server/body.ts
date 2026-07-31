import type { ToolSpec } from "../../spec.ts";
import { parsePathTemplate } from "./path-template.ts";

const IDENT = /^[A-Za-z_$][A-Za-z0-9_$]*$/;

/**
 * The JSON body expression for a tool, or undefined when it sends none.
 *
 * The args object IS the body by default, which is the shape the corpus uses
 * (`JSON.stringify({ issueId, status })`). Arg values are referenced directly rather
 * than interpolated into a string, so a number arg stays a number in the JSON.
 *
 * The default excludes any arg already referenced in the path: that value is carried by
 * the URL, so mirroring it into the body would send it twice on a PATCH, or manufacture a
 * body where none belongs on a DELETE whose only arg is its path id. An explicit `body`
 * mapping is unaffected by this — naming a path arg there is a deliberate author choice
 * and is always respected verbatim.
 */
export function renderBodyExpr(tool: ToolSpec, param: string): string | undefined {
  if (tool.method === "GET") return undefined;

  let pairs: ReadonlyArray<readonly [string, string]>;
  if (tool.body === undefined) {
    // Schema guarantees tool.path is present here: a non-GET tool is never a "stub" (stubs
    // are pinned to method "GET" by ToolSchema's refine), and any non-stub tool must have a
    // path.
    const pathArgs = new Set(
      parsePathTemplate(tool.path!)
        .filter((s) => s.kind === "arg")
        .map((s) => s.name),
    );
    pairs = Object.keys(tool.args)
      .filter((a) => !pathArgs.has(a))
      .map((a) => [a, a] as const);
  } else {
    pairs = Object.entries(tool.body).map(([arg, field]) => [field, arg] as const);
  }

  if (pairs.length === 0) return undefined;

  const fields = pairs
    .map(([field, arg]) => `${IDENT.test(field) ? field : JSON.stringify(field)}: ${param}.${arg}`)
    .join(", ");
  return `JSON.stringify({ ${fields} })`;
}
