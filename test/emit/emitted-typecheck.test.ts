import { afterAll, describe, expect, it } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { generate } from "../../src/emit/index.ts";
import { emitWiring } from "../../src/emit/wiring.ts";
import { formatAll, initFormatter } from "../../src/format.ts";
import { run } from "../../src/golden/run.ts";
import { parseSpec } from "../../src/spec.ts";
import { tempDirs } from "../support/tmp.ts";

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
 * type-only, so a small locally-written stand-in is all it needs to compile exactly as it
 * will in `packages/gateway`.
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
  readonly upserted: number;
  readonly deleted: number;
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
