import type { ArgMode, PathSegment, StaticPathStyle } from "../../spec.ts";

/**
 * The RENDERER half of the path-template DSL. The parser — `parsePathTemplate`, `PathSegment`
 * and `ArgMode` — lives in `src/spec.ts`, because `tool.path` is a spec field and three layers
 * need to agree on what its placeholders mean; that module's own section header has the full
 * reasoning, including why `src/derive/` may import the parser and must never import what is
 * below.
 */

export type RenderContext = {
  /** Handler parameter name, "p" for hand-rolled and "parsed" for rest-kit. */
  readonly param: string;
  /** argName -> hoisted const name, for args lifted above the return. */
  readonly hoisted: ReadonlyMap<string, string>;
  /**
   * How a fully-static path (no `${...}` placeholders) renders: a quoted string (the
   * default) or a backtick template literal. Per-connector convention — see
   * `FetchHelperSchema.staticPathStyle`. Has no effect on a path with any dynamic segment,
   * which always renders as a template literal regardless of this setting.
   */
  readonly staticStyle?: StaticPathStyle;
  /**
   * Emitted at the start of the template, before the first segment. The conditional-query
   * branch passes the fetch helper's base here so `new URL(...)` receives an absolute URL —
   * `new URL("/relative")` throws. Threading it through the one path renderer keeps the
   * template-vs-JSON-string distinction in a single place.
   */
  readonly prefix?: string;
};

function argExpression(seg: { name: string; mode: ArgMode }, ctx: RenderContext): string {
  const base = ctx.hoisted.get(seg.name) ?? `${ctx.param}.${seg.name}`;
  switch (seg.mode) {
    case "enc":
      return `encodeURIComponent(${base})`;
    case "num":
      return `String(${base})`;
    default:
      return base;
  }
}

/** Returns a TS expression: a double-quoted string, or a backticked template literal. */
export function renderPath(segments: readonly PathSegment[], ctx: RenderContext): string {
  const prefix = ctx.prefix ?? "";
  const dynamic = segments.some((s) => s.kind !== "literal");
  if (!dynamic && prefix === "") {
    const text = segments.map((s) => (s.kind === "literal" ? s.text : "")).join("");
    if (ctx.staticStyle === "template") {
      return `\`${text.replaceAll("\\", "\\\\").replaceAll("`", "\\`")}\``;
    }
    return JSON.stringify(text);
  }
  const body = segments
    .map((s) => {
      if (s.kind === "literal") return s.text.replaceAll("\\", "\\\\").replaceAll("`", "\\`");
      if (s.kind === "env") return `\${${s.name}()}`;
      return `\${${argExpression(s, ctx)}}`;
    })
    .join("");
  return `\`${prefix}${body}\``;
}
