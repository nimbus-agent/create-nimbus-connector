import type { ConnectorSpec, ToolSpec } from "../../spec.ts";
import type { GeneratedFile } from "../../types.ts";
import type { GenerateTarget } from "../index.ts";
import { renderEnvAccessors } from "./env.ts";
import { renderBaseConst, renderReadHelper, renderWriteHelper } from "./fetch-helper.ts";
import { renderHandRolledTools } from "./tools-hand.ts";
import { renderRestKitTools } from "./tools-rest.ts";

const KIT = "@nimbus-dev/sdk/connector-kit";
const MCP_TOOL_KIT = "../../shared/mcp-tool-kit.ts";
const RUN_READ_ONLY = "../../shared/run-read-only-mcp-connector.ts";
const SEARCH_TOOL = "../../shared/mcp-search-tool.ts";
const ZOD_IMPORT = 'import { z } from "zod";';

/** Lexicographic order of two strings, as a `sort` comparator result. */
function compareStrings(a: string, b: string): number {
  if (a < b) return -1;
  return a > b ? 1 : 0;
}

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
 * Whether this server must define searchToolInputSchema itself.
 *
 * Only a zero-arg search tool calls the helper at all — one that declares args inlines its
 * merged z.object instead (renderSchema in search.ts). On the monorepo target the helper is
 * imported from shared/mcp-search-tool.ts; on standalone it CANNOT be, because it is the one
 * search symbol the SDK deliberately does not export: it constructs a zod schema, and
 * `@nimbus-dev/sdk` ships an empty `dependencies` so that installing it pulls nothing in —
 * exporting a schema constructor would put zod back in that list (the SDK-side commit says the
 * same). Emitting the import anyway is what standalone acceptance
 * caught — `TS2305: Module '"@nimbus-dev/sdk/connector-kit"' has no exported member
 * 'searchToolInputSchema'`, and a matching bundler error, on both search fixtures.
 */
function needsSearchSchemaGlue(spec: ConnectorSpec, target: GenerateTarget): boolean {
  return target === "standalone" && searchTools(spec).some((t) => Object.keys(t.args).length === 0);
}

/**
 * matchesResult is always needed by a search connector; searchToolInputSchema only by a
 * search tool that declares no args of its own — bitrise inlines its schema and never
 * calls the helper, so importing it unconditionally would be an unused import under the
 * generated package's own noUnusedLocals. On standalone it is never imported at all; see
 * needsSearchSchemaGlue.
 */
function searchKitNames(spec: ConnectorSpec, target: GenerateTarget): string[] {
  const tools = searchTools(spec);
  if (tools.length === 0) return [];
  const names = ["matchesResult"];
  if (target === "monorepo" && tools.some((t) => Object.keys(t.args).length === 0)) {
    names.push("searchToolInputSchema");
  }
  // The two types the emitted glue's signature names. ZodObjectSchema may already be in the
  // list from kitImportNames (standalone read-only-kit names it for the runReadOnly glue), so
  // the standalone caller dedupes before rendering.
  if (needsSearchSchemaGlue(spec, target)) {
    names.push("type SearchMatchOptions", "type ZodObjectSchema");
  }
  return names;
}

/**
 * The specifier src/server.ts uses to reach src/search-filter.ts — the only relative import a
 * generated connector has, and the only place the two targets disagree about an extension.
 *
 * The monorepo corpus writes "./search-filter.ts" and the monorepo tsconfig allows it. A
 * standalone package's tsconfig deliberately does not: `allowImportingTsExtensions` is absent
 * by design (see static.test.ts, "omits allowImportingTsExtensions — no .ts imports remain"),
 * and until Stage D no emitted standalone file had a relative import at all, so nothing tested
 * the claim. A search spec is the first one that does, and it failed exactly there — `TS5097:
 * An import path can only end with a '.ts' extension when 'allowImportingTsExtensions' is
 * enabled`. ".js" is the standard TypeScript-ESM spelling: tsc resolves it to the .ts source
 * under `moduleResolution: "bundler"`, and both `bun` and `bun build` apply the same rewrite,
 * which the two tools/list checks (source and bundled dist) prove rather than assume.
 */
function filterSpecifier(target: GenerateTarget): string {
  return target === "monorepo" ? "./search-filter.ts" : "./search-filter.js";
}

/**
 * One import line naming every filter this server calls.
 *
 * Alphabetised, not in declaration order: Biome's organizeImports sorts the names inside a
 * single clause, so a spec whose filter exports are declared out of order fails the generated
 * package's own `bun run lint`. zzsearchstub is exactly that spec — `filterZzsearchstubItems`
 * is declared before `filterZzsearchstubEvents` — and it is how this surfaced. Single-filter
 * connectors (mercury, zendesk, bitrise) cannot see the difference, which is why the golden
 * fixtures stayed green through it.
 */
function filterImport(spec: ConnectorSpec, target: GenerateTarget): string | undefined {
  const exports = biomeNamedImportOrder(searchTools(spec).map((t) => t.filter!.export));
  if (exports.length === 0) return undefined;
  return `import { ${exports.join(", ")} } from "${filterSpecifier(target)}";`;
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
  return [...blocks].sort((a, b) => compareStrings(a.from, b.from)).flatMap((b) => b.lines);
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
    return compareStrings(ka.local, kb.local);
  });
}

/**
 * A non-search tool (rest or stub) always renders a z.object({...}) schema, even an empty
 * one (see renderZodSchema) — but a search tool only does when it declares its own args
 * (renderSchema in search.ts); a zero-arg search tool calls searchToolInputSchema(...)
 * instead and never references `z` at all. A spec whose only tool(s) are zero-arg search
 * tools is the one shape that must NOT import zod, on pain of the same noUnusedLocals /
 * noUnusedVariables failure `usesJsonResult` above was fixed for.
 *
 * — except on standalone, where that same spec DOES need zod, because it defines
 * searchToolInputSchema itself and the definition is a z.object literal. The two conditions
 * are exact complements, so the whole rule is: zod is imported unless every tool is a zero-arg
 * search tool AND the glue that would reintroduce it is not being emitted.
 */
function usesZod(spec: ConnectorSpec, target: GenerateTarget): boolean {
  if (needsSearchSchemaGlue(spec, target)) return true;
  return spec.tools.some((t) => t.impl !== "search" || Object.keys(t.args).length > 0);
}

/**
 * The package-specifier import group the emitted server opens with — empty for the one shape
 * that has none: monorepo read-only-kit, whose McpServer/StdioServerTransport wiring lives in
 * the shared runReadOnlyMcpConnector helper rather than in the emitted file.
 */
function packageImportHead(spec: ConnectorSpec, target: GenerateTarget): string[] {
  if (spec.style === "read-only-kit" && target === "monorepo") return [];
  return [
    'import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";',
    'import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";',
  ];
}

/**
 * Everything after the @modelcontextprotocol group on the standalone target.
 *
 * One barrel export, so one import regardless of style. Unlike the monorepo target's trailing
 * `../../shared/*` import — a relative specifier, which Biome sorts into its own group behind
 * a blank line — the kit is a package specifier, and "@nimbus-dev/sdk/connector-kit" sorts
 * after the "@modelcontextprotocol/*" entries but BEFORE "zod". It therefore belongs inside
 * the first group, in that position.
 *
 * Deduped: a standalone read-only-kit spec with a zero-arg search tool reaches
 * "type ZodObjectSchema" twice — once for the runReadOnly glue's ZodToolRegistrar, once for
 * the searchToolInputSchema glue's return type. Two identical names in one clause is a TS2300
 * duplicate-identifier error, not merely untidy. zzsearch is that spec.
 */
function standaloneImportLines(spec: ConnectorSpec, target: GenerateTarget): string[] {
  const kitNames = biomeNamedImportOrder([
    ...new Set([...kitImportNames(spec, true, target), ...searchKitNames(spec, target)]),
  ]);
  const lines = renderNamedImport(kitNames, KIT);
  if (usesZod(spec, target)) lines.push(ZOD_IMPORT);
  const filters = filterImport(spec, target);
  if (filters !== undefined) lines.push("", filters);
  return lines;
}

/**
 * The search-kit and filter blocks, which every relative-import group ends with and which
 * read-only-kit and hand-rolled built separately until they disagreed: the hand-rolled copy of
 * the search block was reached by no test and no fixture (nothing in fixtures/ pairs
 * `style: "hand-rolled"` with an `impl: "search"` tool), so a hand-rolled connector losing it
 * would have emitted a server calling matchesResult/searchToolInputSchema without importing
 * them — a TS2304 in the generated package that no golden snapshot could see. One source, so
 * the two styles cannot answer this differently.
 *
 * Both blocks are conditional, and both conditions are the emitter's own: `searchKitNames`
 * returns nothing without a search tool, and `filterImport` nothing without a filter file.
 */
function searchAndFilterBlocks(spec: ConnectorSpec, target: GenerateTarget): RelativeImportBlock[] {
  const search = searchKitNames(spec, target);
  const filters = filterImport(spec, target);
  return [
    ...(search.length > 0
      ? [{ from: SEARCH_TOOL, lines: renderNamedImport(search, SEARCH_TOOL) }]
      : []),
    ...(filters === undefined ? [] : [{ from: filterSpecifier(target), lines: [filters] }]),
  ];
}

/**
 * The relative-import group of a monorepo read-only-kit server.
 *
 * No blank line precedes it: unlike hand-rolled/rest-kit (which precede the McpServer/
 * StdioServerTransport package group), read-only-kit's package group is "zod" alone, and
 * real connectors (mercury, bitrise, testflight, dbt, zoom, flagsmith, …) run it straight
 * into the relative-import group with no separating blank line.
 */
function readOnlyKitImportLines(spec: ConnectorSpec, target: GenerateTarget): string[] {
  const kit = kitImportNames(spec, false, target);
  const blocks: RelativeImportBlock[] = [
    ...(kit.length > 0
      ? [{ from: MCP_TOOL_KIT, lines: renderNamedImport(kit, MCP_TOOL_KIT) }]
      : []),
    {
      from: RUN_READ_ONLY,
      lines: [`import { runReadOnlyMcpConnector } from "${RUN_READ_ONLY}";`],
    },
    ...searchAndFilterBlocks(spec, target),
  ];
  return sortedRelativeImportLines(blocks);
}

/** The relative-import group of a monorepo hand-rolled server. */
function handRolledImportLines(spec: ConnectorSpec, target: GenerateTarget): string[] {
  return sortedRelativeImportLines([
    {
      from: MCP_TOOL_KIT,
      lines: renderNamedImport(kitImportNames(spec, false, target), MCP_TOOL_KIT),
    },
    ...searchAndFilterBlocks(spec, target),
  ]);
}

function imports(spec: ConnectorSpec, target: GenerateTarget): string {
  const head = packageImportHead(spec, target);

  if (target === "standalone") {
    head.push(...standaloneImportLines(spec, target));
    return head.join("\n");
  }

  // monorepo — unchanged from Stage A
  if (usesZod(spec, target)) head.push(ZOD_IMPORT);

  if (spec.style === "read-only-kit") {
    head.push(...readOnlyKitImportLines(spec, target));
    return head.join("\n");
  }

  head.push("");
  if (spec.style === "hand-rolled") {
    head.push(...handRolledImportLines(spec, target));
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

/**
 * The standalone equivalent of shared/mcp-search-tool.ts's searchToolInputSchema, emitted for
 * the same reason the runReadOnly glue above is: the symbol cannot come from the SDK. Here the
 * obstacle is zod rather than @modelcontextprotocol/sdk — the helper's body IS a zod schema,
 * and the SDK ships with no runtime dependencies at all. matchesResult, which needs nothing
 * but the filter, is an SDK export and is imported normally.
 *
 * The explicit `ZodObjectSchema<SearchMatchOptions>` return type is not decoration. It is what
 * fixes `p` in every emitted `async (p) => …` search handler to SearchMatchOptions, which is
 * in turn what lets `matchesResult(rows, filter, p)` typecheck. Dropping it infers a
 * structurally-similar-but-distinct zod output type and the handler parameter degrades to
 * unknown at the registrar boundary. Copied verbatim from the shared module for that reason,
 * including the `maxLimit` parameter every call site passes explicitly.
 */
function renderSearchSchemaGlue(): string {
  return [
    "function searchToolInputSchema(maxLimit: number): ZodObjectSchema<SearchMatchOptions> {",
    "  return z.object({",
    "    query: z.string().min(1),",
    "    limit: z.number().int().min(1).max(maxLimit).optional(),",
    "  });",
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
    // Before the registrations that call it, and before the runReadOnly wrapper on the styles
    // that have one. Both glues are standalone-only, so no monorepo fixture can move.
    ...(needsSearchSchemaGlue(spec, target) ? [renderSearchSchemaGlue()] : []),
    renderTools(spec),
    ...(tail(spec) === undefined ? [] : [tail(spec)!]),
  ].filter((s) => s.trim() !== "");

  return { path: ["src", "server.ts"], content: `${sections.join("\n\n")}\n` };
}
