import type { ArgSpec, QueryParam } from "../../spec.ts";

export type QueryContext = {
  readonly param: string;
  readonly hoisted: ReadonlyMap<string, string>;
  /** Declared args of the tool the query belongs to — the source of each value's JS type. */
  readonly args: Readonly<Record<string, ArgSpec>>;
};

/** The expression that reads one query entry's value — the hoisted const, or the parameter. */
function valueExpr(q: QueryParam, ctx: QueryContext): string {
  return ctx.hoisted.get(q.arg) ?? `${ctx.param}.${q.arg}`;
}

/**
 * Whether a value expression must be wrapped in `String(...)` before it reaches
 * `searchParams.set`, which only accepts a string.
 *
 * Driven by the argument's declared type, not by whether the entry is guarded — tabulated
 * across every guarded `searchParams.set` in the six in-scope connectors: `github` and
 * `github-actions` wrap their numeric `page` (`String(parsed.page)`) even though it is
 * guarded, while every guarded *string* arg (circleci's `pageToken`, github-actions's
 * `branch`/`event`/`status`, discord/google-meet/google-photos's `after`/`pageToken`/
 * `filter`) is written bare. Guardedness never enters the decision — only the declared type
 * does, matching every entry in the corpus, unconditional or not.
 */
function wrapsInString(type: ArgSpec["type"]): boolean {
  return type !== "string";
}

/** The guard predicate `omitWhen` selects, as a boolean expression testing `value`. */
function guardExpr(value: string, omitWhen: "absent" | "empty"): string {
  return omitWhen === "empty"
    ? `${value} !== undefined && ${value} !== ""`
    : `${value} !== undefined`;
}

/**
 * The `searchParams` statements for one tool, unindented — the caller owns indentation because
 * the rest-kit and hand-rolled callbacks nest them at different depths.
 */
export function renderQueryLines(query: readonly QueryParam[], ctx: QueryContext): string[] {
  const lines: string[] = [];
  for (const q of query) {
    const key = JSON.stringify(q.name);
    const value = valueExpr(q, ctx);
    // Present for every arg reachable here: ToolSchema's superRefine rejects any "query"
    // entry naming an arg t.args does not declare as its own key (see the Object.hasOwn
    // check there), before this ever runs.
    const type = ctx.args[q.arg]!.type;
    const rendered = wrapsInString(type) ? `String(${value})` : value;
    if (q.omitWhen === undefined) {
      lines.push(`u.searchParams.set(${key}, ${rendered});`);
      continue;
    }
    lines.push(`if (${guardExpr(value, q.omitWhen)}) {`);
    lines.push(`  u.searchParams.set(${key}, ${rendered});`);
    lines.push("}");
  }
  return lines;
}

/** Hoisted arg names this query reads, so the caller emits exactly the hoists something uses. */
export function queryArgsUsed(
  query: readonly QueryParam[],
  hoisted: ReadonlyMap<string, string>,
): Set<string> {
  const used = new Set<string>();
  for (const q of query) {
    if (hoisted.has(q.arg)) used.add(q.arg);
  }
  return used;
}
