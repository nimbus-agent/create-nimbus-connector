import type { ConnectorSpec } from "../../spec.ts";
import { hoistedLocals, renderHoists, renderZodSchema } from "./args.ts";
import { renderBodyExpr } from "./body.ts";
import { parsePathTemplate, renderPath } from "./path-template.ts";
import { renderSearchTool } from "./search.ts";

const PARAM = "p";

function renderTool(spec: ConnectorSpec, tool: ConnectorSpec["tools"][number]): string {
  if (tool.impl === "search") return renderSearchTool(spec, tool);
  const schema = renderZodSchema(tool.args, spec.argsSchemaStyle);
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
  const pathExpr = renderPath(segments, {
    param: PARAM,
    hoisted,
    staticStyle: spec.fetchHelper.staticPathStyle,
  });

  // A non-GET tool routes through the write helper (`${local}Send`) with its method and
  // JSON body; renderBodyExpr returns undefined for a tool that sends no body (e.g. a
  // DELETE with no args), which becomes a literal `undefined` argument rather than
  // `JSON.stringify({})`.
  //
  // Hand-rolled hoists live in the same handler block the body expression is built in, so
  // they ARE in scope here and the full map is passed: a defaulted arg appearing in both
  // the path and the body renders the same const in both, rather than the defaulted value
  // in the URL and the raw `undefined` arg in the body.
  const body = tool.method === "GET" ? undefined : renderBodyExpr(tool, { param: PARAM, hoisted });
  const bodyExpr = body?.expr;
  const call =
    tool.method === "GET"
      ? `jsonResult(await ${spec.fetchHelper.local}(${pathExpr}))`
      : `jsonResult(await ${spec.fetchHelper.local}Send(${pathExpr}, ${JSON.stringify(tool.method)}, ${bodyExpr ?? "undefined"}))`;

  // Only hoists something actually reads are emitted — see renderHoists. The path consumes
  // every hoisted arg it names; the body reports its own usage, which excludes booleans.
  const used = new Set<string>(body?.hoistsUsed ?? []);
  for (const s of segments) {
    if (s.kind === "arg" && hoisted.has(s.name)) used.add(s.name);
  }

  // The body only ever references PARAM through renderBodyExpr's own param.field
  // expressions, so a defined bodyExpr always needs the parameter — even when the path
  // itself does not. Without this, a write tool whose path is fully static (e.g. a
  // POST to a fixed collection endpoint) would emit an unused `p`, which the generated
  // package's own noUnusedParameters tsconfig setting rejects.
  const needsParam =
    used.size > 0 ||
    segments.some((s) => s.kind === "arg" && !hoisted.has(s.name)) ||
    bodyExpr !== undefined;

  const param = needsParam ? `(${PARAM})` : "()";

  // The one-line `reg(name, description, schema, async … => call,\n);` form, which only the
  // "concise" convention uses. A hoist has nowhere to live in an expression body, so a tool
  // that needs one takes the block form regardless of the connector's declared style.
  if (used.size === 0 && spec.handlerStyle === "concise") {
    if (needsParam) {
      return `reg(${head}, async ${param} => ${call},\n);`;
    }
    return `reg(${head}, async ${param} =>\n  ${call},\n);`;
  }

  const hoists = renderHoists(tool.args, PARAM, used).map((l) => `    ${l}`);
  return [
    "reg(",
    `  ${JSON.stringify(tool.name)},`,
    `  ${JSON.stringify(tool.description)},`,
    `  ${schema},`,
    `  async ${param} => {`,
    ...hoists,
    `    return ${call};`,
    "  },",
    ");",
  ].join("\n");
}

export function renderHandRolledTools(spec: ConnectorSpec): string {
  return spec.tools.map((t) => renderTool(spec, t)).join("\n\n");
}
