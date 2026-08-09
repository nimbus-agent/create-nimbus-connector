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

/**
 * The two facts `matchClientCredentials` (server/env.ts) and the fetch-helper recognizers recover
 * INDEPENDENTLY and that only this module can hold against each other — the same class of guard
 * as `rest-fetch-helper-name-mismatch` below, and both newly reachable as of task 8.
 *
 * A GET and a POST, so both helpers are emitted and each has to agree separately.
 */
const CC_SPEC = {
  name: "zzcc",
  displayName: "ZZ CC",
  description: "Fixture for the client-credentials cross-checks.",
  serviceLabel: "ZZ CC",
  style: "hand-rolled",
  network: ["api.zzcc.test"],
  syncInterval: 300,
  minNimbusVersion: "0.2.0",
  env: [
    {
      vars: ["ZZCC_CLIENT_ID", "ZZCC_CLIENT_SECRET"],
      local: "authHeaders",
      bindings: ["id", "secret"],
      auth: "client-credentials",
      tokenUrl: "https://api.zzcc.test/oauth/token",
      credentialsIn: "basic",
    },
  ],
  fetchHelper: { local: "zzGet", base: "https://api.zzcc.test", headers: "authHeaders" },
  tools: [
    { name: "zzcc_item_list", description: "List items.", path: "/v1/items", args: {} },
    {
      name: "zzcc_item_create",
      description: "Create an item.",
      method: "POST",
      effect: "write",
      args: { title: { type: "string", min: 1 } },
      path: "/v1/items",
    },
  ],
};

/** A bearer connector, identical in shape but for the auth mode — its accessor is synchronous. */
const BEARER_SPEC = {
  ...CC_SPEC,
  name: "zzbearer",
  displayName: "ZZ Bearer",
  serviceLabel: "ZZ Bearer",
  network: ["api.zzbearer.test"],
  env: [{ vars: ["ZZBEARER_TOKEN"], local: "authHeaders", auth: "bearer" }],
  fetchHelper: { local: "zzGet", base: "https://api.zzbearer.test", headers: "authHeaders" },
};

function emitPair(spec: unknown): { server: string; manifest: string } {
  const files = formatAll(generate(parseSpec(spec)));
  return { server: pick(files, "src/server.ts"), manifest: pick(files, "nimbus.extension.json") };
}

describe("deriveSpec, client-credentials cross-checks", () => {
  it("derives the pristine module, so every corruption below is one edit from a producible shape", () => {
    const result = deriveSpec(emitPair(CC_SPEC));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.spec).toMatchObject({
      env: [
        {
          vars: ["ZZCC_CLIENT_ID", "ZZCC_CLIENT_SECRET"],
          local: "authHeaders",
          auth: "client-credentials",
          tokenUrl: "https://api.zzcc.test/oauth/token",
          credentialsIn: "basic",
        },
      ],
      fetchHelper: { local: "zzGet", headers: "authHeaders" },
    });
  });

  it("leaves the wrapper UNCLAIMED when the token exchange is malformed — the plain-accessor pass must not pick it up as an env entry the module never declared", () => {
    // The hazard is not a confusing message: it is Pass B claiming `authHeaders` as a standalone
    // accessor after Pass A' refused the group, which derives a spec carrying a bogus plain env
    // entry. What stops it is `recognizeOne`'s async/return-type pin (task 1) — an interaction
    // between two tasks, which is exactly the kind of thing that survives until someone reorders
    // them, so it is proved here rather than assumed.
    const { server, manifest } = emitPair(CC_SPEC);
    const corrupted = server.replace("let tokenExpiresAt = 0;", "let tokenExpiresAt = 1;");
    expect(corrupted).not.toBe(server);

    const result = deriveSpec({ server: corrupted, manifest });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    // Reported as unclaimed, NOT silently absorbed into an env entry.
    expect(result.blockers.some((b) => b.kind === "function:authHeaders")).toBe(true);
    expect(result.blockers.some((b) => b.kind === "function:token")).toBe(true);
  });

  it("blocks a module whose emitted comment was stripped — the one defect neither diff:golden nor the round trip can see", () => {
    // `renderTokenFunction` writes three `//` lines above `const ttl`, and it is the only emitter
    // in src/emit/ that puts a comment into src/server.ts at all. A claim is a byte range, so an
    // unpinned comment is claimed with the statements around it and vanishes on re-emission —
    // `ok: true` for a module the derived spec provably cannot regenerate. Neither byte gate can
    // catch it: both emit the comment going in and coming out, so the input and the re-emission
    // agree with each other while disagreeing with the module actually read.
    const { server, manifest } = emitPair(CC_SPEC);
    const corrupted = server
      .split("\n")
      .filter((line) => !line.trim().startsWith("// Renew a little early"))
      .join("\n");
    expect(corrupted).not.toBe(server);
    // The defect it stands in for, stated as the assertion it is: before the pin, this derived.
    expect(deriveSpec({ server: corrupted, manifest }).ok).toBe(false);

    // And the group is reported statement by statement rather than half-claimed.
    const result = deriveSpec({ server: corrupted, manifest });
    if (result.ok) return;
    expect(result.blockers.some((b) => b.kind === "function:token")).toBe(true);
    expect(result.blockers.some((b) => b.kind === "function:authHeaders")).toBe(true);
  });

  it("blocks a token exchange naming a different service than the fetch helper does", () => {
    // One `spec.serviceLabel` writes the token function's two error messages AND the fetch
    // helper's — recovered by two recognizers that never see each other.
    const { server, manifest } = emitPair(CC_SPEC);
    const corrupted = server
      .replace("ZZ CC token exchange", "Other Service token exchange")
      .replace("ZZ CC token response missing", "Other Service token response missing");
    expect(corrupted).not.toBe(server);

    const result = deriveSpec({ server: corrupted, manifest });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.blockers.map((b) => b.kind)).toEqual(["env:token-service-label-mismatch"]);
  });

  it("blocks a client-credentials module whose read helper does NOT await its headers accessor", () => {
    const { server, manifest } = emitPair(CC_SPEC);
    const corrupted = server.replace(
      "{ headers: await authHeaders() }",
      "{ headers: authHeaders() }",
    );
    expect(corrupted).not.toBe(server);

    const result = deriveSpec({ server: corrupted, manifest });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.blockers.map((b) => b.kind)).toEqual(["fetch-helper:headers-await-mismatch"]);
  });

  it("blocks a client-credentials module whose WRITE helper does not await, though its read helper does", () => {
    // Each helper is checked against the env separately, which is why `agreesWithReadHelper`
    // does not compare the flag: two helpers disagreeing means at least one disagrees with the
    // env, and it is named here rather than as a vaguer helper-vs-helper mismatch.
    const { server, manifest } = emitPair(CC_SPEC);
    const corrupted = server.replace(
      'headers: { ...(await authHeaders()), "Content-Type": "application/json" }',
      'headers: { ...authHeaders(), "Content-Type": "application/json" }',
    );
    expect(corrupted).not.toBe(server);

    const result = deriveSpec({ server: corrupted, manifest });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.blockers.map((b) => b.kind)).toEqual(["fetch-helper:headers-await-mismatch"]);
  });

  it("blocks a BEARER module that awaits its headers accessor — the direction the widened accessor branch newly makes reachable", () => {
    // `headerOption` writes `await` only for the client-credentials accessor, so this module
    // re-emits WITHOUT the await: a claimed statement it does not reproduce, and one no byte
    // diff could see, since the recovered `fetchHelper` fields are identical either way.
    const { server, manifest } = emitPair(BEARER_SPEC);
    const corrupted = server
      .replace("{ headers: authHeaders() }", "{ headers: await authHeaders() }")
      .replace("...authHeaders()", "...(await authHeaders())");
    expect(corrupted).not.toBe(server);

    const result = deriveSpec({ server: corrupted, manifest });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.blockers.map((b) => b.kind)).toEqual(["fetch-helper:headers-await-mismatch"]);
  });
});

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

  // A real write tool IS reachable through deriveSpec() now — `recognizeWriteHelper` claims the
  // hand-rolled `<local>Send` and `recognizeOneCall` reads the rest-kit arity-5 initFn, so
  // `zzwriteonly` and `zzwriterest` both round-trip rather than blocking.
  it("attaches no $effectAmbiguity when attribution is a no-op, and the spec re-parses", () => {
    const result = deriveSpec({ server: SERVER, manifest: MANIFEST });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect("$effectAmbiguity" in result).toBe(false);
    expect("$effectAmbiguity" in result.spec).toBe(false);
    expect(() => parseSpec(result.spec)).not.toThrow();
  });

  /**
   * The AMBIGUOUS attribution path, end-to-end at last (Task 7 follow-up). It used to need two
   * or more METHOD-carrying tools competing for one declared effect, and every write fixture so
   * far carries a single candidate per effect — no recognizer reached this before `recognizeTools`
   * could read a stub at all. A stub reaches it a different way: it carries no `method`, so it is
   * never itself the attributed tool, but `attributeEffects`'s own docstring is what actually
   * fires here — a stub is a silent SECOND candidate for whatever effect this function attributes
   * to a real tool, since `ToolSchema` lets a stub declare any effect it likes. A spec, not a
   * fixture, is enough to exercise it — see `attributeEffects`'s own direct unit coverage
   * (test/derive/effect.test.ts) for the exhaustive case table this end-to-end test does not
   * repeat.
   */
  const STUB_AMBIGUITY_SPEC = {
    name: "zzeffectstub",
    displayName: "Zz Effect Stub",
    description: "Fixture for the stub effect-ambiguity path.",
    serviceLabel: "ZzEffectStub",
    style: "hand-rolled",
    env: [{ vars: ["ZZEFFECTSTUB_TOKEN"], local: "headers", auth: "bearer", required: true }],
    fetchHelper: { local: "zzGet", base: "https://api.zzeffectstub.test", headers: "headers" },
    tools: [
      {
        name: "zzeffectstub_list",
        description: "Not yet implemented.",
        impl: "stub",
        effect: "write",
      },
      {
        name: "zzeffectstub_create",
        description: "Create an item.",
        method: "POST",
        effect: "write",
        path: "/v1/items",
        args: { title: { type: "string", min: 1 } },
      },
    ],
  };

  describe("the tools-in-a-second-file shim shape (Task 10)", () => {
    // The exact six-line shape all eleven shim connectors write (athena, bigquery,
    // cloud-logging, cloudwatch, dataprofile, elasticsearch, great-expectations, localdb,
    // sagemaker, storybook, vertex-ai): a read-only-kit frame that already matches, wrapping
    // nothing but an import of ./tools.ts and one call to the name it imports.
    const SHIM_SERVER = [
      'import { runReadOnlyMcpConnector } from "../../shared/run-read-only-mcp-connector.ts";',
      'import { registerZzshimTools } from "./tools.ts";',
      "",
      'await runReadOnlyMcpConnector("nimbus-zzshim", (reg) => {',
      "  registerZzshimTools(reg);",
      "});",
    ].join("\n");

    it("collapses the import and the call into one frame:tools-in-second-file blocker", () => {
      const result = deriveSpec({ server: SHIM_SERVER, manifest: MANIFEST });
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.blockers.map((b) => b.kind)).toEqual(["frame:tools-in-second-file"]);
    });

    it("does NOT collapse when the call names something the import does not bind — a label may be permissive, never arbitrary", () => {
      const server = SHIM_SERVER.replace("registerZzshimTools(reg);", "somethingElse(reg);");
      const result = deriveSpec({ server, manifest: MANIFEST });
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.blockers.map((b) => b.kind)).toEqual([
        "import-from:./tools.ts",
        "call:somethingElse",
      ]);
    });

    it("does NOT collapse when the import is not relative — a package import beside an unrelated call stays two ordinary blockers", () => {
      const server = SHIM_SERVER.replace('"./tools.ts"', '"some-package"');
      const result = deriveSpec({ server, manifest: MANIFEST });
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.blockers.map((b) => b.kind)).toEqual([
        "import-from:some-package",
        "call:registerZzshimTools",
      ]);
    });

    it("does NOT collapse three unclaimed statements — the shape is pinned to exactly two", () => {
      const server = SHIM_SERVER.replace(
        "  registerZzshimTools(reg);",
        "  registerZzshimTools(reg);\n  extraCall();",
      );
      const result = deriveSpec({ server, manifest: MANIFEST });
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.blockers.map((b) => b.kind)).toEqual([
        "import-from:./tools.ts",
        "call:registerZzshimTools",
        "call:extraCall",
      ]);
    });

    it("accepts a tools source without yet changing what it derives", () => {
      // Task 2 lands the contract only. Supplying `tools` must be inert until Task 4 reads it, so
      // this pins the boundary between the two changes rather than the eventual behaviour.
      const withTools = deriveSpec({
        server: SHIM_SERVER,
        manifest: MANIFEST,
        tools: "export function registerZzshimTools(reg: ZodToolRegistrar) {}\n",
      });
      const without = deriveSpec({ server: SHIM_SERVER, manifest: MANIFEST });

      expect(withTools).toEqual(without);
    });
  });

  it("attaches $effectAmbiguity when a stub sits beside a write tool competing for the same declared effect", () => {
    const files = formatAll(generate(parseSpec(STUB_AMBIGUITY_SPEC)));
    const server = pick(files, "src/server.ts");
    const manifest = pick(files, "nimbus.extension.json");

    const result = deriveSpec({ server, manifest });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.$effectAmbiguity).toEqual(["write"]);

    // Byte-safe, not wrong: emitManifest's hitlRequired is a deduplicated SET, so it reproduces
    // "write" whichever tool the derived spec attributes it to, and src/server.ts never reads
    // `effect` at all — the ambiguity is real (a human editing this spec cannot tell which tool
    // the author meant) without costing a single byte.
    const reFiles = formatAll(generate(parseSpec(result.spec)));
    expect(pick(reFiles, "src/server.ts")).toBe(server);
    expect(pick(reFiles, "nimbus.extension.json")).toBe(manifest);
  });
});
