import type { z } from "zod";
import type { ArgSchema } from "../../spec.ts";

type Arg = z.infer<typeof ArgSchema>;
type Args = Record<string, Arg>;

function isHoisted(a: Arg): boolean {
  return a.default !== undefined || a.type === "boolean";
}

export function hoistedLocals(args: Args): Map<string, string> {
  const out = new Map<string, string>();
  for (const [name, a] of Object.entries(args)) {
    if (isHoisted(a)) out.set(name, a.local ?? name);
  }
  return out;
}

function renderOne(a: Arg): string {
  let s = `z.${a.type}()`;
  if (a.type === "number" && a.int) s += ".int()";
  if (a.min !== undefined) s += `.min(${a.min})`;
  if (a.max !== undefined) s += `.max(${a.max})`;
  if (a.optional) s += ".optional()";
  return s;
}

/** One `name: z.…()` entry per declared arg, in declaration order, unwrapped and unjoined. */
export function renderZodFieldList(args: Args): string[] {
  return Object.entries(args).map(([name, a]) => `${name}: ${renderOne(a)}`);
}

/** The comma-joined field list of a zod object, with no wrapper. Always one line. */
export function renderZodFields(args: Args): string {
  return renderZodFieldList(args).join(", ");
}

/**
 * The zod object schema for a tool's args.
 *
 * `style` is the connector's `argsSchemaStyle` — Biome preserves whichever shape it is
 * handed, so this is an emitter decision, not a formatter one. The emitted "expanded" form
 * is deliberately indented as if at column 0: generate() returns unformatted source and
 * formatAll() reindents it into whatever nesting the call site puts it in.
 */
export function renderZodSchema(args: Args, style: "inline" | "expanded" = "inline"): string {
  const entries = Object.entries(args);
  // An empty object has no fields to break onto their own lines, and every corpus
  // connector — in both conventions — spells it `z.object({})`.
  if (entries.length === 0) return "z.object({})";
  if (style === "inline") return `z.object({ ${renderZodFields(args)} })`;
  return ["z.object({", ...renderZodFieldList(args).map((f) => `  ${f},`), "})"].join("\n");
}

/**
 * The hoist lines for `keep`, in declaration order.
 *
 * `keep` is required rather than defaulted, and it is the *consumers'* set, not
 * `hoistedLocals`'s: a hoisted const the emitted handler never reads is a `TS6133` and a
 * biome `noUnusedVariables` error in the generated package, which its own tsconfig
 * (`noUnusedLocals`) and biome.json both treat as failures. Reachable from a plain POST
 * with one boolean arg — the boolean is hoisted for path rendering, the body reaches past
 * the hoist to the raw arg (see body.ts), and if the path does not mention it, nothing
 * reads the const. Callers pass the union of the path's and the body's usage.
 */
export function renderHoists(args: Args, param: string, keep: ReadonlySet<string>): string[] {
  const lines: string[] = [];
  for (const [name, a] of Object.entries(args)) {
    if (!isHoisted(a) || !keep.has(name)) continue;
    const local = a.local ?? name;
    if (a.type === "boolean") {
      lines.push(`const ${local} = ${param}.${name} === true ? "true" : "false";`);
    } else {
      lines.push(`const ${local} = ${param}.${name} ?? ${JSON.stringify(a.default)};`);
    }
  }
  return lines;
}
