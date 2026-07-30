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
};

const MODES = new Set<string>(["raw", "enc", "num", "bool"]);
const PLACEHOLDER = /\$\{([a-z]+)\.([A-Za-z0-9_]+)(?:\|([a-z]+))?\}/g;

export function parsePathTemplate(tpl: string): PathSegment[] {
  const out: PathSegment[] = [];
  let last = 0;
  for (const m of tpl.matchAll(PLACEHOLDER)) {
    const [whole, ns, name, mode] = m;
    const at = m.index;
    if (at > last) out.push({ kind: "literal", text: tpl.slice(last, at) });
    if (ns === "env") {
      if (mode !== undefined) throw new Error(`env placeholder "${whole}" cannot take a mode`);
      out.push({ kind: "env", name: name! });
    } else if (ns === "arg") {
      const m2 = mode ?? "raw";
      if (!MODES.has(m2)) throw new Error(`Unknown placeholder mode "${m2}" in "${whole}"`);
      out.push({ kind: "arg", name: name!, mode: m2 as ArgMode });
    } else {
      throw new Error(`Unknown placeholder namespace "${ns}" in "${whole}"`);
    }
    last = at + whole.length;
  }
  if (last < tpl.length) out.push({ kind: "literal", text: tpl.slice(last) });

  // Validate: no unrecognized placeholders in literal segments
  for (const seg of out) {
    if (seg.kind === "literal" && seg.text.includes("${")) {
      throw new Error(
        `Malformed placeholder in path template: ${JSON.stringify(seg.text)}. ` +
          "Expected ${env.NAME} or ${arg.NAME} with an optional |raw, |enc, |num or |bool mode; " +
          "namespace and mode must be lowercase.",
      );
    }
  }

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
  const dynamic = segments.some((s) => s.kind !== "literal");
  if (!dynamic) {
    const text = segments.map((s) => (s.kind === "literal" ? s.text : "")).join("");
    return JSON.stringify(text);
  }
  const body = segments
    .map((s) => {
      if (s.kind === "literal") return s.text.replaceAll("\\", "\\\\").replaceAll("`", "\\`");
      if (s.kind === "env") return `\${${s.name}()}`;
      return `\${${argExpression(s, ctx)}}`;
    })
    .join("");
  return `\`${body}\``;
}
