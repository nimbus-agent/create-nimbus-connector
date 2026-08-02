import type { QueryParam } from "../../spec.ts";

export type QueryContext = {
  readonly param: string;
  readonly hoisted: Map<string, string>;
};

/** The expression that reads one query entry's value — the hoisted const, or the parameter. */
function valueExpr(q: QueryParam, ctx: QueryContext): string {
  return ctx.hoisted.get(q.arg) ?? `${ctx.param}.${q.arg}`;
}

/**
 * The `searchParams` statements for one tool, unindented — the caller owns indentation because
 * the rest-kit and hand-rolled callbacks nest them at different depths.
 *
 * An unconditional value is wrapped in `String(...)`; a guarded one is not. That asymmetry is
 * the corpus's, not a choice: an unconditional entry may carry a number (`limit`), while every
 * guarded entry in the six in-scope connectors is a string already, and wrapping it would emit
 * `String(parsed.after)` where the real file writes `parsed.after`.
 */
export function renderQueryLines(query: readonly QueryParam[], ctx: QueryContext): string[] {
  const lines: string[] = [];
  for (const q of query) {
    const key = JSON.stringify(q.name);
    const value = valueExpr(q, ctx);
    if (q.omitWhen === undefined) {
      lines.push(`u.searchParams.set(${key}, String(${value}));`);
      continue;
    }
    lines.push(`if (${value} !== undefined && ${value} !== "") {`);
    lines.push(`  u.searchParams.set(${key}, ${value});`);
    lines.push("}");
  }
  return lines;
}

/** Hoisted arg names this query reads, so the caller emits exactly the hoists something uses. */
export function queryArgsUsed(
  query: readonly QueryParam[],
  hoisted: Map<string, string>,
): Set<string> {
  const used = new Set<string>();
  for (const q of query) {
    if (hoisted.has(q.arg)) used.add(q.arg);
  }
  return used;
}
