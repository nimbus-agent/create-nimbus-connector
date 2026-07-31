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
