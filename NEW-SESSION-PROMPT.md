# Build prompt — `create-nimbus-connector`

Copy everything below into a fresh Claude Code session opened in a clone of `nimbus-agent/create-nimbus-connector`, with the main `nimbus-agent/Nimbus` repo available locally for reference.

---

I'm building **`create-nimbus-connector`**, a CLI scaffolding generator that emits a new Nimbus MCP connector package from the first-party template. Nimbus has ~94 connectors built from one shared shape; this turns that shape into `bunx create-nimbus-connector <name>`.

**Before writing anything, read these in the main Nimbus repo so the template matches reality — do not invent the contract:**
- A full real connector end-to-end, e.g. `packages/mcp-connectors/linear/` (and skim `packages/mcp-connectors/zoom/`): its `package.json`, server entry, manifest, sync handler, tools, contract tests, and README.
- The skill `.claude/commands/nimbus-connector-authoring.md` — the authoring contract (mandatory tool surface, manifest structure, credential injection, the sync handler contract, item ID format, HITL declaration, contract tests, coverage gates).
- `packages/sdk` — what `@nimbus-dev/sdk` exposes (the generated package depends on it).

**Goal:** generating a connector should be ~30 lines of answers, producing a package that typechecks and passes the contract tests immediately.

**Deliverables:**
1. A Bun/Node CLI (`create-nimbus-connector`) with interactive prompts: connector name, target service, auth type (OAuth / API token / basic), which write tools to include (and their HITL classification), and base API URL.
2. A parameterized template that emits the full tree (server, manifest, sync-handler stub, read tools + selected write tools, contract tests, public-tier README, tsconfig, package.json depending on `@nimbus-dev/sdk`).
3. A `--dry-run` flag that prints the file tree without writing.
4. Publish-ready as `create-nimbus-connector` on npm (so `bunx`/`npm create` works).

**Acceptance criteria:**
- A freshly generated connector **typechecks** and **passes its generated contract tests** with no manual edits.
- The generated tool surface and manifest match what the main repo's connector loader/registry expects (verify against a real connector).
- The metadata-only boundary is preserved (no row-fetch tools generated for data connectors).

**Process:** brainstorm → spec → plan first (use the brainstorming skill). The load-bearing risk is template/contract drift — diff a generated connector against `packages/mcp-connectors/linear` and reconcile. Verify the generated package green (typecheck + contract tests) before opening the PR. License is MIT.
