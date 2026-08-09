import {
  type ConnectorSpec,
  type PathSegment,
  parsePathTemplate,
  type QueryParam,
} from "../../spec.ts";
import { hoistedLocals, renderHoists, renderZodSchema } from "./args.ts";
import { renderBodyExpr } from "./body.ts";
import { baseExpr } from "./fetch-helper.ts";
import { type RenderContext, renderPath } from "./path-template.ts";
import { queryArgsUsed, renderQueryLines } from "./query.ts";
import { renderSearchTool } from "./search.ts";

const PARAM = "p";

/**
 * The hoisted consts this tool's emitted handler actually reads — see renderHoists for why
 * only those may be emitted.
 *
 * `seed` carries the body's own usage, which the caller reports (it excludes booleans). The
 * path consumes every hoisted arg it names; and a query entry reads the same hoisted const
 * the path would, so its args must join the set or the hoist is never emitted and the
 * reference dangles.
 */
function usedHoists(
  segments: readonly PathSegment[],
  hoisted: ReadonlyMap<string, string>,
  query: readonly QueryParam[] | undefined,
  seed: Iterable<string>,
): Set<string> {
  const used = new Set<string>(seed);
  for (const s of segments) {
    if (s.kind === "arg" && hoisted.has(s.name)) used.add(s.name);
  }
  if (query !== undefined) {
    for (const name of queryArgsUsed(query, hoisted)) used.add(name);
  }
  return used;
}

/**
 * The one-line `reg(name, description, schema, async … => call,\n);` form, which only the
 * "concise" convention uses.
 *
 * `inline` keeps the call on the arrow's own line — the shape a handler that takes a
 * parameter writes; a parameterless one wraps the call onto the next line instead.
 */
function renderConciseTool(head: string, param: string, call: string, inline: boolean): string {
  if (inline) return `reg(${head}, async ${param} => ${call},\n);`;
  return `reg(${head}, async ${param} =>\n  ${call},\n);`;
}

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
  const query = tool.query;
  const segments = parsePathTemplate(path);
  const pathCtx: RenderContext = {
    param: PARAM,
    hoisted,
    staticStyle: spec.fetchHelper.staticPathStyle,
    ...(query === undefined ? {} : { prefix: baseExpr(spec) }),
  };
  const pathExpr = renderPath(segments, pathCtx);

  // A guard's path is parsed once and read twice — by usedHoists below and by the ladder at the
  // end — so the two can never disagree about which args a guard names.
  const guards = (tool.pathWhen ?? []).map((g) => ({
    absent: g.absent,
    segments: parsePathTemplate(g.path),
  }));

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
  // With a query the path is the `path` const the block below declares, not the inline
  // expression — but WHICH helper receives it is still the method's decision. Substituting
  // the path rather than duplicating the ternary is what keeps a non-GET query tool from
  // silently routing through the read helper.
  const callPath = query === undefined ? pathExpr : "path";
  // Named rather than inlined because a pathWhen guard builds the same call around a different
  // path: two hand-written copies of this ternary would compile even after they diverged, so the
  // moment the write path changes only one of them would follow.
  const callFor = (pathArg: string): string =>
    tool.method === "GET"
      ? `jsonResult(await ${spec.fetchHelper.local}(${pathArg}))`
      : `jsonResult(await ${spec.fetchHelper.local}Send(${pathArg}, ${JSON.stringify(tool.method)}, ${bodyExpr ?? "undefined"}))`;
  const call = callFor(callPath);

  // Only hoists something actually reads are emitted — see renderHoists, and usedHoists for
  // which of the body, the path and the query contributes what. A guard's path is a path like
  // any other: a hoisted arg it names is read at runtime, so it joins the set or the guard
  // references a const the handler never declares.
  const used = usedHoists(
    [...segments, ...guards.flatMap((g) => g.segments)],
    hoisted,
    query,
    body?.hoistsUsed ?? [],
  );

  // The body only ever references PARAM through renderBodyExpr's own param.field
  // expressions, so a defined bodyExpr always needs the parameter — even when the path
  // itself does not. Without this, a write tool whose path is fully static (e.g. a
  // POST to a fixed collection endpoint) would emit an unused `p`, which the generated
  // package's own noUnusedParameters tsconfig setting rejects. A query entry naming an
  // unhoisted arg needs the same thing, for the same reason — it reads `p.<arg>` directly.
  // Every guard reads `p.<absent>` in its own test, so one guard is enough to need the
  // parameter even when nothing else in the tool does — a fully static fallthrough path with
  // one guard would otherwise emit `async () =>` around a body referencing `p`.
  const needsParam =
    used.size > 0 ||
    guards.length > 0 ||
    segments.some((s) => s.kind === "arg" && !hoisted.has(s.name)) ||
    bodyExpr !== undefined ||
    (query ?? []).some((q) => !hoisted.has(q.arg));

  const param = needsParam ? `(${PARAM})` : "()";

  if (query !== undefined) {
    const hoists = renderHoists(tool.args, PARAM, used).map((l) => `    ${l}`);
    const queryLines = renderQueryLines(query, { param: PARAM, hoisted, args: tool.args }).map(
      (l) => `    ${l}`,
    );
    return [
      "reg(",
      `  ${JSON.stringify(tool.name)},`,
      `  ${JSON.stringify(tool.description)},`,
      `  ${schema},`,
      `  async ${param} => {`,
      ...hoists,
      `    const u = new URL(${pathExpr});`,
      ...queryLines,
      // The absolute URL, NOT `${u.pathname}${u.search}` — that drops only the origin and
      // keeps `u.pathname`, which still carries the base's OWN path component (e.g.
      // "/api/v10"), because `pathExpr` was built with the base spliced in as a `new URL(...)`
      // prefix. Returning the pathname+search reintroduces that component as a plain string,
      // and `call`'s fetch helper (`<local>` / `<local>Send`) then prepends the base a second
      // time — "/api/v10/api/v10/...". Both fetch helpers short-circuit on
      // `path.startsWith("http")` and pass an absolute URL through untouched, so this is the
      // intended use of that contract, not a workaround.
      "    const path = `${u}`;",
      `    return ${call};`,
      "  },",
      ");",
    ].join("\n");
  }

  // A hoist has nowhere to live in an expression body, so a tool that needs one takes the block
  // form regardless of the connector's declared style. A pathWhen ladder is statements for the
  // same reason — and it has to be named here explicitly, because `used` counts HOISTS and a
  // guarded tool need not have any. Without this a guarded tool with no defaulted arg takes the
  // expression form and emits none of its guards: it compiles, it lints, and only a byte-diff
  // would ever see it.
  if (used.size === 0 && guards.length === 0 && spec.handlerStyle === "concise") {
    return renderConciseTool(head, param, call, needsParam);
  }

  const hoists = renderHoists(tool.args, PARAM, used).map((l) => `    ${l}`);
  // One statement per guard, in spec order — the ladder is the author's, not sorted. Each
  // guard's path goes through the same renderPath and the same callFor the fallthrough uses,
  // so a guard cannot render differently from an ordinary path. Line breaks are the emitter's,
  // indentation is Biome's (see CLAUDE.md).
  const guardLines = guards.flatMap((g) => [
    `    if (${PARAM}.${g.absent} === undefined) {`,
    `      return ${callFor(renderPath(g.segments, pathCtx))};`,
    "    }",
  ]);
  return [
    "reg(",
    `  ${JSON.stringify(tool.name)},`,
    `  ${JSON.stringify(tool.description)},`,
    `  ${schema},`,
    `  async ${param} => {`,
    ...hoists,
    ...guardLines,
    `    return ${call};`,
    "  },",
    ");",
  ].join("\n");
}

export function renderHandRolledTools(spec: ConnectorSpec): string {
  return spec.tools.map((t) => renderTool(spec, t)).join("\n\n");
}
