import { afterAll, describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { generate } from "../../src/emit/index.ts";
import { emitServer } from "../../src/emit/server/index.ts";
import { emitWiring } from "../../src/emit/wiring.ts";
import { formatAll, initFormatter } from "../../src/format.ts";
import { run } from "../../src/golden/run.ts";
import { parseSpec } from "../../src/spec.ts";
import { tempDirs } from "../support/tmp.ts";

/**
 * This project's OWN pinned `@biomejs/biome` binary — the same version
 * src/emit/biome-json.ts's BIOME_VERSION bakes into every emitted standalone package's
 * biome.json. Used to lint an emitted package's `src/` under its OWN emitted biome.json (via
 * cwd, which Biome walks up from to find config) without a real `bun install` in a throwaway
 * dir: Biome's checks are syntactic (import order, unused bindings), not type-driven, so they
 * do not need the package's real dependencies actually installed to be meaningful.
 */
const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const BIOME_BIN = join(
  REPO_ROOT,
  "node_modules",
  ".bin",
  process.platform === "win32" ? "biome.exe" : "biome",
);

/**
 * Typechecks EMITTED output, not the emitter.
 *
 * Two defects survived a whole branch because every other test here asserts substrings of
 * the generated text, and a substring assertion cannot see an identifier that is declared
 * and never read:
 *
 *   - `--gateway-wiring` emitted `const LIST_TOOL_ID` referenced only from a comment.
 *   - a hand-rolled connector whose only tool is a POST emitted a read helper nothing calls.
 *
 * Both are `TS6133`, both fail `bun run typecheck` and `bun run lint` in the package they
 * land in, and both are invisible to `toContain`. The only assertion that sees them is a
 * compiler.
 *
 * The wiring pair is compiled here, in full, because it is the one emitted artifact this
 * project writes into a foreign package and never installs anything for: its sole import is
 * type-only, so a small locally-written stand-in is all it needs to compile.
 *
 * What that stand-in does and does not prove: it is written from the shape the skeleton
 * uses, NOT copied from the real `packages/gateway/src/sync/types.ts` — this repository is
 * MIT and the Nimbus monorepo is AGPL-3.0-only — so its member names are ours, not theirs
 * (the real `SyncResult` spells them `itemsUpserted`/`itemsDeleted`). This test therefore
 * proves the emitted skeleton is internally well-typed and free of unread declarations. It
 * cannot prove the skeleton matches Nimbus's current interface; the emitted bodies only
 * throw, so there is nothing here for a member-name mismatch to break, and a real drift in
 * `Syncable` would have to be caught by regenerating against the monorepo.
 *
 * A generated *connector package* is not typechecked here. It imports the SDK, the MCP SDK
 * and zod, and stubbing all three would mean asserting against a surface this project made
 * up — which is how a check ends up green against a fiction. That case is covered by
 * `bun run standalone-acceptance`, which installs the real dependencies and runs the
 * package's own `tsc --noEmit` and `bun run lint`; the `zzwriteonly` fixture there exists
 * for this defect specifically. What remains below is the cheap, direct statement of the
 * emission rule, which the acceptance run then proves compiles.
 */

const tmp = tempDirs();
afterAll(tmp.cleanup);

/**
 * Nimbus's `tsconfig.base.json` compilerOptions, by value.
 *
 * These are the settings the Gateway typechecks its own `src/connectors/*.ts` under, and
 * `--gateway-wiring` writes directly into that directory — so the emitted files have to
 * satisfy them, not this repository's. Configuration values only: no Nimbus source is
 * reproduced here, and nothing in that repository is read or run at test time.
 */
const NIMBUS_COMPILER_OPTIONS = {
  target: "ESNext",
  module: "ESNext",
  moduleResolution: "bundler",
  lib: ["ESNext"],
  types: [] as string[],
  strict: true,
  noUnusedLocals: true,
  noUnusedParameters: true,
  exactOptionalPropertyTypes: true,
  noUncheckedIndexedAccess: true,
  noImplicitOverride: true,
  noPropertyAccessFromIndexSignature: true,
  forceConsistentCasingInFileNames: true,
  noImplicitReturns: true,
  noFallthroughCasesInSwitch: true,
  allowUnreachableCode: false,
  allowUnusedLabels: false,
  esModuleInterop: true,
  allowSyntheticDefaultImports: true,
  resolveJsonModule: true,
  isolatedModules: true,
  skipLibCheck: true,
  declaration: true,
  declarationMap: true,
  sourceMap: true,
  allowImportingTsExtensions: true,
  noEmit: true,
};

/**
 * A stand-in for `packages/gateway/src/sync/types.ts`, written here from the shape the
 * emitted skeleton uses. Deliberately NOT a copy of the real file: this repository is MIT
 * and the Nimbus monorepo is AGPL-3.0-only. Its only job is to let the emitted file resolve
 * its one type-only import so the compiler reaches the checks that matter.
 */
const SYNC_TYPES_STANDIN = `export type SyncContext = { readonly serviceId: string };
export type SyncResult = {
  readonly cursor: string | null;
  readonly itemsUpserted: number;
  readonly itemsDeleted: number;
  readonly hasMore: boolean;
  readonly durationMs: number;
};
export type Syncable = {
  readonly serviceId: string;
  readonly defaultIntervalMs: number;
  readonly initialSyncDepthDays: number;
  sync(ctx: SyncContext, cursor: string | null): Promise<SyncResult>;
};
`;

/**
 * Stand-ins for `packages/mcp-connectors/shared/*.ts`, written from the shapes
 * src/emit/server/index.ts and src/emit/server/search.ts assume — NOT copies of the real
 * (AGPL-3.0-only) files. Loosely typed on purpose: their only job is to let a monorepo-target
 * server.ts resolve its imports so `tsc --noEmit` reaches the check that matters here —
 * `noUnusedLocals` on the import list itself — not to reproduce every real overload.
 */
const MCP_TOOL_KIT_STANDIN = `export type ZodToolRegistrar = (
  name: string,
  description: string,
  schema: unknown,
  handler: (args: never) => Promise<unknown>,
) => void;
export function createRegisterSimpleTool(_server: unknown): unknown {
  throw new Error("stub");
}
export function createZodToolRegistrar(_register: unknown): ZodToolRegistrar {
  throw new Error("stub");
}
export function encodeBasicAuthHeader(_id: string, _secret: string): string {
  throw new Error("stub");
}
export function mcpJsonResult(_data: unknown): unknown {
  throw new Error("stub");
}
`;

const MCP_SEARCH_TOOL_STANDIN = `export type SearchFilter = (item: unknown, query: string) => boolean;
export function searchToolInputSchema(_maxLimit: number): unknown {
  throw new Error("stub");
}
export function matchesResult(
  _rows: unknown,
  _filter: (item: unknown, query: string) => boolean,
  _params: unknown,
): unknown {
  throw new Error("stub");
}
`;

/**
 * Stand-in for `packages/mcp-connectors/shared/search-filter.ts`, written from the shapes
 * src/emit/search-filter.ts assumes — NOT a copy of the real (AGPL-3.0-only) file. Deliberately
 * does NOT export `SearchFilter` (that lives in mcp-search-tool.ts, per MCP_SEARCH_TOOL_STANDIN
 * above): the split is the exact thing under test for the stub-filter path.
 */
const SEARCH_FILTER_SHARED_STANDIN = `export type SearchMatchOptions = { readonly query: string };
// Widened to allow null: the emitted Stage E extractor is
// \`function fieldsOf(item: unknown): readonly string[] | null\`, returning null when
// asObjectish's guard fails — that shape must be assignable to this type, or every extractor
// branch fails makeQueryFilter's own call with a TS2345 no test here would otherwise catch.
export type FieldExtractor = (item: unknown) => readonly string[] | null;
export function fieldsFromKeys(
  _keys: readonly string[],
  _opts?: { tags?: boolean },
): FieldExtractor {
  throw new Error("stub");
}
export function makeQueryFilter(
  _fields: FieldExtractor,
): (item: unknown, query: string) => boolean {
  throw new Error("stub");
}
// Stage E's extractor branch. Signatures match the real shared/search-filter.ts primitives —
// written from src/emit/search-filter.ts's assumptions, NOT copied from the AGPL-3.0-only
// Nimbus checkout. One deliberate exception: FieldExtractor above is narrower than the real
// type (\`readonly (string | null | undefined)[] | null\`, vs. this stand-in's \`readonly
// string[] | null\`). Safe because narrowing a PARAMETER type can only make this stand-in
// over-reject something the real primitives would accept, never under-reject something they
// would not — so it cannot hide a genuine incompatibility.
export function asObjectish(_value: unknown): Record<string, unknown> | undefined {
  throw new Error("stub");
}
export function stringField(_row: Record<string, unknown>, _key: string): string {
  throw new Error("stub");
}
export function nestedString(_root: Record<string, unknown>, _path: readonly string[]): string {
  throw new Error("stub");
}
export function tagText(_row: Record<string, unknown>): string {
  throw new Error("stub");
}
export function tagNamesFromObjects(_row: Record<string, unknown>): string {
  throw new Error("stub");
}
`;

const RUN_READ_ONLY_STANDIN = `import type { ZodToolRegistrar } from "./mcp-tool-kit.ts";
export async function runReadOnlyMcpConnector(
  _serverName: string,
  _register: (reg: ZodToolRegistrar) => void,
): Promise<void> {}
`;

describe("emitted --gateway-wiring output typechecks", () => {
  it("compiles clean under Nimbus's own compilerOptions", async () => {
    const spec = parseSpec({
      name: "newrelic",
      displayName: "New Relic",
      description: "New Relic connector.",
      serviceLabel: "New Relic",
      style: "hand-rolled",
      env: [{ vars: ["NEW_RELIC_API_KEY"], local: "apiKey", required: true }],
      fetchHelper: {
        local: "nrGet",
        base: "https://api.newrelic.com",
        inlineHeaders: { "X-Api-Key": "${env.apiKey}" },
      },
      tools: [{ name: "newrelic_application_list", description: "List applications.", path: "/a" }],
    });

    const dir = tmp.make("cnc-wiring-tc-");
    mkdirSync(join(dir, "connectors"), { recursive: true });
    mkdirSync(join(dir, "sync"), { recursive: true });
    writeFileSync(join(dir, "sync", "types.ts"), SYNC_TYPES_STANDIN, "utf8");

    await initFormatter();
    for (const f of formatAll(emitWiring(spec))) {
      writeFileSync(join(dir, "connectors", ...f.path), f.content, "utf8");
    }
    writeFileSync(
      join(dir, "tsconfig.json"),
      `${JSON.stringify(
        {
          compilerOptions: NIMBUS_COMPILER_OPTIONS,
          include: ["connectors/**/*.ts", "sync/**/*.ts"],
        },
        undefined,
        2,
      )}\n`,
      "utf8",
    );

    const { ok, output } = run(["bunx", "tsc", "--noEmit", "-p", join(dir, "tsconfig.json")], dir);
    // Named explicitly: before the fix this was
    // `connectors/newrelic-sync.ts(4,7): error TS6133: 'LIST_TOOL_ID' is declared but its
    // value is never read.`
    expect(output).not.toContain("TS6133");
    expect(output).toBe("");
    expect(ok).toBe(true);
  }, 120_000);
});

describe("read helper emission is conditional on a call site", () => {
  /**
   * A hand-rolled spec whose ONLY tool is a POST. It calls `<local>Send`, never `<local>`,
   * so an unconditionally-emitted read helper has no call site — `TS6133` under the
   * generated package's own tsconfig, and a biome `noUnusedVariables` error under its own
   * biome.json. `fixtures/zzwriteonly.spec.json` is this spec, and the standalone acceptance
   * run compiles it for real.
   */
  const writeOnly = {
    name: "zzwriteonly",
    displayName: "ZZ Write Only",
    description: "Write-only connector.",
    serviceLabel: "ZZ Write Only",
    style: "hand-rolled",
    env: [{ vars: ["ZZWRITEONLY_TOKEN"], local: "headers", bindings: ["t"], auth: "bearer" }],
    fetchHelper: { local: "zzGet", base: "https://api.zzwriteonly.test", headers: "headers" },
    tools: [
      {
        name: "zzwriteonly_item_create",
        description: "Create an item.",
        method: "POST",
        effect: "write",
        args: { title: { type: "string", min: 1 } },
        path: "/v1/items",
      },
    ],
  };

  const serverOf = (spec: Record<string, unknown>) =>
    generate(parseSpec(spec), { target: "standalone" }).find(
      (f) => f.path.join("/") === "src/server.ts",
    )?.content ?? "";

  it("emits no read helper for a write-only hand-rolled spec", () => {
    const out = serverOf(writeOnly);
    expect(out).not.toContain("async function zzGet(");
    expect(out).toContain("async function zzGetSend(");
  });

  it("emits no read helper for an all-stub hand-rolled spec — a stub handler only throws", () => {
    const out = serverOf({
      ...writeOnly,
      tools: [{ name: "zzwriteonly_todo", description: "Later.", impl: "stub" }],
    });
    expect(out).not.toContain("async function zzGet(");
  });

  it("still emits the read helper for a mixed spec — read-only and mixed output must not move", () => {
    const out = serverOf({
      ...writeOnly,
      tools: [
        ...writeOnly.tools,
        { name: "zzwriteonly_item_list", description: "List items.", path: "/v1/items" },
      ],
    });
    expect(out).toContain("async function zzGet(");
    expect(out).toContain("async function zzGetSend(");
  });

  it("still emits the read helper for a rest-kit spec with no GET at all — the registrar factory references it", () => {
    const out = serverOf({
      name: "zzrestwrite",
      displayName: "ZZ Rest Write",
      description: "Rest-kit write-only connector.",
      serviceLabel: "ZZ Rest Write",
      style: "rest-kit",
      env: [{ vars: ["ZZRESTWRITE_TOKEN"], local: "authHeaders", bindings: ["t"], auth: "bearer" }],
      fetchHelper: { local: "zzFetch", base: "https://api.zzrestwrite.test" },
      tools: [
        {
          name: "zzrestwrite_item_create",
          description: "Create an item.",
          method: "POST",
          effect: "write",
          args: { title: { type: "string", min: 1 } },
          path: "/v1/items",
        },
      ],
    });
    expect(out).toContain("async function zzFetch(");
    expect(out).toContain("  fetch: zzFetch,");
  });
});

describe("a search-only connector imports only what it calls", () => {
  /**
   * A read-only-kit spec whose ONLY tool is impl: "search". renderSearchTool emits
   * matchesResult(...) and never jsonResult(...) — usesJsonResult used to gate on
   * `impl !== "stub"`, which a search tool also satisfies, so this shape used to import
   * `mcpJsonResult as jsonResult` into a file that never calls it: TS6133 under the generated
   * package's own tsconfig (noUnusedLocals), and a biome noUnusedVariables error under its own
   * biome.json. Neither is visible to a substring assertion that only checks for the presence
   * of the *correct* imports — this compiles the emitted monorepo server.ts for real, against
   * local stand-ins for the shared modules, to catch the declared-but-unread case too.
   */
  const spec = parseSpec({
    name: "mercury",
    displayName: "Mercury",
    description: "Mercury connector.",
    serviceLabel: "Mercury",
    style: "read-only-kit",
    fetchHelper: {
      local: "mercuryGet",
      base: "https://api.mercury.com",
      inlineHeaders: { Accept: "application/json" },
    },
    tools: [
      {
        name: "mercury_search",
        description: "Search accounts.",
        impl: "search",
        path: "/api/v1/accounts",
        filter: { export: "filterMercuryAccounts", fields: ["id"] },
      },
    ],
  });

  it("emits no jsonResult import — the cheap, direct statement of the rule", () => {
    const out = emitServer(spec, "monorepo").content;
    expect(out).not.toContain("jsonResult");
    expect(out).toContain("matchesResult");
  });

  it("compiles clean under Nimbus's own compilerOptions — the check a substring assertion cannot make", async () => {
    const dir = tmp.make("cnc-search-only-tc-");
    mkdirSync(join(dir, "shared"), { recursive: true });
    mkdirSync(join(dir, "mercury", "src"), { recursive: true });
    writeFileSync(join(dir, "shared", "mcp-tool-kit.ts"), MCP_TOOL_KIT_STANDIN, "utf8");
    writeFileSync(join(dir, "shared", "mcp-search-tool.ts"), MCP_SEARCH_TOOL_STANDIN, "utf8");
    writeFileSync(
      join(dir, "shared", "run-read-only-mcp-connector.ts"),
      RUN_READ_ONLY_STANDIN,
      "utf8",
    );
    writeFileSync(
      join(dir, "mercury", "src", "search-filter.ts"),
      "export function filterMercuryAccounts(_item: unknown, _query: string): boolean {\n" +
        "  return true;\n}\n",
      "utf8",
    );

    await initFormatter();
    for (const f of formatAll([emitServer(spec, "monorepo")])) {
      writeFileSync(join(dir, "mercury", "src", ...f.path.slice(1)), f.content, "utf8");
    }
    const tsconfigPath = join(dir, "mercury", "tsconfig.json");
    // Real emitTsconfig() sets `types: ["bun"]` for the monorepo target, so `fetch` resolves
    // from @types/bun — but `types` resolves via typeRoots, which walks UP from the tsconfig's
    // own directory through node_modules/@types, and this tsconfig lives in a throwaway OS
    // temp directory with no node_modules to find. Substituting the "DOM" lib for the same
    // global-fetch guarantee is a deliberate, local-only deviation from NIMBUS_COMPILER_OPTIONS
    // — not a claim that Nimbus's real tsconfig uses it — and does not affect the check that
    // matters here, which is `noUnusedLocals` on the import list.
    writeFileSync(
      tsconfigPath,
      `${JSON.stringify(
        {
          compilerOptions: {
            ...NIMBUS_COMPILER_OPTIONS,
            types: [],
            lib: ["ESNext", "DOM"],
          },
          include: ["src/**/*.ts"],
        },
        undefined,
        2,
      )}\n`,
      "utf8",
    );

    const { ok, output } = run(["bunx", "tsc", "--noEmit", "-p", tsconfigPath], dir);
    // Named explicitly: before the fix this was
    // `src/server.ts(3,25): error TS6133: 'jsonResult' is declared but its value is never
    // read.`
    expect(output).not.toContain("TS6133");
    expect(output).toBe("");
    expect(ok).toBe(true);
  }, 120_000);
});

describe("a generated package containing a stub filter typechecks", () => {
  /**
   * The stub path is the likeliest place for an unused or unresolved import: it is the ONLY
   * shape that adds a second relative-import line (SearchFilter from mcp-search-tool.ts,
   * split from SearchMatchOptions in search-filter.ts — see src/emit/search-filter.ts's
   * top-of-file comment), and it is the only shape that must NOT import fieldsFromKeys /
   * makeQueryFilter at all. Neither defect is visible to a substring assertion that only
   * checks for the presence of the correct imports; this compiles the real emitted
   * src/server.ts + src/search-filter.ts pair, via generate(), against local stand-ins for
   * every shared module the pair can reach.
   */
  const stubSpec = parseSpec({
    name: "mercury",
    displayName: "Mercury",
    description: "Mercury connector.",
    serviceLabel: "Mercury",
    style: "read-only-kit",
    fetchHelper: {
      local: "mercuryGet",
      base: "https://api.mercury.com",
      inlineHeaders: { Accept: "application/json" },
    },
    tools: [
      {
        name: "mercury_search",
        description: "Search accounts.",
        impl: "search",
        path: "/api/v1/accounts",
        // fields deliberately omitted — this is the stub-filter shape.
        filter: { export: "filterMercuryAccounts" },
      },
    ],
  });

  it("compiles clean under Nimbus's own compilerOptions", async () => {
    const dir = tmp.make("cnc-search-stub-tc-");
    mkdirSync(join(dir, "shared"), { recursive: true });
    mkdirSync(join(dir, "mercury", "src"), { recursive: true });
    writeFileSync(join(dir, "shared", "mcp-tool-kit.ts"), MCP_TOOL_KIT_STANDIN, "utf8");
    writeFileSync(join(dir, "shared", "mcp-search-tool.ts"), MCP_SEARCH_TOOL_STANDIN, "utf8");
    writeFileSync(join(dir, "shared", "search-filter.ts"), SEARCH_FILTER_SHARED_STANDIN, "utf8");
    writeFileSync(
      join(dir, "shared", "run-read-only-mcp-connector.ts"),
      RUN_READ_ONLY_STANDIN,
      "utf8",
    );

    await initFormatter();
    // Only the src/ files generate() returns — package.json, nimbus.extension.json,
    // tsconfig.json, README.md and test/sandbox.test.ts play no part in this compile.
    const srcFiles = generate(stubSpec, { target: "monorepo" }).filter((f) => f.path[0] === "src");
    expect(srcFiles.map((f) => f.path.join("/")).sort()).toEqual([
      "src/search-filter.ts",
      "src/server.ts",
    ]);
    for (const f of formatAll(srcFiles)) {
      writeFileSync(join(dir, "mercury", ...f.path), f.content, "utf8");
    }
    const tsconfigPath = join(dir, "mercury", "tsconfig.json");
    // Same DOM-lib substitution as the search-only compile test above, and for the same
    // reason: this tsconfig lives in a throwaway temp dir with no node_modules/@types/bun to
    // resolve `types: ["bun"]` against.
    writeFileSync(
      tsconfigPath,
      `${JSON.stringify(
        {
          compilerOptions: {
            ...NIMBUS_COMPILER_OPTIONS,
            types: [],
            lib: ["ESNext", "DOM"],
          },
          include: ["src/**/*.ts"],
        },
        undefined,
        2,
      )}\n`,
      "utf8",
    );

    const { ok, output } = run(["bunx", "tsc", "--noEmit", "-p", tsconfigPath], dir);
    expect(output).not.toContain("TS6133"); // declared but never read (unused import)
    expect(output).not.toContain("TS2307"); // cannot find module (unresolved import)
    expect(output).toBe("");
    expect(ok).toBe(true);
  }, 120_000);
});

describe("a generated package containing a bespoke fieldsOf extractor typechecks", () => {
  /**
   * Today the extractor branch's emitted source is proven only by diff:golden's byte-match and
   * by standalone-acceptance --registry — one needs an AGPL Nimbus checkout, the other the
   * network. Neither runs in a bare `bun test`. This spec forces every one of the branch's five
   * new primitives into both the import list and the emitted body: a plain key (stringField), a
   * two-segment path (nestedString), a non-trailing `{"tags":"objects"}` (tagNamesFromObjects)
   * and a trailing `{"tags":"text"}` (tagText) — the guard (asObjectish) is unconditional. A
   * wrong import name or a signature mismatch between the emitted `fieldsOf` and the shared
   * primitives (e.g. the null return asObjectish's guard produces) now fails here — but only
   * against the stand-in above, written from this emitter's own assumptions. As with the
   * wiring stand-in at the top of this file, a mismatch against Nimbus's actual
   * `shared/search-filter.ts` does NOT fail here: there is no `wiring-conformance`-style check
   * for these primitives, so upstream drift in the real signatures is caught only by
   * `diff:golden` and `standalone-acceptance --registry`, not by this test.
   */
  const extractorSpec = parseSpec({
    name: "zzextract",
    displayName: "ZZ Extract",
    description: "Extractor connector.",
    serviceLabel: "ZZ Extract",
    style: "read-only-kit",
    fetchHelper: {
      local: "zzGet",
      base: "https://api.zzextract.test",
      inlineHeaders: { Accept: "application/json" },
    },
    tools: [
      {
        name: "zzextract_app_search",
        description: "Search apps.",
        impl: "search",
        path: "/v1/apps",
        filter: {
          export: "filterZzextractApps",
          fields: ["name", { path: ["profile", "email"] }, { tags: "objects" }, { tags: "text" }],
        },
      },
    ],
  });

  it("compiles clean under Nimbus's own compilerOptions", async () => {
    const dir = tmp.make("cnc-search-extract-tc-");
    mkdirSync(join(dir, "shared"), { recursive: true });
    mkdirSync(join(dir, "zzextract", "src"), { recursive: true });
    writeFileSync(join(dir, "shared", "mcp-tool-kit.ts"), MCP_TOOL_KIT_STANDIN, "utf8");
    writeFileSync(join(dir, "shared", "mcp-search-tool.ts"), MCP_SEARCH_TOOL_STANDIN, "utf8");
    writeFileSync(join(dir, "shared", "search-filter.ts"), SEARCH_FILTER_SHARED_STANDIN, "utf8");
    writeFileSync(
      join(dir, "shared", "run-read-only-mcp-connector.ts"),
      RUN_READ_ONLY_STANDIN,
      "utf8",
    );

    await initFormatter();
    // Only the src/ files generate() returns — package.json, nimbus.extension.json,
    // tsconfig.json, README.md and test/sandbox.test.ts play no part in this compile.
    const srcFiles = generate(extractorSpec, { target: "monorepo" }).filter(
      (f) => f.path[0] === "src",
    );
    expect(srcFiles.map((f) => f.path.join("/")).sort()).toEqual([
      "src/search-filter.ts",
      "src/server.ts",
    ]);
    for (const f of formatAll(srcFiles)) {
      writeFileSync(join(dir, "zzextract", ...f.path), f.content, "utf8");
    }
    const tsconfigPath = join(dir, "zzextract", "tsconfig.json");
    // Same DOM-lib substitution as the search-only and stub-filter compiles above, and for the
    // same reason: this tsconfig lives in a throwaway temp dir with no node_modules/@types/bun
    // to resolve `types: ["bun"]` against.
    writeFileSync(
      tsconfigPath,
      `${JSON.stringify(
        {
          compilerOptions: {
            ...NIMBUS_COMPILER_OPTIONS,
            types: [],
            lib: ["ESNext", "DOM"],
          },
          include: ["src/**/*.ts"],
        },
        undefined,
        2,
      )}\n`,
      "utf8",
    );

    const { ok, output } = run(["bunx", "tsc", "--noEmit", "-p", tsconfigPath], dir);
    expect(output).not.toContain("TS6133"); // declared but never read (unused import)
    expect(output).not.toContain("TS2307"); // cannot find module (unresolved import)
    expect(output).not.toContain("TS2345"); // argument not assignable (fieldsOf vs FieldExtractor)
    expect(output).toBe("");
    expect(ok).toBe(true);
  }, 120_000);
});

describe("a standalone package's merged KIT import lints clean under its own biome.json", () => {
  /**
   * Combines every optional branch of the standalone-target KIT import at once: the two base
   * names, the two `type` names (read-only-kit + standalone), `encodeBasicAuthHeader`
   * (client-credentials with credentialsIn: "basic"), and both search names (matchesResult +
   * searchToolInputSchema, since the one tool has zero args of its own). This is the exact
   * combination a plain `.sort()` got wrong: Biome 2.5.6's `assist/source/organizeImports`
   * — enabled by `linter.rules.recommended: true` even with no explicit `assist` block, which
   * is what src/emit/biome-json.ts emits — reported `Found 1 error` on the `.sort()`-ordered
   * output ("type McpListResult" needs to sort before "matchesResult", despite 'a' < 'c' at
   * the second character). See task-7-report.md, "Finding A", for the full derivation.
   *
   * This asserts against a real `biome check` run under the package's own emitted biome.json,
   * not a substring — the whole point being that a hand-picked example string can happen to
   * come out sorted correctly while the general rule is still wrong.
   */
  const spec = parseSpec({
    name: "zzfindinga",
    displayName: "ZZ Finding A",
    description: "Finding A repro.",
    serviceLabel: "ZZ Finding A",
    style: "read-only-kit",
    env: [
      {
        vars: ["ZZFA_CLIENT_ID", "ZZFA_CLIENT_SECRET"],
        local: "authHeaders",
        bindings: ["id", "secret"],
        auth: "client-credentials",
        tokenUrl: "https://api.zzfindinga.test/token",
        credentialsIn: "basic",
      },
    ],
    fetchHelper: { local: "zzfaGet", base: "https://api.zzfindinga.test", headers: "authHeaders" },
    tools: [
      {
        name: "zzfindinga_search",
        description: "Search things.",
        impl: "search",
        path: "/v1/things",
        filter: { export: "filterZzfindingaThings", fields: ["id"] },
      },
    ],
  });

  it("emits the KIT import in Biome's real order", () => {
    const out = emitServer(spec, "standalone").content;
    expect(out).toContain(
      [
        "import {",
        "  createRegisterSimpleTool,",
        "  createZodToolRegistrar,",
        "  encodeBasicAuthHeader,",
        "  type McpListResult,",
        "  matchesResult,",
        // Not searchToolInputSchema: the SDK does not export it (it builds a zod schema, and
        // the SDK carries no runtime dependencies), so the standalone target defines it
        // locally and imports the type its signature returns instead.
        "  type SearchMatchOptions,",
        "  type ZodObjectSchema,",
        '} from "@nimbus-dev/sdk/connector-kit";',
      ].join("\n"),
    );
  });

  it("passes a real `biome check src/` under the emitted biome.json", async () => {
    if (!existsSync(BIOME_BIN)) {
      throw new Error(
        `${BIOME_BIN} is missing — this project's own @biomejs/biome devDependency should provide it`,
      );
    }
    const dir = tmp.make("cnc-organize-imports-tc-");
    await initFormatter();
    for (const f of formatAll(generate(spec, { target: "standalone" }))) {
      const p = join(dir, ...f.path);
      mkdirSync(join(p, ".."), { recursive: true });
      writeFileSync(p, f.content, "utf8");
    }

    const { ok, output } = run([BIOME_BIN, "check", "src/"], dir);
    expect(output).not.toContain("organizeImports");
    expect(ok).toBe(true);
  });
});
