import {
  type ConnectorSpec,
  type PathSegment,
  parsePathTemplate,
  type QueryParam,
  registrarName,
} from "../../spec.ts";
import { hoistedLocals, renderHoists, renderZodSchema } from "./args.ts";
import { renderBodyExpr } from "./body.ts";
import { baseExpr } from "./fetch-helper.ts";
import { renderPath } from "./path-template.ts";
import { queryArgsUsed, renderQueryLines } from "./query.ts";

const PARAM = "parsed";

function tokenEnvVar(spec: ConnectorSpec): string {
  const authEntry = spec.env.find((e) => e.auth !== undefined);
  if (authEntry === undefined) {
    throw new Error('style "rest-kit" requires one env entry with an "auth" field.');
  }
  return authEntry.vars[0]!;
}

/**
 * The hoisted consts this tool's emitted callback actually reads: the ones the path names,
 * plus the ones a query entry reads.
 *
 * Only the path can consume a hoist here — the hoists are emitted inside the path callback,
 * and the init callback is a separate arrow with its own scope. A hoisted const no path
 * segment names would be a TS6133 in the generated package, reachable from a rest-kit POST
 * with one boolean arg and a fully static path. A query entry reads the same hoisted const
 * the path would, so its args must join the set or the hoist is never emitted and the
 * reference dangles.
 */
function usedHoists(
  segments: readonly PathSegment[],
  hoisted: ReadonlyMap<string, string>,
  query: readonly QueryParam[] | undefined,
): Set<string> {
  const used = new Set<string>();
  for (const s of segments) {
    if (s.kind === "arg" && hoisted.has(s.name)) used.add(s.name);
  }
  if (query !== undefined) {
    for (const name of queryArgsUsed(query, hoisted)) used.add(name);
  }
  return used;
}

/**
 * The registrar call's closing lines: the optional init-callback argument, then `);`. All
 * three body shapes below (query block, expression body, hoist block) end the same way.
 */
function closeCall(lines: readonly string[], initArg: string | undefined): string {
  return [...lines, ...(initArg === undefined ? [] : [initArg]), ");"].join("\n");
}

function renderTool(spec: ConnectorSpec, tool: ConnectorSpec["tools"][number]): string {
  const name = registrarName(spec);
  const schema = renderZodSchema(tool.args, spec.argsSchemaStyle);
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
  const query = tool.query;
  const segments = parsePathTemplate(path);
  const pathExpr = renderPath(segments, {
    param: PARAM,
    hoisted,
    staticStyle: spec.fetchHelper.staticPathStyle,
    ...(query === undefined ? {} : { prefix: baseExpr(spec) }),
  });

  // The path's hoists plus the query's — see usedHoists for why each contributes, and why
  // the init callback below contributes nothing.
  const used = usedHoists(segments, hoisted, query);

  const needsParam =
    used.size > 0 ||
    segments.some((s) => s.kind === "arg" && !hoisted.has(s.name)) ||
    (query ?? []).some((q) => !hoisted.has(q.arg));
  const param = needsParam ? `(${PARAM})` : "()";

  // Empty `hoisted`, deliberately: nothing the path callback declares is in scope inside the
  // init callback, so renderBodyExpr inlines any `?? default` itself rather than naming a
  // const that does not exist there. The value is identical to the path's.
  const body = renderBodyExpr(tool, { param: PARAM, hoisted: new Map() });
  const bodyExpr = body?.expr;
  // A GET emits no 5th argument at all, so read-only rest-kit output is unchanged. A non-GET
  // with no body (e.g. a DELETE whose only arg is in the path) still needs its method conveyed,
  // but the arrow it's built from must take no parameter — the generated package's tsconfig
  // sets noUnusedParameters, and an unreferenced ${PARAM} would fail its own typecheck.
  const initParam = bodyExpr === undefined ? "()" : `(${PARAM})`;
  const bodyPart = bodyExpr === undefined ? "" : `, body: ${bodyExpr}`;
  const initArg =
    tool.method === "GET"
      ? undefined
      : `  ${initParam} => ({ method: ${JSON.stringify(tool.method)}${bodyPart} }),`;

  if (query !== undefined) {
    const hoists = renderHoists(tool.args, PARAM, used).map((l) => `    ${l}`);
    const queryLines = renderQueryLines(query, { param: PARAM, hoisted, args: tool.args }).map(
      (l) => `    ${l}`,
    );
    const lines = [
      ...head,
      `  ${param} => {`,
      ...hoists,
      `    const u = new URL(${pathExpr});`,
      ...queryLines,
      // The absolute URL, NOT `${u.pathname}${u.search}` — that drops only the origin and
      // keeps `u.pathname`, which still carries the base's OWN path component (e.g.
      // "/api/v10"), because `pathExpr` was built with the base spliced in as a `new URL(...)`
      // prefix, not as the URL's origin alone. Returning the pathname+search reintroduces that
      // component as a plain string, and the fetch helper then prepends the base a second time
      // — "/api/v10/api/v10/...". `makeRestToolRegistrar`'s buildPath return type is exactly
      // "a path OR a full URL", and every fetch helper short-circuits on `path.startsWith
      // ("http")`, so the absolute form is the intended use of that contract, not a workaround.
      "    return `${u}`;",
      "  },",
    ];
    return closeCall(lines, initArg);
  }

  if (used.size === 0) {
    return closeCall([...head, `  ${param} => ${pathExpr},`], initArg);
  }

  const hoists = renderHoists(tool.args, PARAM, used).map((l) => `    ${l}`);
  const lines = [...head, `  ${param} => {`, ...hoists, `    return ${pathExpr};`, "  },"];
  return closeCall(lines, initArg);
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
