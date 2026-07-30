import { parsePathTemplate } from "./emit/server/path-template.ts";
import type { ConnectorSpec } from "./spec.ts";
import { registrarName } from "./spec.ts";

/** Identifiers the emitter itself introduces. A spec may never reuse one. */
export const RESERVED_IDENTIFIERS: readonly string[] = [
  "mcp",
  "server",
  "reg",
  "transport",
  "z",
  "jsonResult",
  "p",
  "parsed",
  "path",
  "pathPart",
  "res",
  "text",
  "McpServer",
  "StdioServerTransport",
  "createRegisterSimpleTool",
  "createZodToolRegistrar",
  "makeRestToolRegistrar",
  "requireProcessEnv",
  // Globals the emitted code calls directly — a `local` that shadows one produces valid
  // syntax that fails only at `tsc` (or worse, at runtime), e.g. `local: "fetch"` emits
  // `function fetch()` shadowing the global, then calls it with two arguments.
  "fetch",
  "process",
  "JSON",
  "String",
  "Error",
  "encodeURIComponent",
  "Promise",
  "console",
  "RequestInit",
];

function claim(seen: Map<string, string>, name: string, owner: string): void {
  const prior = seen.get(name);
  if (prior !== undefined) {
    throw new Error(
      `Identifier collision: "${name}" is used by both ${prior} and ${owner}. ` +
        `Rename one via its "local" field.`,
    );
  }
  seen.set(name, owner);
}

export function validateSpec(spec: ConnectorSpec): void {
  const seen = new Map<string, string>();

  for (const r of RESERVED_IDENTIFIERS) {
    seen.set(r, "a reserved emitter identifier");
  }

  if (spec.style === "rest-kit") {
    claim(seen, registrarName(spec), "the rest-kit tool registrar");
  }

  for (const e of spec.env) {
    claim(seen, e.local, `env accessor for ${e.vars.join(", ")}`);
  }

  claim(seen, spec.fetchHelper.local, "the fetch helper");

  const toolNames = new Set<string>();
  for (const t of spec.tools) {
    if (toolNames.has(t.name)) {
      throw new Error(`Duplicate tool name: "${t.name}".`);
    }
    toolNames.add(t.name);

    for (const [argName, arg] of Object.entries(t.args)) {
      const local = arg.local ?? argName;
      const hoisted = arg.default !== undefined || arg.type === "boolean";
      if (hoisted) {
        claim(seen, local, `the hoisted argument "${argName}" of tool ${t.name}`);
      }
    }

    if (t.path !== undefined) {
      validateToolPath(spec, t, t.path);
    }
  }
}

/**
 * Resolve every `${arg.X}` / `${env.X}` placeholder in a tool's path against the spec
 * that declared it. `parsePathTemplate` only knows placeholder syntax; it has no notion
 * of which args a tool declares or which env locals a spec declares, so an undeclared
 * reference parses cleanly and fails only later, at `tsc`, with no clue which spec field
 * was responsible.
 */
function validateToolPath(
  spec: ConnectorSpec,
  t: ConnectorSpec["tools"][number],
  path: string,
): void {
  const segments = parsePathTemplate(path);
  for (const seg of segments) {
    if (seg.kind === "arg") {
      const arg = t.args[seg.name];
      if (arg === undefined) {
        throw new Error(
          `Tool "${t.name}" path references "\${arg.${seg.name}}", but declares no arg named ` +
            `"${seg.name}".`,
        );
      }
      // |bool renders the hoisted boolean local (the "true"/"false" conversion comes from
      // the hoist itself, keyed on type === "boolean" — see renderHoists). Applied to any
      // other type it would silently fall back to a raw, non-hoisted reference.
      if (seg.mode === "bool" && arg.type !== "boolean") {
        throw new Error(
          `Tool "${t.name}" path references "\${arg.${seg.name}|bool}", but "${seg.name}" is ` +
            `declared as type "${arg.type}", not "boolean" — |bool only makes sense on a ` +
            "boolean argument.",
        );
      }
    }
    if (seg.kind === "env") {
      if (spec.style === "rest-kit") {
        throw new Error(
          `Tool "${t.name}" path references "\${env.${seg.name}}", but a rest-kit connector ` +
            "cannot reference ${env.X} in a tool path — rest-kit emits no env accessors, so " +
            "the call would be undefined.",
        );
      }
      if (!spec.env.some((e) => e.local === seg.name)) {
        throw new Error(
          `Tool "${t.name}" path references "\${env.${seg.name}}", but no env entry has ` +
            `local "${seg.name}".`,
        );
      }
    }
  }
}
