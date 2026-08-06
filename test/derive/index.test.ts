import { beforeAll, describe, expect, it } from "bun:test";
import { initParser } from "../../src/derive/ast.ts";
import { deriveSpec } from "../../src/derive/index.ts";
import { generate } from "../../src/emit/index.ts";
import { formatAll, initFormatter } from "../../src/format.ts";
import { parseSpec } from "../../src/spec.ts";
import type { GeneratedFile } from "../../src/types.ts";
import { displayPath } from "../../src/types.ts";

beforeAll(async () => {
  await initParser();
  await initFormatter();
});

/** One file's content out of an emitted set, by its displayed path. */
function pick(files: readonly GeneratedFile[], path: string): string {
  const f = files.find((x) => displayPath(x.path) === path);
  if (f === undefined) throw new Error(`no ${path} emitted`);
  return f.content;
}

const MANIFEST = JSON.stringify({
  id: "newrelic",
  displayName: "New Relic",
  version: "0.1.0",
  description: "Query New Relic.",
  author: "Nimbus",
  entrypoint: "dist/server.js",
  runtime: "bun",
  permissions: { network: ["api.newrelic.com"] },
  hitlRequired: [],
  syncInterval: 300,
  minNimbusVersion: "0.2.0",
});

const SERVER = [
  'import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";',
  'import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";',
  'import { z } from "zod";',
  "",
  "import {",
  "  createRegisterSimpleTool,",
  "  createZodToolRegistrar,",
  "  mcpJsonResult as jsonResult,",
  '} from "../../shared/mcp-tool-kit.ts";',
  "",
  "function apiKey(): string {",
  '  const k = process.env["NEW_RELIC_API_KEY"]?.trim();',
  '  if (k === undefined || k === "") {',
  '    throw new Error("NEW_RELIC_API_KEY is not set");',
  "  }",
  "  return k;",
  "}",
  "",
  "async function nrGet(path: string): Promise<unknown> {",
  "  const res = await fetch(`https://api.newrelic.com${path}`, {",
  '    headers: { "X-Api-Key": apiKey(), Accept: "application/json" },',
  "  });",
  "  const text = await res.text();",
  "  if (!res.ok) {",
  "    throw new Error(`New Relic ${String(res.status)}: ${text.slice(0, 400)}`);",
  "  }",
  "  return JSON.parse(text) as unknown;",
  "}",
  "",
  'const mcp = new McpServer({ name: "nimbus-newrelic", version: "0.1.0" });',
  "const reg = createZodToolRegistrar(createRegisterSimpleTool(mcp));",
  "",
  'reg("newrelic_application_list", "List APM applications.", z.object({}), async () =>',
  '  jsonResult(await nrGet("/v2/applications.json")),',
  ");",
  "",
  "const transport = new StdioServerTransport();",
  "await mcp.connect(transport);",
].join("\n");

const MANIFEST_REST = JSON.stringify({
  id: "zzrest",
  displayName: "ZZ Rest",
  version: "0.1.0",
  description: "ZZ Rest connector.",
  author: "Nimbus",
  entrypoint: "dist/server.js",
  runtime: "bun",
  permissions: { network: ["api.zzrest.test"] },
  hitlRequired: [],
  syncInterval: 300,
  minNimbusVersion: "0.2.0",
});

/** The shape src/emit/server/index.ts writes for a rest-kit connector named "zzrest" with the
 * schema-default title ("Zzrest") — confirmed against an actually-generated zzstandalone. */
const SERVER_REST = [
  'import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";',
  'import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";',
  'import { z } from "zod";',
  "",
  'import { createRegisterSimpleTool, createZodToolRegistrar } from "../../shared/mcp-tool-kit.ts";',
  'import { makeRestToolRegistrar } from "../../shared/rest-tool-kit.ts";',
  "",
  "async function zzFetch(",
  "  token: string,",
  "  path: string,",
  "  init?: RequestInit,",
  "): Promise<{ ok: boolean; status: number; json: unknown; text: string }> {",
  '  const url = path.startsWith("http") ? path : `https://api.zzrest.test${path}`;',
  "  const res = await fetch(url, {",
  "    ...init,",
  "    headers: {",
  "      Authorization: `Bearer ${token}`,",
  "      ...(init?.headers as Record<string, string> | undefined),",
  "    },",
  "  });",
  "  const text = await res.text();",
  "  let json: unknown;",
  "  try {",
  "    json = JSON.parse(text) as unknown;",
  "  } catch {",
  "    json = null;",
  "  }",
  "  return { ok: res.ok, status: res.status, json, text };",
  "}",
  "",
  'const server = new McpServer({ name: "nimbus-zzrest", version: "0.1.0" });',
  "const reg = createZodToolRegistrar(createRegisterSimpleTool(server));",
  "",
  "const registerZzrestTool = makeRestToolRegistrar({",
  "  registrar: reg,",
  '  tokenEnv: "ZZREST_TOKEN",',
  '  serviceLabel: "ZZ Rest",',
  "  fetch: zzFetch,",
  "});",
  "",
  'registerZzrestTool("zzrest_item_list", "List items.", z.object({}), () => "/v1/items");',
  "",
  "const transport = new StdioServerTransport();",
  "await server.connect(transport);",
].join("\n");

/**
 * A minimal read-only-kit connector with one search tool and a non-default `title`
 * (`capitalize("zztitle")` is `"Zztitle"`, not `"ZZTitle"`) — built by this repo's own emitter,
 * shared by the three search-assembly tests below: the two blocker paths that sit BETWEEN
 * `recognizeTools` succeeding and the final spec assembly (missing filter file; a filter file
 * present but declaring the wrong export), and the title round trip neither of those exercises.
 */
const ZZTITLE_SPEC = {
  name: "zztitle",
  title: "ZZTitle",
  displayName: "ZZ Title",
  description: "Fixture for search-filter assembly checks.",
  serviceLabel: "ZZ Title",
  style: "read-only-kit",
  network: ["api.zztitle.test"],
  syncInterval: 600,
  minNimbusVersion: "0.2.0",
  env: [{ vars: ["ZZTITLE_TOKEN"], local: "headers", auth: "bearer", required: true }],
  fetchHelper: { local: "zzGet", base: "https://api.zztitle.test", headers: "headers" },
  tools: [
    {
      name: "zztitle_search",
      description: "Search.",
      impl: "search",
      path: "/v1/items",
      filter: { export: "filterZztitleItems", fields: ["a", "b"] },
    },
  ],
};

describe("deriveSpec, search-filter assembly checks (Trap 6 and its neighbours)", () => {
  it("blocks a recognized search tool when no filter file was supplied, rather than deriving a spec that regenerates a different filter", () => {
    const files = formatAll(generate(parseSpec(ZZTITLE_SPEC)));
    const server = pick(files, "src/server.ts");
    const manifest = pick(files, "nimbus.extension.json");
    // filter deliberately omitted — this is the case an absent src/search-filter.ts alongside a
    // recognized search tool must refuse, not silently pass through.
    const result = deriveSpec({ server, manifest });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.blockers.map((b) => b.kind)).toEqual(["missing-file:src/search-filter.ts"]);
  });

  it("blocks a filter file that declares a different export than the one the search tool references", () => {
    const files = formatAll(generate(parseSpec(ZZTITLE_SPEC)));
    const server = pick(files, "src/server.ts");
    const manifest = pick(files, "nimbus.extension.json");
    // The tool's reg() call still names "filterZztitleItems" — only the filter FILE's own
    // export is renamed, so the two sides disagree the way a hand-edited or corrupted directory
    // could.
    const filter = pick(files, "src/search-filter.ts").replaceAll(
      "filterZztitleItems",
      "filterSomethingElse",
    );
    const result = deriveSpec({ server, manifest, filter });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.blockers.map((b) => b.kind)).toEqual(["search-filter:mismatch"]);
  });

  it("recovers a non-default title from the search-filter type alias, verifying the full round trip — spec.title's two real consumers (src/search-filter.ts's type alias and README.md), plus src/server.ts and nimbus.extension.json asserted as general round-trip coverage even though neither reads spec.title at all", () => {
    const files = formatAll(generate(parseSpec(ZZTITLE_SPEC)));
    const server = pick(files, "src/server.ts");
    const manifest = pick(files, "nimbus.extension.json");
    const filter = pick(files, "src/search-filter.ts");

    const result = deriveSpec({ server, manifest, filter });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.spec.title).toBe("ZZTitle");

    const reFiles = formatAll(generate(parseSpec(result.spec)));
    for (const path of [
      "src/server.ts",
      "src/search-filter.ts",
      "nimbus.extension.json",
      "README.md",
    ]) {
      expect(pick(reFiles, path)).toBe(pick(files, path));
    }
  });
});

describe("deriveSpec, rest-kit registrar/title and fetch-helper-name cross-checks", () => {
  it("derives a whole rest-kit connector, omitting title when the registrar is the schema default", () => {
    const result = deriveSpec({ server: SERVER_REST, manifest: MANIFEST_REST });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.spec).toMatchObject({
      name: "zzrest",
      style: "rest-kit",
      serviceLabel: "ZZ Rest",
      env: [{ vars: ["ZZREST_TOKEN"], local: "restAuthToken", auth: "bearer" }],
      fetchHelper: { local: "zzFetch", base: "https://api.zzrest.test" },
    });
    // The whole point of checking the default FIRST in recognizeRestTitle: a registrar shaped
    // exactly as the schema would emit it must not grow an unnecessary explicit "title".
    expect("title" in result.spec).toBe(false);
  });

  it("recovers a non-default title from a registrar name the schema default does not explain, verifying the round trip", () => {
    const server = SERVER_REST.replaceAll("registerZzrestTool", "registerCustomNameTool");
    const result = deriveSpec({ server, manifest: MANIFEST_REST });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.spec.title).toBe("CustomName");
  });

  it("refuses a registrar name that does not fit register<Title>Tool at all", () => {
    const server = SERVER_REST.replaceAll("registerZzrestTool", "handleZzrestTool");
    const result = deriveSpec({ server, manifest: MANIFEST_REST });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.blockers.map((b) => b.kind)).toEqual(["unrecognized-registrar-name"]);
  });

  it("refuses a registrar name no title reproduces — an underscore sanitizes away on re-encode", () => {
    // "_custom" fits register<X>Tool's shape (a JS identifier may contain "_"), but
    // registrarNameFor strips it on re-encode: neither the recovered fragment nor the schema
    // default reproduces "register_customTool" byte-for-byte. This is the case blind trust in
    // the regex capture (rather than verifying the round trip) would have gotten wrong.
    const server = SERVER_REST.replaceAll("registerZzrestTool", "register_customTool");
    const result = deriveSpec({ server, manifest: MANIFEST_REST });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.blockers.map((b) => b.kind)).toEqual(["unrecognized-registrar-name"]);
  });

  it("refuses when the factory's fetch: value disagrees with the recognized fetch helper's own name", () => {
    // The reviewer's own repro: naming the factory's fetch after something else recognizable
    // (here, the global `fetch`) rather than the function recognizeRestFetchHelper actually
    // found (zzFetch) — everything is individually claimed, so only a cross-check catches it.
    const server = SERVER_REST.replace("fetch: zzFetch,", "fetch: fetch,");
    const result = deriveSpec({ server, manifest: MANIFEST_REST });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.blockers.map((b) => b.kind)).toEqual(["rest-fetch-helper-name-mismatch"]);
  });

  it("refuses a rest-kit connector when hitlRequired demands an effect no recognized tool can carry", () => {
    // Every tool SERVER_REST declares is GET, so no attribution reproduces a declared "write" —
    // the rest-kit path's own call into attributeEffects, exercised past every earlier check.
    const unattributable = JSON.stringify({
      ...JSON.parse(MANIFEST_REST),
      hitlRequired: ["write"],
    });
    const result = deriveSpec({ server: SERVER_REST, manifest: unattributable });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.blockers.map((b) => b.kind)).toEqual(["manifest:unattributable-hitl"]);
  });
});

describe("deriveSpec", () => {
  it("derives a whole hand-rolled connector", () => {
    const result = deriveSpec({ server: SERVER, manifest: MANIFEST });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.spec).toMatchObject({
      name: "newrelic",
      displayName: "New Relic",
      serviceLabel: "New Relic",
      style: "hand-rolled",
      env: [{ vars: ["NEW_RELIC_API_KEY"], local: "apiKey", bindings: ["k"], required: true }],
      fetchHelper: { local: "nrGet", base: "https://api.newrelic.com" },
    });
  });

  it("blocks a connector with one unrecognized statement, naming it", () => {
    const server = `${SERVER}\nimport { listTools } from "./tools.ts";`;
    const result = deriveSpec({ server, manifest: MANIFEST });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.blockers.map((b) => b.kind)).toEqual(["import-from:./tools.ts"]);
  });

  it("reports a parse failure as a blocker rather than throwing", () => {
    const result = deriveSpec({ server: "const = ;", manifest: MANIFEST });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.blockers[0]?.kind).toBe("parse-error");
  });

  it("reports an unreadable manifest as a blocker rather than throwing", () => {
    const result = deriveSpec({ server: SERVER, manifest: "{not json" });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.blockers[0]?.kind).toBe("no-manifest");
  });

  it("blocks a style whose frame it does not recognize", () => {
    // "read-only-kit.ts" is not "run-read-only-mcp-connector.ts" — neither the read-only nor
    // the mcp-tool-kit import suffix matches, so this is a missing-kit-import blocker, named by
    // frameFailureKind rather than the old bare "no-frame" bucket it replaced (Task 6).
    const server = 'import { runReadOnlyMcpConnector } from "../../shared/read-only-kit.ts";';
    const result = deriveSpec({ server, manifest: MANIFEST });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.blockers[0]?.kind).toBe("frame:no-kit-import");
  });

  it("blocks a frame with no fetch helper, even though totality is satisfied", () => {
    const server = [
      'import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";',
      'import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";',
      "import {",
      "  createRegisterSimpleTool,",
      "  createZodToolRegistrar,",
      '} from "../../shared/mcp-tool-kit.ts";',
      "",
      'const mcp = new McpServer({ name: "nimbus-empty", version: "0.1.0" });',
      "const reg = createZodToolRegistrar(createRegisterSimpleTool(mcp));",
      "",
      "const transport = new StdioServerTransport();",
      "await mcp.connect(transport);",
    ].join("\n");
    const result = deriveSpec({ server, manifest: MANIFEST });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.blockers.map((b) => b.kind)).toEqual(["no-fetch-helper"]);
  });

  it("refuses a hand-rolled connector when hitlRequired demands an effect no recognized tool can carry", () => {
    // SERVER's only tool is a GET, so no attribution reproduces a declared "write" — the
    // shared-style path's own call into attributeEffects, exercised past every earlier check.
    const unattributable = JSON.stringify({ ...JSON.parse(MANIFEST), hitlRequired: ["write"] });
    const result = deriveSpec({ server: SERVER, manifest: unattributable });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.blockers.map((b) => b.kind)).toEqual(["manifest:unattributable-hitl"]);
  });

  // A genuinely non-trivial attribution (a real write tool, or two tools competing for the
  // same declared effect) is not reachable through deriveSpec() yet: no recognizer in this
  // plan claims a write-effect fetch helper (hand-rolled/read-only-kit) or a non-GET rest-kit
  // registration (round-trip.test.ts's BLOCKED["zzwriteonly"/"zzwriterest"], "write body") — a
  // later phase's territory. attributeEffects' own success and ambiguity behaviour is exercised
  // directly, and exhaustively, in test/derive/effect.test.ts instead.
  it("attaches no $effectAmbiguity when attribution is a no-op, and the spec re-parses", () => {
    const result = deriveSpec({ server: SERVER, manifest: MANIFEST });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect("$effectAmbiguity" in result).toBe(false);
    expect("$effectAmbiguity" in result.spec).toBe(false);
    expect(() => parseSpec(result.spec)).not.toThrow();
  });
});
