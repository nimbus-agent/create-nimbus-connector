import type { ConnectorSpec, ToolSpec } from "../../spec.ts";
import { renderZodFields } from "./args.ts";
import { parsePathTemplate, renderPath } from "./path-template.ts";

const PARAM = "p";

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
  const pathExpr = renderPath(parsePathTemplate(tool.path!), {
    param: PARAM,
    hoisted: new Map(),
    staticStyle: spec.fetchHelper.staticPathStyle,
  });
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
