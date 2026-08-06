import type { StaticPathStyle } from "../../spec.ts";

export type ArgMode = "raw" | "enc" | "num" | "bool";

export type PathSegment =
  | { kind: "literal"; text: string }
  | { kind: "env"; name: string }
  | { kind: "arg"; name: string; mode: ArgMode };

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

const MODES = new Set<string>(["raw", "enc", "num", "bool"]);
const PLACEHOLDER = /\$\{([a-z]+)\.(\w+)(?:\|([a-z]+))?\}/g;

/**
 * The two placeholder conventions a user is most likely to reach for by habit — OpenAPI's
 * `{id}` and Express's `/:id` — neither of which this generator interpolates.
 *
 * They are caught rather than passed through because passing them through is silent and
 * wrong: `"/items/{id}"` emits `vcGet("/items/{id}")`, which compiles, typechecks, passes
 * every gate, and requests a URL containing the literal characters `{id}`. Nothing fails
 * until the connector is pointed at a real API.
 *
 * The Express arm requires the colon to follow a slash. A bare `:name` would false-positive
 * on query values that legitimately contain one — sentry's fixture path carries
 * `?query=is:unresolved`, and `is:unresolved` is not a placeholder.
 */
const FOREIGN_PLACEHOLDER = /\{([A-Za-z_]\w*)\}|\/:([A-Za-z_]\w*)/;

/** One matched `${ns.name|mode}` placeholder, as the segment it denotes. */
function toPlaceholderSegment(
  whole: string,
  ns: string | undefined,
  name: string,
  mode: string | undefined,
): PathSegment {
  if (ns === "env") {
    if (mode !== undefined) throw new Error(`env placeholder "${whole}" cannot take a mode`);
    return { kind: "env", name };
  }
  if (ns !== "arg") {
    throw new Error(`Unknown placeholder namespace "${ns}" in "${whole}"`);
  }
  const m2 = mode ?? "raw";
  if (!MODES.has(m2)) throw new Error(`Unknown placeholder mode "${m2}" in "${whole}"`);
  return { kind: "arg", name, mode: m2 as ArgMode };
}

/**
 * Reject anything left in a literal segment that only *looks* like a placeholder: a `${`
 * this parser did not consume (wrong case, wrong shape), or one of the two foreign
 * conventions FOREIGN_PLACEHOLDER describes.
 */
function assertNoUnparsedPlaceholders(segments: readonly PathSegment[]): void {
  for (const seg of segments) {
    if (seg.kind !== "literal") continue;
    if (seg.text.includes("${")) {
      throw new Error(
        `Malformed placeholder in path template: ${JSON.stringify(seg.text)}. ` +
          "Expected ${env.NAME} or ${arg.NAME} with an optional |raw, |enc, |num or |bool mode; " +
          "namespace and mode must be lowercase.",
      );
    }
    const foreign = FOREIGN_PLACEHOLDER.exec(seg.text);
    if (foreign !== null) {
      throw new Error(
        `Path template uses ${foreign[0]}, which this generator does not interpolate: ` +
          `${JSON.stringify(seg.text)}. It would be emitted as a literal path segment, and ` +
          `the connector would request the characters "${foreign[0]}" instead of a value. ` +
          `Use \${arg.${foreign[1] ?? foreign[2]}|enc} instead.`,
      );
    }
  }
}

export function parsePathTemplate(tpl: string): PathSegment[] {
  const out: PathSegment[] = [];
  let last = 0;
  for (const m of tpl.matchAll(PLACEHOLDER)) {
    const [whole, ns, name, mode] = m;
    const at = m.index;
    if (at > last) out.push({ kind: "literal", text: tpl.slice(last, at) });
    out.push(toPlaceholderSegment(whole, ns, name!, mode));
    last = at + whole.length;
  }
  if (last < tpl.length) out.push({ kind: "literal", text: tpl.slice(last) });

  assertNoUnparsedPlaceholders(out);

  return out;
}

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
