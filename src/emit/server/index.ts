import type { ConnectorSpec, ToolSpec } from "../../spec.ts";
import type { GeneratedFile } from "../../types.ts";
import type { GenerateTarget } from "../index.ts";
import { renderEnvAccessors } from "./env.ts";
import { renderBaseConst, renderReadHelper, renderWriteHelper } from "./fetch-helper.ts";
import { renderHandRolledTools } from "./tools-hand.ts";
import { renderRestKitTools } from "./tools-rest.ts";

const KIT = "@nimbus-dev/sdk/connector-kit";
const RUN_READ_ONLY = "../../shared/run-read-only-mcp-connector.ts";
const SEARCH_TOOL = "../../shared/mcp-search-tool.ts";

function isHandStyle(spec: ConnectorSpec): boolean {
  return spec.style === "hand-rolled" || spec.style === "read-only-kit";
}

/**
 * Stub handlers only throw, and a search tool calls only `matchesResult` (see
 * renderSearchTool) — jsonResult(...) is emitted only by a hand-style tool whose impl is
 * "rest" (the transformed enum is "rest" | "stub" | "search", so this is precise, not just
 * "not stub"). Getting this wrong the other way — counting search tools here — imports
 * `mcpJsonResult as jsonResult` into a search-only connector that never calls it, an unused
 * import the generated package's own noUnusedLocals/noUnusedVariables reject.
 */
function usesJsonResult(spec: ConnectorSpec): boolean {
  return isHandStyle(spec) && spec.tools.some((t) => t.impl === "rest");
}

/**
 * The two ways an emitted server names encodeBasicAuthHeader: an `auth: "basic"` accessor
 * always calls it, and the client-credentials token exchange calls it only on its "basic"
 * branch — a "body" entry never references it, so gating on credentialsIn (rather than
 * merely "a client-credentials entry exists") is what keeps the import used, satisfying
 * noUnusedLocals.
 */
function usesEncodeBasicAuthHeader(spec: ConnectorSpec): boolean {
  return spec.env.some(
    (e) => e.auth === "basic" || (e.auth === "client-credentials" && e.credentialsIn === "basic"),
  );
}

/**
 * The tool-kit names the emitted server references, in the order Biome's organizeImports
 * demands of the generated package's own `bun run lint`.
 *
 * Alphabetical insertion point: "encodeBasicAuthHeader" sorts after "createZodToolRegistrar"
 * and before "makeRestToolRegistrar" / "mcpJsonResult as jsonResult". The monorepo
 * hand-rolled branch shares the constraint against the same export set, since
 * "../../shared/mcp-tool-kit.ts" also exports encodeBasicAuthHeader — but it never asks for
 * makeRestToolRegistrar, which lives in a second, separate shared module there.
 */
function kitImportNames(
  spec: ConnectorSpec,
  withRestRegistrar: boolean,
  target: GenerateTarget,
): string[] {
  // Monorepo read-only-kit delegates to the shared helper and names neither primitive;
  // standalone emits the glue itself, so it needs both, plus the two types the glue's
  // signature references.
  const names =
    spec.style === "read-only-kit" && target === "monorepo"
      ? []
      : ["createRegisterSimpleTool", "createZodToolRegistrar"];
  if (spec.style === "read-only-kit" && target === "standalone") {
    names.push("type McpListResult", "type ZodObjectSchema");
  }
  if (usesEncodeBasicAuthHeader(spec)) names.push("encodeBasicAuthHeader");
  if (usesJsonResult(spec)) names.push("mcpJsonResult as jsonResult");
  if (withRestRegistrar && spec.style === "rest-kit") names.push("makeRestToolRegistrar");
  return names;
}

/** One line when the import is the bare two-name default, a wrapped block otherwise. */
function renderNamedImport(names: readonly string[], from: string): string[] {
  if (names.length === 0) return [];
  if (names.length <= 2) return [`import { ${names.join(", ")} } from "${from}";`];
  return ["import {", ...names.map((n) => `  ${n},`), `} from "${from}";`];
}

function searchTools(spec: ConnectorSpec): ToolSpec[] {
  return spec.tools.filter((t) => t.impl === "search");
}

/**
 * matchesResult is always needed by a search connector; searchToolInputSchema only by a
 * search tool that declares no args of its own — bitrise inlines its schema and never
 * calls the helper, so importing it unconditionally would be an unused import under the
 * generated package's own noUnusedLocals.
 */
function searchKitNames(spec: ConnectorSpec): string[] {
  const tools = searchTools(spec);
  if (tools.length === 0) return [];
  const names = ["matchesResult"];
  if (tools.some((t) => Object.keys(t.args).length === 0)) names.push("searchToolInputSchema");
  return names;
}

/** One import line naming every filter this server calls, in declaration order. */
function filterImport(spec: ConnectorSpec): string | undefined {
  const exports = searchTools(spec).map((t) => t.filter!.export);
  if (exports.length === 0) return undefined;
  return `import { ${exports.join(", ")} } from "./search-filter.ts";`;
}

/**
 * A relative-specifier import (one or more rendered lines) keyed by its module specifier, so
 * a set of them can be emitted in Biome's alphabetical order regardless of which order the
 * caller happened to build them in. "../../shared/mcp-search-tool.ts" sorts before
 * "../../shared/mcp-tool-kit.ts", which sorts before
 * "../../shared/run-read-only-mcp-connector.ts" — and "./search-filter.ts" sorts after all
 * three, since "." < "/" makes every "../…" specifier sort before a "./…" one.
 */
type RelativeImportBlock = { readonly from: string; readonly lines: readonly string[] };

function sortedRelativeImportLines(blocks: readonly RelativeImportBlock[]): string[] {
  return [...blocks]
    .sort((a, b) => (a.from < b.from ? -1 : a.from > b.from ? 1 : 0))
    .flatMap((b) => b.lines);
}

/**
 * Replicates Biome 2.5.6's `assist/source/organizeImports` ordering for the names inside a
 * single `import { ... } from "@nimbus-dev/sdk/connector-kit";` clause on the standalone
 * target — confirmed directly against the pinned `@biomejs/biome` binary for every pair this
 * generator can actually co-emit (see task-7-report.md, "Finding A" verification). It is not
 * a plain string sort: Biome buckets names by the case-folded first character of their LOCAL
 * binding (the alias after " as " for `mcpJsonResult as jsonResult`, the name after `type `
 * for a type-only import), puts every `type` import ahead of every value import that shares
 * its bucket, and alphabetizes within each of those two subgroups. A single string compare
 * gets this wrong: "type McpListResult" sorts before "matchesResult" (both bucket on 'm',
 * and type wins the bucket) despite 'a' < 'c' at the second character, while "type
 * ZodObjectSchema" sorts after "searchToolInputSchema" (buckets 'z' and 's' don't tie, so
 * plain alphabetical order applies and type-precedence never enters into it).
 */
function biomeNamedImportOrder(names: readonly string[]): string[] {
  const key = (raw: string): { isType: boolean; local: string } => {
    const isType = raw.startsWith("type ");
    const bare = isType ? raw.slice("type ".length) : raw;
    const asIdx = bare.indexOf(" as ");
    return { isType, local: asIdx === -1 ? bare : bare.slice(asIdx + 4) };
  };
  return [...names].sort((a, b) => {
    const ka = key(a);
    const kb = key(b);
    const la = ka.local.charAt(0).toLowerCase();
    const lb = kb.local.charAt(0).toLowerCase();
    if (la !== lb) return la < lb ? -1 : 1;
    if (ka.isType !== kb.isType) return ka.isType ? -1 : 1;
    return ka.local < kb.local ? -1 : ka.local > kb.local ? 1 : 0;
  });
}

/**
 * A non-search tool (rest or stub) always renders a z.object({...}) schema, even an empty
 * one (see renderZodSchema) — but a search tool only does when it declares its own args
 * (renderSchema in search.ts); a zero-arg search tool calls searchToolInputSchema(...)
 * instead and never references `z` at all. A spec whose only tool(s) are zero-arg search
 * tools is the one shape that must NOT import zod, on pain of the same noUnusedLocals /
 * noUnusedVariables failure `usesJsonResult` above was fixed for.
 */
function usesZod(spec: ConnectorSpec): boolean {
  return spec.tools.some((t) => t.impl !== "search" || Object.keys(t.args).length > 0);
}

function imports(spec: ConnectorSpec, target: GenerateTarget): string {
  const zodNeeded = usesZod(spec);

  const zodImport = 'import { z } from "zod";';
  const head =
    spec.style === "read-only-kit" && target === "monorepo"
      ? []
      : [
          'import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";',
          'import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";',
        ];

  if (target === "standalone") {
    // One barrel export, so one import regardless of style. Unlike the monorepo target's
    // trailing `../../shared/*` import — a relative specifier, which Biome sorts into its
    // own group behind a blank line — the kit is a package specifier, and
    // "@nimbus-dev/sdk/connector-kit" sorts after the "@modelcontextprotocol/*" entries but
    // BEFORE "zod". It therefore belongs inside the first group, in that position.
    const kitNames = biomeNamedImportOrder([
      ...kitImportNames(spec, true, target),
      ...searchKitNames(spec),
    ]);
    head.push(...renderNamedImport(kitNames, KIT));
    if (zodNeeded) head.push(zodImport);
    const filters = filterImport(spec);
    if (filters !== undefined) head.push("", filters);
    return head.join("\n");
  }

  // monorepo — unchanged from Stage A
  if (zodNeeded) head.push(zodImport);

  const search = searchKitNames(spec);
  const filters = filterImport(spec);
  const MCP_TOOL_KIT = "../../shared/mcp-tool-kit.ts";

  if (spec.style === "read-only-kit") {
    // No blank line here: unlike hand-rolled/rest-kit (which precede the McpServer/
    // StdioServerTransport package group), read-only-kit's package group is "zod" alone, and
    // real connectors (mercury, bitrise, testflight, dbt, zoom, flagsmith, …) run it straight
    // into the relative-import group with no separating blank line.
    const kit = kitImportNames(spec, false, target);
    const blocks: RelativeImportBlock[] = [];
    if (kit.length > 0)
      blocks.push({ from: MCP_TOOL_KIT, lines: renderNamedImport(kit, MCP_TOOL_KIT) });
    blocks.push({
      from: RUN_READ_ONLY,
      lines: [`import { runReadOnlyMcpConnector } from "${RUN_READ_ONLY}";`],
    });
    if (search.length > 0) {
      blocks.push({ from: SEARCH_TOOL, lines: renderNamedImport(search, SEARCH_TOOL) });
    }
    if (filters !== undefined) blocks.push({ from: "./search-filter.ts", lines: [filters] });
    head.push(...sortedRelativeImportLines(blocks));
    return head.join("\n");
  }

  head.push("");
  if (spec.style === "hand-rolled") {
    const blocks: RelativeImportBlock[] = [
      {
        from: MCP_TOOL_KIT,
        lines: renderNamedImport(kitImportNames(spec, false, target), MCP_TOOL_KIT),
      },
    ];
    if (search.length > 0) {
      blocks.push({ from: SEARCH_TOOL, lines: renderNamedImport(search, SEARCH_TOOL) });
    }
    if (filters !== undefined) blocks.push({ from: "./search-filter.ts", lines: [filters] });
    head.push(...sortedRelativeImportLines(blocks));
  } else {
    head.push(
      'import { createRegisterSimpleTool, createZodToolRegistrar } from "../../shared/mcp-tool-kit.ts";',
      'import { makeRestToolRegistrar } from "../../shared/rest-tool-kit.ts";',
    );
  }
  return head.join("\n");
}

function wiring(spec: ConnectorSpec): string | undefined {
  if (spec.style === "read-only-kit") return undefined;
  const v = spec.style === "hand-rolled" ? "mcp" : "server";
  return [
    `const ${v} = new McpServer({ name: "nimbus-${spec.name}", version: "0.1.0" });`,
    `const reg = createZodToolRegistrar(createRegisterSimpleTool(${v}));`,
  ].join("\n");
}

function tail(spec: ConnectorSpec): string | undefined {
  if (spec.style === "read-only-kit") return undefined;
  const v = spec.style === "hand-rolled" ? "mcp" : "server";
  return ["const transport = new StdioServerTransport();", `await ${v}.connect(transport);`].join(
    "\n",
  );
}

/**
 * The registrations, wrapped for read-only-kit. Indentation is deliberately NOT applied
 * here — generate() returns unformatted source and formatAll() reindents the block.
 */
function renderTools(spec: ConnectorSpec): string {
  const body = isHandStyle(spec) ? renderHandRolledTools(spec) : renderRestKitTools(spec);
  if (spec.style !== "read-only-kit") return body;
  return [`await runReadOnlyMcpConnector("nimbus-${spec.name}", (reg) => {`, body, "});"].join(
    "\n",
  );
}

/**
 * The standalone equivalent of shared/run-read-only-mcp-connector.ts, emitted into the
 * package rather than added to the SDK: the SDK core must not depend on
 * @modelcontextprotocol/sdk, and the generated package already does. The two registrar
 * primitives it builds on ARE SDK exports, so only this glue is local.
 */
function renderRunReadOnlyGlue(): string {
  return [
    "type ZodToolRegistrar = <T>(",
    "  name: string,",
    "  description: string,",
    "  schema: ZodObjectSchema<T>,",
    "  handler: (args: T) => Promise<McpListResult>,",
    ") => void;",
    "",
    "async function runReadOnlyMcpConnector(",
    "  serverName: string,",
    "  register: (reg: ZodToolRegistrar) => void,",
    "): Promise<void> {",
    '  const mcp = new McpServer({ name: serverName, version: "0.1.0" });',
    "  register(createZodToolRegistrar(createRegisterSimpleTool(mcp)));",
    "  const transport = new StdioServerTransport();",
    "  await mcp.connect(transport);",
    "}",
  ].join("\n");
}

export function emitServer(spec: ConnectorSpec, target: GenerateTarget): GeneratedFile {
  const isHand = isHandStyle(spec);
  const readHelper = renderReadHelper(spec);
  const writeHelper = renderWriteHelper(spec);
  const baseConst = renderBaseConst(spec);
  const sections = [
    imports(spec, target),
    // Ahead of the env accessors, where mercury's `BASE` and bitrise's `BITRISE_API` sit.
    // Undefined unless fetchHelper.baseConst asks for it, so the existing fixtures cannot
    // move.
    ...(baseConst === undefined ? [] : [baseConst]),
    // Env accessors are emitted for hand-rolled and read-only-kit (isHandStyle), never
    // rest-kit. Rest-kit's makeRestToolRegistrar resolves the credential itself via
    // requireProcessEnv(cfg.tokenEnv), so an accessor would never be called; calling
    // renderEnvAccessors unconditionally would emit dead code.
    ...(isHand && spec.env.length > 0 ? [renderEnvAccessors(spec)] : []),
    // Both helpers are conditional, on the same rule stated twice: emit it only if the
    // emitted server calls it. The read helper is skipped when no non-stub GET tool exists
    // (see renderReadHelper); the write helper is skipped when no non-GET tool exists (see
    // renderWriteHelper). A read-only spec reaches neither branch, which is what keeps
    // newrelic/datadog/grafana/sentry byte-safe.
    ...(readHelper === undefined ? [] : [readHelper]),
    ...(writeHelper === undefined ? [] : [writeHelper]),
    ...(wiring(spec) === undefined ? [] : [wiring(spec)!]),
    ...(spec.style === "read-only-kit" && target === "standalone" ? [renderRunReadOnlyGlue()] : []),
    renderTools(spec),
    ...(tail(spec) === undefined ? [] : [tail(spec)!]),
  ].filter((s) => s.trim() !== "");

  return { path: ["src", "server.ts"], content: `${sections.join("\n\n")}\n` };
}
