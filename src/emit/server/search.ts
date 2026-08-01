import type { ConnectorSpec, ToolSpec } from "../../spec.ts";
import { renderZodFields } from "./args.ts";
import { parsePathTemplate, renderPath } from "./path-template.ts";

const PARAM = "p";

/**
 * `renderPath` renders a fully static path (no `${...}` placeholders) as a plain quoted
 * string — the form plain GET tools use (see newrelic's `nrGet("/v2/applications.json")`).
 * Real Nimbus search tools call the fetch helper with a backtick template literal
 * regardless of whether the path is static (see mercury_search and mercury_list, both
 * `mercuryGet(\`/api/v1/accounts\`)`), so a static search path is converted here rather
 * than left as `renderPath` produces it.
 */
function renderFetchPath(path: string): string {
  const expr = renderPath(parsePathTemplate(path), { param: PARAM, hoisted: new Map() });
  if (expr.startsWith("`")) return expr;
  const text = JSON.parse(expr) as string;
  return `\`${text.replaceAll("\\", "\\\\").replaceAll("`", "\\`")}\``;
}

/**
 * The search input schema. A tool with no arguments of its own calls the shared
 * searchToolInputSchema(maxLimit) — the form 44 corpus connectors use, and the one the
 * byte-diff fixtures require. A tool that declares args cannot: the shared helper builds a
 * fixed two-key object, so bitrise inlines the merged shape instead.
 */
function renderSchema(tool: ToolSpec): string {
  if (Object.keys(tool.args).length === 0) return `searchToolInputSchema(${tool.maxLimit})`;
  const own = renderZodFields(tool.args);
  return (
    `z.object({ ${own}, query: z.string().min(1), ` +
    `limit: z.number().int().min(1).max(${tool.maxLimit}).optional() })`
  );
}

export function renderSearchTool(spec: ConnectorSpec, tool: ToolSpec): string {
  // Schema guarantees both: ToolSchema requires a path for any non-stub tool, and requires
  // a filter for every search tool.
  const filterExport = tool.filter!.export;
  const pathExpr = renderFetchPath(tool.path!);
  const fetchCall = `await ${spec.fetchHelper.local}(${pathExpr})`;

  const head = [
    "reg(",
    `  ${JSON.stringify(tool.name)},`,
    `  ${JSON.stringify(tool.description)},`,
    `  ${renderSchema(tool)},`,
    `  async (${PARAM}) => {`,
  ];

  // Without `rows` the response IS the array and needs no local — matchesResult takes
  // `unknown` and guards with Array.isArray itself, so no coercion is emitted either.
  if (tool.rows === undefined) {
    return [
      ...head,
      `    return matchesResult(${fetchCall}, ${filterExport}, ${PARAM});`,
      "  },",
      ");",
    ].join("\n");
  }

  const rows = tool.rows;
  return [
    ...head,
    `    const root = ${fetchCall};`,
    `    const ${rows} = (root as { ${rows}?: unknown[] } | null)?.${rows};`,
    `    return matchesResult(${rows}, ${filterExport}, ${PARAM});`,
    "  },",
    ");",
  ].join("\n");
}
