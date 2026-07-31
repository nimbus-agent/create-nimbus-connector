import type { ConnectorSpec } from "../../spec.ts";
import { hoistedLocals, renderHoists, renderZodSchema } from "./args.ts";
import { parsePathTemplate, renderPath } from "./path-template.ts";

const PARAM = "p";

function renderTool(spec: ConnectorSpec, tool: ConnectorSpec["tools"][number]): string {
  const schema = renderZodSchema(tool.args);
  const head = `${JSON.stringify(tool.name)}, ${JSON.stringify(tool.description)}, ${schema}`;

  if (tool.impl === "stub") {
    const notImplemented = JSON.stringify(`${tool.name} is not implemented`);
    return [
      "reg(",
      `  ${JSON.stringify(tool.name)},`,
      `  ${JSON.stringify(tool.description)},`,
      `  ${schema},`,
      "  async () => {",
      `    throw new Error(${notImplemented});`,
      "  },",
      ");",
    ].join("\n");
  }

  // Schema guarantees "path" is present here — ToolSchema's refine rejects any
  // impl !== "stub" tool with no path.
  const path = tool.path!;

  const hoisted = hoistedLocals(tool.args);
  const segments = parsePathTemplate(path);
  const needsParam =
    hoisted.size > 0 || segments.some((s) => s.kind === "arg" && !hoisted.has(s.name));

  const pathExpr = renderPath(segments, { param: PARAM, hoisted });
  const call = `jsonResult(await ${spec.fetchHelper.local}(${pathExpr}))`;

  if (hoisted.size === 0) {
    const param = needsParam ? `(${PARAM})` : "()";
    if (needsParam) {
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
