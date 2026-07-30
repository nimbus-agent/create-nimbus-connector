# create-nimbus-connector — Stage B design

**Date:** 2026-07-30
**Status:** approved, ready for implementation planning
**Depends on:** Stage A (`docs/superpowers/specs/2026-07-30-create-nimbus-connector-stage-a-design.md`), merged or on branch
**Scope:** make generated connectors work outside the Nimbus monorepo, and publish the CLI. Stage C — OAuth, write tools, gateway wiring — remains out of scope.

## Problem

Stage A generates connectors that live *inside* the monorepo, where `../../shared/*` relative imports resolve. A connector generated anywhere else cannot resolve them, so the generator is unusable by anyone outside `C:\gitrep\Nimbus`.

Stage B closes that: a generated connector becomes a self-contained package that typechecks, installs and runs on its own, and the CLI becomes installable as `bunx create-nimbus-connector`.

## Ground truth

Measured on 2026-07-30 against `C:\gitrep\Nimbus`, `/c/gitrep/nimbus-sdk`, and this repo's own emitted output.

| Property | Value |
|---|---|
| `@nimbus-dev/sdk` current version | 1.10.1 (Nimbus pins `^1.8.1`) |
| Its `dependencies` / `peerDependencies` | **both empty** |
| Its exports | `.`, `./testing`, `./ipc` |
| Its `files` | `["dist", "src"]`, with a `bun` export condition resolving to `src` |
| It has an API-surface guard | `bun run api:surface` — adding an export is a tracked change |
| `mcp-tool-kit.ts` | 170 lines, **zero** external imports |
| `fetch-bearer-json.ts` | 58 lines, **zero** external imports |
| `rest-tool-kit.ts` | 89 lines, imports only the two above |
| `run-read-only-mcp-connector.ts` | imports `@modelcontextprotocol/sdk` — **not** dependency-free |
| Shared modules this generator emits imports for | exactly those first three (317 lines total) |
| Shared modules this generator **never** emits | `run-read-only-mcp-connector.ts` |
| `@biomejs/wasm-nodejs` payload | 37.6 MB |

Two findings reframe the decision the Stage A doc deferred:

- ✎ **The kit this generator needs is entirely dependency-free.** The Stage A doc anticipated that publishing would "force a decision about the MCP-SDK-dependent half". It does not: the MCP-SDK-dependent module is `run-read-only-mcp-connector.ts`, and this generator never emits an import for it. Publishing the three modules the generator *does* use preserves the SDK's zero-dependency invariant exactly.
- ✎ **`tsconfig.base.json` sets `customConditions: ["bun"]`**, with an in-file comment noting that published npm consumers do not set that condition and fall through to `dist`. A standalone connector therefore resolves the kit to **built output**, so shipping source alone would break it.

## Decisions

| # | Decision | Rationale |
|---|---|---|
| B1 | Publish the kit as `@nimbus-dev/sdk/connector-kit` | Consumers get a real, updatable dependency instead of a frozen copy. Inlining was rejected: every published connector would freeze its own copy and a kit fix would reach none of them. |
| B2 | The SDK owns the canonical copy; Nimbus `shared/*.ts` become re-exports | One definition, so drift is impossible by construction rather than policed by a check that only fires after someone has already diverged. The SDK is the published surface for extension authors, and connector infrastructure belongs there. |
| B3 | Biome becomes an `optionalDependency`, with graceful degradation | 37.6 MB is the dominant install cost of a run-once tool, for output that is cosmetic outside the fixtures. Shelling out to a `biome` binary was rejected — Stage A's D6 explicitly avoids dependence on an external executable and config discovery. |
| B4 | Acceptance is a live stdio `tools/list` handshake, not a byte diff | There are no standalone connectors in existence to diff against, so Stage A's ground truth does not exist here. Proving the server starts and describes itself is the available equivalent. |
| B5 | One spec across three repos; implement this one first | The cross-repo contract is written down once, before any of the three PRs is authored. Only the Nimbus change is gated on an SDK release. |
| B6 | The published CLI targets Bun only | Every Nimbus manifest declares `runtime: "bun"`, and Bun runs TypeScript directly. Supporting `npm create` would require building the CLI to JavaScript for no ecosystem benefit today. Cheap to add later. |

## The cross-repo contract

This is the section the other two repos' PRs are written against. Everything here is fixed before any of them is authored.

### The export

```
@nimbus-dev/sdk/connector-kit
```

A single barrel re-exporting the public surface of three modules, moved verbatim from `Nimbus/packages/mcp-connectors/shared/`:

- `mcp-tool-kit.ts` — `mcpJsonResult`, `mcpJsonResultIfOk`, `mcpJsonResultFromTextIfOk`, `parseJsonTextIfOk`, `registerZodTool`, `createZodToolRegistrar`, `createRegisterSimpleTool`, `requireProcessEnv`, `fetchWithTimeout`, `encodeBasicAuthHeader`, `putOptionalNonEmptyString`, `putOptionalBoolean`, and the types `McpListResult`, `ZodObjectSchema`, `RegisterSimpleToolFn`, `HttpTextResponse`, `HttpJsonBodyResponse`
- `fetch-bearer-json.ts` — `fetchBearerAuthorizedJson`, `resolveUrlWithBase`
- `rest-tool-kit.ts` — `makeRestFetcher`, `makeRestToolRegistrar`, and the types `RestFetchResult`, `RestFetcherConfig`, `RestToolRegistrar`

The kit adds **no runtime dependencies**. The SDK's empty `dependencies` and `peerDependencies` must remain empty; that invariant is part of the contract, not an incidental property.

### It must build to `dist`

`tsconfig.base.json` resolves the SDK via `customConditions: ["bun"]` to TypeScript source. Standalone consumers do not set that condition and fall through to `dist`. The new export therefore needs `dist/connector-kit/index.js` and `dist/connector-kit/index.d.ts` alongside the `bun`-conditioned source entry, matching how `.`, `./testing` and `./ipc` are already shaped.

### Version floor

The SDK is at 1.10.1. This lands as **1.11.0** — additive, no breaking change. Generated standalone connectors depend on `@nimbus-dev/sdk: ^1.11.0`. Nimbus's existing `^1.8.1` pin already admits 1.11.0, so the re-export change needs no version bump in the connectors themselves.

### The Nimbus re-exports

Each shared file re-exports **its own symbols by name**, not `export *`:

```ts
// packages/mcp-connectors/shared/mcp-tool-kit.ts
export {
  createRegisterSimpleTool,
  createZodToolRegistrar,
  mcpJsonResult,
  /* … */
} from "@nimbus-dev/sdk/connector-kit";
export type { McpListResult, ZodObjectSchema, RegisterSimpleToolFn } from "@nimbus-dev/sdk/connector-kit";
```

Naming symbols explicitly preserves each file's exact current surface. A blanket `export *` would make every shared file export every other's symbols, so a connector importing from two of them would see an ambiguous, much larger surface than it does today.

`run-read-only-mcp-connector.ts` stays in Nimbus unchanged. It imports from `./mcp-tool-kit.ts`, which now re-exports — so it keeps working, and its `@modelcontextprotocol/sdk` dependency stays out of the SDK.

**Stage A's fixtures are unaffected.** They compare *connector* files, and a connector's `import … from "../../shared/mcp-tool-kit.ts"` is unchanged text regardless of what that module re-exports internally. All four hand-rolled fixtures must still report 6/6 after the Nimbus change lands.

## Changes in this repo

### Target is a generation option, not a spec field

Where a connector is going is a property of *this generation*, not of the connector:

```ts
generate(spec: ConnectorSpec, options?: { target?: "monorepo" | "standalone" }): GeneratedFile[]
```

defaulting to `"monorepo"`. Fixture spec files stay byte-identical and the Stage A harness is untouched. The CLI gains `--standalone`.

### What differs by target

| File | `monorepo` | `standalone` |
|---|---|---|
| `src/server.ts` imports | `../../shared/mcp-tool-kit.ts`, `../../shared/rest-tool-kit.ts` | `@nimbus-dev/sdk/connector-kit` (one import, both styles) |
| `tsconfig.json` | `extends: "../../../tsconfig.base.json"` | self-contained, mirroring the base's compiler options |
| `package.json` deps | `@nimbus-dev/sdk: ^1.8.1` | `@nimbus-dev/sdk: ^1.11.0` |
| `package.json` scripts | `typecheck`, `lint`, `test`, `clean` | plus `dev` and `build` |
| `README.md` | "Bundled with Nimbus — no separate install required." | install, required env vars, how to run |
| `nimbus.extension.json` | identical | identical |
| `test/sandbox.test.ts` | identical | identical |

The standalone `build` script emits `dist/server.js`, which is what the manifest's `entrypoint` already declares and which nothing currently produces. Note that real `discord` declares `bin: "./dist/server.js"` while its build emits a compiled binary under a different name — that inconsistency is pre-existing in the monorepo and is deliberately not reproduced.

The standalone `tsconfig.json` mirrors `tsconfig.base.json`'s compiler options but **omits `customConditions`**, since a standalone consumer must resolve the SDK to `dist`.

### Biome becomes optional without breaking the synchronous contract

Stage A established `formatAll` as synchronous, and the harness, CLI and acceptance script all depend on that. Loading an optional dependency requires a dynamic import, which is asynchronous — so the load moves out of `formatAll`:

```ts
await initFormatter();              // async, tolerates absence, idempotent
const files = formatAll(generate(spec));   // unchanged, still synchronous
```

`formatAll` formats when a formatter was loaded and passes through unchanged when one was not. `formatterAvailable(): boolean` reports which happened.

**Degradation is not permitted everywhere.** `scripts/diff-golden.ts` and monorepo-internal generation **fail** when Biome is absent — byte-exactness is the whole point there, and unformatted output would produce six spurious diffs that look like emitter regressions. Only the published CLI degrades, printing a notice naming the command to run.

### Publishing

`bin` points at the CLI's TypeScript entry, which gains a `#!/usr/bin/env bun` shebang — Bun runs TypeScript directly, so no build step is needed (B6). `files` limits the tarball to `src` and `README.md`; `fixtures/` stays out, since those specs describe monorepo connectors and are development artefacts rather than examples a consumer can run. Biome moves to `optionalDependencies`.

The package is **not** published until SDK 1.11.0 exists, since a generated standalone connector would otherwise depend on an export nobody can install.

## Acceptance

Stage A's bar was a byte diff against 94 real connectors. Stage B has no such ground truth — no standalone Nimbus connector exists. The substitute is a live end-to-end run.

`scripts/standalone-acceptance.ts`, with `try/finally` cleanup throughout:

1. Generate with `target: "standalone"` into a temp directory **outside** the monorepo.
2. Install, resolving `@nimbus-dev/sdk` from the local checkout. Concretely: the acceptance script rewrites the generated `package.json`'s dependency to `"@nimbus-dev/sdk": "file:<sdk-root>/sdks/typescript"` before running `bun install`, and the SDK root resolves the same way the golden harness resolves the Nimbus root — an explicit flag, then an environment variable, then a sibling probe, failing loudly with the paths it tried rather than falling through. This sidesteps the chicken-and-egg, since the export does not exist on npm until the SDK ships. Once 1.11.0 is published the rewrite is dropped and the generated `^1.11.0` dependency is installed from the registry unmodified.

   Because a `file:` dependency installs the SDK's *built* output, the acceptance script must build the SDK first (or fail with a clear message if `dist` is missing) — which is what makes step 3 genuinely exercise the `dist` resolution path a real consumer takes.
3. `bunx tsc --noEmit` must pass.
4. Assert **no relative import escapes the package**: no `../../` anywhere under `src/`.
5. Spawn `bun src/server.ts`, complete the MCP `initialize` handshake, send `tools/list`, and assert the generated tool names come back.
6. Remove the temp directory, whether or not any step threw.

Step 5 runs with **no credentials set**. Env accessors are only called inside tool handlers, so a successful `tools/list` proves the server starts and describes itself without secrets — which is precisely the "credentials from env only" property.

### Acceptance criteria

1. A connector generated into an empty directory outside the monorepo typechecks with no manual edits.
2. No relative import escapes the generated package.
3. Its server starts and returns the expected tools from `tools/list` over stdio, with no credentials in the environment.
4. Stage A's four hand-rolled fixtures still report 6/6, and the full harness still exits 0.
5. The CLI runs and generates correctly with Biome absent, printing a notice, while the harness fails loudly without it.

## Sequencing

Three PRs, one hard ordering constraint:

1. **`create-nimbus-connector`** — everything above, developed against the local SDK checkout. Blocked on nothing.
2. **`nimbus-sdk`** — move the three modules in, add the `./connector-kit` export and its `dist` build, update the API surface snapshot, release 1.11.0. Blocked only on the contract above being agreed. Note this repo is currently mid-work on `docs/release-pipeline-loose-ends-spec`.
3. **`Nimbus`** — convert the three `shared/*.ts` files to named re-exports. **Blocked on SDK 1.11.0 being published.** Must keep all 99 import sites working and Stage A's fixtures at 6/6.

## Risks

| Risk | Mitigation |
|---|---|
| Moving the kit makes 317 lines a versioned public API with compatibility obligations | Accepted deliberately, and the reason B2 was chosen over two copies. The SDK's `api:surface` guard makes any future change to that surface visible in review rather than silent. |
| The Nimbus re-export changes behaviour subtly for 99 import sites | Re-exports name symbols explicitly, so each file's surface is unchanged. Stage A's byte-diff harness is the regression detector: run it against the modified monorepo before merging the Nimbus PR. |
| Standalone consumers resolve the SDK to `dist`, which may lag `src` | The contract requires the kit to build to `dist`; the acceptance test installs from the local checkout and typechecks, which exercises exactly that resolution path. |
| Optional Biome means two output shapes | Only the published CLI degrades. The harness and monorepo generation fail without Biome rather than silently producing unformatted output. Criterion 5 tests both paths. |
| A released SDK export cannot easily be withdrawn | The three modules have been stable in the monorepo since at least the June 2026 dedup wave, and are dependency-free by design. |

## Out of scope

`npm create` / node support (B6). OAuth, write tools, `hitlRequired` population, and gateway wiring — all Stage C. Migrating existing monorepo connectors to import the SDK path directly; they keep their relative imports. Compiled-binary distribution of generated connectors. Publishing anything from this spec to npm before the SDK's 1.11.0 release exists.
