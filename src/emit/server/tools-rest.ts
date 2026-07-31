import { type ConnectorSpec, registrarName } from "../../spec.ts";
import { hoistedLocals, renderHoists, renderZodSchema } from "./args.ts";
import { renderBodyExpr } from "./body.ts";
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
    const notImplemented = JSON.stringify(`${tool.name} is not implemented`);
    return [...head, `  () => {`, `    throw new Error(${notImplemented});`, "  },", ");"].join(
      "\n",
    );
  }

  // Schema guarantees "path" is present here — ToolSchema's refine rejects any
  // impl !== "stub" tool with no path.
  const path = tool.path!;

  const hoisted = hoistedLocals(tool.args);
  const segments = parsePathTemplate(path);
  const pathExpr = renderPath(segments, { param: PARAM, hoisted });
  const needsParam =
    hoisted.size > 0 || segments.some((s) => s.kind === "arg" && !hoisted.has(s.name));
  const param = needsParam ? `(${PARAM})` : "()";

  const bodyExpr = renderBodyExpr(tool, PARAM);
  // A GET emits no 5th argument at all, so read-only rest-kit output is unchanged. A non-GET
  // with no body (e.g. a DELETE whose only arg is in the path) still needs its method conveyed,
  // but the arrow it's built from must take no parameter — the generated package's tsconfig
  // sets noUnusedParameters, and an unreferenced ${PARAM} would fail its own typecheck.
  const initParam = bodyExpr === undefined ? "()" : `(${PARAM})`;
  const initArg =
    tool.method === "GET"
      ? undefined
      : `  ${initParam} => ({ method: ${JSON.stringify(tool.method)}` +
        (bodyExpr === undefined ? "" : `, body: ${bodyExpr}`) +
        " }),";

  if (hoisted.size === 0) {
    const lines = [...head, `  ${param} => ${pathExpr},`];
    if (initArg !== undefined) lines.push(initArg);
    lines.push(");");
    return lines.join("\n");
  }

  const hoists = renderHoists(tool.args, PARAM).map((l) => `    ${l}`);
  const lines = [...head, `  ${param} => {`, ...hoists, `    return ${pathExpr};`, "  },"];
  if (initArg !== undefined) lines.push(initArg);
  lines.push(");");
  return lines.join("\n");
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
