import type { ConnectorSpec } from "../../spec.ts";
import { hoistedLocals, renderHoists, renderZodSchema } from "./args.ts";
import { parsePathTemplate, renderPath } from "./path-template.ts";

const PARAM = "p";

function renderTool(spec: ConnectorSpec, tool: ConnectorSpec["tools"][number]): string {
  const schema = renderZodSchema(tool.args);
  const head = `${JSON.stringify(tool.name)}, ${JSON.stringify(tool.description)}, ${schema}`;
  const hasArgs = Object.keys(tool.args).length > 0;

  if (tool.impl === "stub") {
    return [
      "reg(",
      `  ${JSON.stringify(tool.name)},`,
      `  ${JSON.stringify(tool.description)},`,
      `  ${schema},`,
      `  async (${hasArgs ? PARAM : ""}) => {`,
      `    throw new Error(${JSON.stringify(`${tool.name} is not implemented`)});`,
      "  },",
      ");",
    ].join("\n");
  }

  if (tool.path === undefined) {
    throw new Error(`Tool "${tool.name}" has impl "get" but no "path".`);
  }

  const hoisted = hoistedLocals(tool.args);
  const pathExpr = renderPath(parsePathTemplate(tool.path), { param: PARAM, hoisted });
  const call = `jsonResult(await ${spec.fetchHelper.local}(${pathExpr}))`;

  if (hoisted.size === 0) {
    const param = hasArgs ? `(${PARAM})` : "()";
    if (hasArgs) {
      return `reg(${head}, async ${param} => ${call},\n);`;
    }
    return `reg(${head}, async ${param} =>\n  ${call},\n);`;
  }

  const hoists = renderHoists(tool.args, PARAM).map((l) => `    ${l}`);
  return [
    "reg(",
    `  ${JSON.stringify(tool.name)},`,
    `  ${JSON.stringify(tool.description)},`,
    `  ${schema},`,
    `  async (${PARAM}) => {`,
    ...hoists,
    `    return ${call};`,
    "  },",
    ");",
  ].join("\n");
}

export function renderHandRolledTools(spec: ConnectorSpec): string {
  return spec.tools.map((t) => renderTool(spec, t)).join("\n\n");
}
