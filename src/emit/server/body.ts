import type { ToolSpec } from "../../spec.ts";
import { parsePathTemplate, type RenderContext } from "./path-template.ts";

const IDENT = /^[A-Za-z_$][A-Za-z0-9_$]*$/;

/** A rendered JSON body, plus which hoisted consts it consumed. */
export type BodyExpr = {
  /** `JSON.stringify({ ... })`. */
  readonly expr: string;
  /**
   * Arg names whose hoisted const this body references. The caller unions this with the
   * path's own hoist usage and emits only the union — a hoisted const with no consumer is
   * a `TS6133` in the generated package.
   */
  readonly hoistsUsed: ReadonlySet<string>;
};

/**
 * The value expression for one body field.
 *
 * Three cases, and the middle one is the whole point of this function:
 *
 * 1. **boolean** — always the raw arg. A boolean's hoist (`args.ts`, `renderHoists`) emits
 *    `const flag = p.flag === true ? "true" : "false"` — the *string* `"true"`. That is
 *    correct for a URL, where everything is text, and wrong for a JSON body, where the API
 *    is being sent `"flag": "true"` instead of `"flag": true`. Every JSON API distinguishes
 *    those, and a string where a boolean belongs is a 400 at best and a silently ignored
 *    field at worst. So the body reaches past the hoist to `p.flag`, and a boolean that
 *    appears in both the path and the body deliberately renders two different expressions —
 *    the string form in the URL, the real boolean in the body — because those are two
 *    different serialisations of one value, not a disagreement about it.
 *
 * 2. **defaulted** — the defaulted value, never the raw arg. Before this fix the body
 *    emitted `p.limit` while the path emitted the hoisted `limit`, so one call sent the
 *    default in the URL and `undefined` in the body, for the same argument. It compiled and
 *    it ran. When the hoisted const is in scope this references it; when it is not (see
 *    below) it inlines the same `?? default`, which produces the identical value.
 *
 * 3. everything else — the raw arg.
 *
 * `ctx.hoisted` means "hoisted consts in scope at this expression", not "args that get
 * hoisted". For hand-rolled the body is built inside the same handler block as the hoists,
 * so they are in scope. For rest-kit the body lives in the registrar's *second* callback —
 * `(parsed) => ({ method, body })` — while the hoists live in the first, so nothing is in
 * scope and the caller passes an empty map. Referencing a hoisted name there would emit an
 * undeclared identifier.
 */
function fieldValue(
  tool: ToolSpec,
  arg: string,
  ctx: RenderContext,
  hoistsUsed: Set<string>,
): string {
  // Present for every arg reachable here: the default body iterates tool.args, and an
  // explicit `body` mapping's keys are checked against tool.args by ToolSchema's superRefine.
  const spec = tool.args[arg]!;
  const raw = `${ctx.param}.${arg}`;
  if (spec.type === "boolean") return raw;
  if (spec.default === undefined) return raw;
  const local = ctx.hoisted.get(arg);
  if (local !== undefined) {
    hoistsUsed.add(arg);
    return local;
  }
  return `${raw} ?? ${JSON.stringify(spec.default)}`;
}

/**
 * The JSON body expression for a tool, or undefined when it sends none.
 *
 * The args object IS the body by default, which is the shape the corpus uses
 * (`JSON.stringify({ issueId, status })`). Arg values are referenced directly rather
 * than interpolated into a string, so a number arg stays a number in the JSON.
 *
 * The default excludes any arg already referenced in the path OR in "query": both values
 * are carried by the URL, so mirroring either into the body would send it twice on a PATCH,
 * or manufacture a body where none belongs on a DELETE whose only arg is its path id or its
 * one query parameter. `pathArgs` used to be the complete model of "what the URL carries" —
 * true only while the URL was exactly the path. `query` makes the URL carry more, and this
 * function's own exclusion set has to grow with it or the two defects the path exclusion
 * exists to prevent both reopen for a query arg specifically: a non-GET query tool sends the
 * arg twice, and a DELETE whose only non-path arg is a query parameter manufactures a body
 * where none belongs. An explicit `body` mapping is unaffected by either exclusion — naming
 * a path or query arg there is a deliberate author choice and is always respected verbatim.
 */
export function renderBodyExpr(tool: ToolSpec, ctx: RenderContext): BodyExpr | undefined {
  if (tool.method === "GET") return undefined;

  let pairs: ReadonlyArray<readonly [string, string]>;
  if (tool.body === undefined) {
    // Schema guarantees tool.path is present here: a non-GET tool is never a "stub" (stubs
    // are pinned to method "GET" by ToolSchema's refine), and any non-stub tool must have a
    // path.
    const urlArgs = new Set(
      parsePathTemplate(tool.path!)
        .filter((s) => s.kind === "arg")
        .map((s) => s.name),
    );
    for (const q of tool.query ?? []) urlArgs.add(q.arg);
    pairs = Object.keys(tool.args)
      .filter((a) => !urlArgs.has(a))
      .map((a) => [a, a] as const);
  } else {
    pairs = Object.entries(tool.body).map(([arg, field]) => [field, arg] as const);
  }

  if (pairs.length === 0) return undefined;

  const hoistsUsed = new Set<string>();
  const fields = pairs
    .map(([field, arg]) => {
      const key = IDENT.test(field) ? field : JSON.stringify(field);
      const value = fieldValue(tool, arg, ctx, hoistsUsed);
      // Shorthand when the API field name and the expression are the same identifier — which
      // happens exactly when a hoisted const is named after the field it fills. This is the
      // corpus's own shape (`JSON.stringify({ issueId, status })`), and `{ scope: scope }` is
      // noise a human filling in this file would delete.
      return key === value ? key : `${key}: ${value}`;
    })
    .join(", ");
  return { expr: `JSON.stringify({ ${fields} })`, hoistsUsed };
}
