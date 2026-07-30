import type { z } from "zod";
import type { EnvSchema } from "../../spec.ts";

type EnvEntry = z.infer<typeof EnvSchema>;

const STRIP = 'replace(/\\/$/, "")';

function camel(varName: string): string {
  const parts = varName.toLowerCase().split("_");
  return (
    parts[0]! +
    parts
      .slice(1)
      .map((p) => p[0]!.toUpperCase() + p.slice(1))
      .join("")
  );
}

function bindingOf(e: EnvEntry, i: number): string {
  return e.bindings?.[i] ?? camel(e.vars[i]!);
}

/** `<binding>.replace(...)` when a transform is set, else the bare binding. */
function transformed(e: EnvEntry, binding: string): string {
  return e.transform === "stripTrailingSlash" ? `${binding}.${STRIP}` : binding;
}

/** Wrap in a template literal only when a prefix or suffix exists. */
function wrapped(e: EnvEntry, expr: string): string {
  const hasAffix = e.prefix !== undefined || e.suffix !== undefined;
  if (!hasAffix) return expr;
  return `\`${e.prefix ?? ""}\${${expr}}${e.suffix ?? ""}\``;
}

function readLines(e: EnvEntry): string[] {
  return e.vars.map((v, i) => {
    const b = bindingOf(e, i);
    const read = `process.env[${JSON.stringify(v)}]?.trim()`;
    return e.default !== undefined
      ? `  const ${b} = ${read} || ${JSON.stringify(e.default)};`
      : `  const ${b} = ${read};`;
  });
}

function guardLines(e: EnvEntry): string[] {
  if (e.default !== undefined) return [];
  const needsGuard = e.required || e.auth !== undefined;
  if (!needsGuard) return [];
  const conds = e.vars
    .map((_, i) => {
      const b = bindingOf(e, i);
      return `${b} === undefined || ${b} === ""`;
    })
    .join(" || ");
  const message =
    e.vars.length === 1 ? `${e.vars[0]} is not set` : `${e.vars.join(" and ")} must be set`;
  return [`  if (${conds}) {`, `    throw new Error(${JSON.stringify(message)});`, `  }`];
}

function returnLines(e: EnvEntry): string[] {
  if (e.auth === "bearer") {
    const b = bindingOf(e, 0);
    return [`  return { Authorization: \`Bearer \${${b}}\`, Accept: "application/json" };`];
  }
  if (e.auth === "headers") {
    const entries = e.vars.map((_, i) => {
      const header = e.headerNames![i]!;
      return `    ${JSON.stringify(header)}: ${bindingOf(e, i)},`;
    });
    return ["  return {", ...entries, `    Accept: "application/json",`, "  };"];
  }
  return [`  return ${wrapped(e, transformed(e, bindingOf(e, 0)))};`];
}

export function renderEnvAccessor(e: EnvEntry): string {
  const returnType = e.auth === undefined ? "string" : "Record<string, string>";
  return [
    `function ${e.local}(): ${returnType} {`,
    ...readLines(e),
    ...guardLines(e),
    ...returnLines(e),
    "}",
  ].join("\n");
}
