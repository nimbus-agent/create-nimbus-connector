# Build prompt — `create-nimbus-connector`

Paste everything below the line into a fresh Claude Code session opened in `C:\gitrep\create-nimbus-connector`, with the main Nimbus monorepo available at `C:\gitrep\Nimbus`.

> This prompt supersedes the original scaffold prompt. Two of that prompt's claims were verified false against the code on 2026-07-30 and are corrected below — do not reintroduce them.

---

I'm building **`create-nimbus-connector`**, a CLI that scaffolds a new Nimbus MCP connector package. Nimbus has 94 connectors built from one rigid shape; this turns that shape into `bunx create-nimbus-connector <name>`.

Main monorepo for reference: `C:\gitrep\Nimbus`. This repo is MIT.

## Ground truth (already verified — trust these, don't re-derive)

These were measured against the monorepo on 2026-07-30. Re-verify anything you're about to depend on heavily, but don't start from scratch.

**A connector is tiny and formulaic.** Smallest is `packages/mcp-connectors/newrelic` at **48 LOC**; median ~150–250 LOC over 1–3 source files; largest ~1091 over 5. Every package is:

```
src/server.ts              # env credential getter → fetch helper → N tool registrations → stdio connect
test/sandbox.test.ts       # IDENTICAL 12 lines in 79 of 94 connectors
package.json               # identical scripts + deps; only the name varies
nimbus.extension.json      # id, displayName, permissions.network, hitlRequired, syncInterval
tsconfig.json
README.md                  # needs a public-tier H2 section (`bun run audit:package-readmes` enforces this)
```

**The template is already extracted** into `packages/mcp-connectors/shared/`. 61 of 94 connectors run through `runReadOnlyMcpConnector`. Read `newrelic/src/server.ts` (the minimal shape) and `linear/` (a richer one with write tools) before designing anything.

**★ The load-bearing constraint — shared helpers are relative imports.** Connectors reach the kit by path *into the monorepo*: `"../../shared/mcp-tool-kit"` appears **99** times, `run-read-only-mcp-connector` 71, `search-filter` 49, `mcp-search-tool` 45. A connector generated *outside* this monorepo cannot resolve any of them. `@nimbus-dev/sdk` exports only `"."`, `"./testing"`, `"./ipc"` — the kit is not published.

Relevant nuance for the fix: `shared/mcp-tool-kit.ts` (170 LOC) is **deliberately dependency-free** — it structurally types Zod (`ZodObjectSchema<T>`) rather than importing it, and takes `registerSimpleTool` as a parameter rather than importing `McpServer`. So it can move into the dep-free SDK without adding runtime deps. `shared/run-read-only-mcp-connector.ts` cannot — it imports `@modelcontextprotocol/sdk` directly. `@nimbus-dev/sdk` currently has **zero** runtime dependencies and that is intentional; do not casually add one.

## Two corrections to the original prompt

1. **"The generated connector passes its contract tests" is a false green.** `test/sandbox.test.ts` is wrapped in `describe.skipIf(!process.env["NIMBUS_TEST_HARNESS"])`, and `NIMBUS_TEST_HARNESS` is set **nowhere** in `.github/`, `scripts/`, or `package.json`. All 79 of those tests skip on every CI run. If you adopt "tests pass" as your acceptance bar you will be measuring nothing. **Real bar: `tsc --noEmit` + `biome check` + a byte-diff of a regenerated connector against the real one.**

2. **Do not emit a "sync-handler stub" into the generated package.** Sync handlers live in the *gateway* — 97 `*-sync.ts` files under `packages/gateway/src/connectors/`. No connector package contains one. See Stage C for the right way to handle this.

## The verification method — use this, it's the whole game

There are **94 golden fixtures** sitting in `packages/mcp-connectors/`. The acceptance test for the generator is:

> Feed the generator the parameters describing an existing connector, and diff its output against that connector's real directory.

Start with `newrelic` (simplest), then `sentry`/`grafana`/`datadog`, then `linear` (write tools + HITL). Where the diff is irreducible, that's a real axis of variation the template must expose as a parameter — or an honest limitation to document. Build this diff harness *early*; it's what keeps the template from drifting into fiction.

## Stage A — monorepo-internal generator (do this first)

Smallest thing that pays off immediately: generate connectors that live *inside* the monorepo, where the relative `../../shared/*` imports resolve as-is. This needs no cross-repo change and speeds up the next first-party connector.

Deliverables:
1. A Bun CLI with interactive prompts: connector name, display name, service, base API URL, auth type (API token / bearer / basic), env var name for the credential, and the read tools to register.
2. A template emitting the full six-file tree above, targeting `packages/mcp-connectors/<name>/`.
3. `--dry-run` printing the tree without writing.
4. The golden-fixture diff harness described above.

Acceptance:
- Regenerating `newrelic` reproduces `packages/mcp-connectors/newrelic/` (modulo documented, justified differences).
- A freshly generated connector passes `tsc --noEmit` and `biome check` inside the monorepo with no manual edits.
- The README carries the public-tier H2 that `audit:package-readmes` requires.

## Stage B — standalone / third-party capable

Make generated connectors work *outside* the monorepo. **Resolve the distribution decision before writing code** — it is the one genuinely load-bearing choice here. Options:

- **(a) Inline** the dep-free `mcp-tool-kit.ts` into each generated package. Simplest; permanent drift risk across published packages.
- **(b) Publish the kit** as a new `@nimbus-dev/sdk/connector-kit` export. Cleanest consumer story; requires a change + release in the separate `nimbus-agent/nimbus-sdk` repo, and forces a decision about the MCP-SDK-dependent half (`run-read-only-mcp-connector`) — likely a peer dependency or leave it monorepo-only.
- **(c) Hybrid** — publish the dep-free kit, inline or omit the rest.

Write the decision down with its rationale before implementing. Then:

1. Implement the chosen strategy.
2. Emit a package that typechecks and runs standalone, with no monorepo present.
3. Publish-ready as `create-nimbus-connector` on npm so `bunx` / `npm create` works.

Acceptance:
- A connector generated into an empty directory outside `C:\gitrep\Nimbus` typechecks, and its server starts and responds to an MCP `tools/list` over stdio, with credentials from env only.
- No relative import escapes the generated package.

## Stage C — optional, only if A and B land cleanly

1. **OAuth and write-tool coverage.** The sizing above centered on the REST/token shape that dominates the roster; the OAuth and write-tool connectors are more varied and that tail was **not** measured. Survey it before committing — it is the most likely source of scope blowup. Write tools must emit correct `hitlRequired` in the manifest.
2. **Gateway wiring checklist instead of a sync stub.** A first-party connector also needs type-coupled registration in the monorepo (the sync handler in `packages/gateway/src/connectors/`, plus catalog / connector-secrets-manifest / rate-limiter sites). Rather than generating those, have the generator print an accurate, verified checklist of the sites to touch. Verify the list against a recent real connector addition in git history — do not invent it.

## Process

- **Brainstorm → spec → plan before code.** Use the brainstorming skill. The Stage B distribution decision especially deserves it.
- Read `.claude/commands/nimbus-connector-authoring.md` in the monorepo for the authoring contract.
- Work on a branch, never commit on `main`.
- Before claiming anything works, run it. "Generated and it looked right" is not verification — diff it against a golden fixture and typecheck it.
- If a claim in this prompt turns out wrong, say so and correct it rather than working around it silently.
