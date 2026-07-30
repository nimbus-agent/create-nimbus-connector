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

export function renderZodSchema(args: Args): string {
  const entries = Object.entries(args);
  if (entries.length === 0) return "z.object({})";
  const fields = entries.map(([name, a]) => `${name}: ${renderOne(a)}`).join(", ");
  return `z.object({ ${fields} })`;
}

export function renderHoists(args: Args, param: string): string[] {
  const lines: string[] = [];
  for (const [name, a] of Object.entries(args)) {
    if (!isHoisted(a)) continue;
    const local = a.local ?? name;
    if (a.type === "boolean") {
      lines.push(`const ${local} = ${param}.${name} === true ? "true" : "false";`);
    } else {
      lines.push(`const ${local} = ${param}.${name} ?? ${JSON.stringify(a.default)};`);
    }
  }
  return lines;
}
