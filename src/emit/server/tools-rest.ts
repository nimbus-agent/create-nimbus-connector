import { type ConnectorSpec, registrarName } from "../../spec.ts";
import { hoistedLocals, renderHoists, renderZodSchema } from "./args.ts";
import { parsePathTemplate, renderPath } from "./path-template.ts";

const PARAM = "parsed";

function tokenEnvVar(spec: ConnectorSpec): string {
  const authEntry = spec.env.find((e) => e.auth !== undefined);
  if (authEntry === undefined) {
    throw new Error('style "rest-kit" requires one env entry with an "auth" field.');
  }
  return authEntry.vars[0]!;
}

function renderTool(spec: ConnectorSpec, tool: ConnectorSpec["tools"][number]): string {
  const name = registrarName(spec);
  const schema = renderZodSchema(tool.args);
  const head = [
    `${name}(`,
    `  ${JSON.stringify(tool.name)},`,
    `  ${JSON.stringify(tool.description)},`,
    `  ${schema},`,
  ];

  if (tool.impl === "stub") {
    return [
      ...head,
      `  () => {`,
      `    throw new Error(${JSON.stringify(`${tool.name} is not implemented`)});`,
      "  },",
      ");",
    ].join("\n");
  }

  if (tool.path === undefined) {
    throw new Error(`Tool "${tool.name}" has impl "get" but no "path".`);
  }

  const hoisted = hoistedLocals(tool.args);
  const segments = parsePathTemplate(tool.path);
  const pathExpr = renderPath(segments, { param: PARAM, hoisted });
  const needsParam =
    hoisted.size > 0 || segments.some((s) => s.kind === "arg" && !hoisted.has(s.name));
  const param = needsParam ? `(${PARAM})` : "()";

  if (hoisted.size === 0) {
    return [...head, `  ${param} => ${pathExpr},`, ");"].join("\n");
  }

  const hoists = renderHoists(tool.args, PARAM).map((l) => `    ${l}`);
  return [...head, `  ${param} => {`, ...hoists, `    return ${pathExpr};`, "  },", ");"].join(
    "\n",
  );
}

export function renderRestKitTools(spec: ConnectorSpec): string {
  const factory = [
    `const ${registrarName(spec)} = makeRestToolRegistrar({`,
    "  registrar: reg,",
    `  tokenEnv: ${JSON.stringify(tokenEnvVar(spec))},`,
    `  serviceLabel: ${JSON.stringify(spec.serviceLabel)},`,
    `  fetch: ${spec.fetchHelper.local},`,
    "});",
  ].join("\n");

  return [factory, ...spec.tools.map((t) => renderTool(spec, t))].join("\n\n");
}
