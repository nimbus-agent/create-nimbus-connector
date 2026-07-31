# create-nimbus-connector — Stage A design

**Date:** 2026-07-30
**Status:** approved, ready for implementation planning
**Scope:** Stage A only — a monorepo-internal connector generator plus a golden-fixture diff harness. Stage B (standalone/`bunx` distribution) and Stage C (OAuth, write tools, gateway wiring) are out of scope and get their own design cycles.

## Problem

The Nimbus monorepo contains 94 MCP connectors built from one rigid shape. Adding the 95th means hand-copying six files and editing the parts that vary. This project turns that shape into a generator.

Stage A targets connectors that live *inside* the monorepo at `packages/mcp-connectors/<name>/`, where the `../../shared/*` relative imports resolve as-is. This needs no cross-repo change and pays off on the next first-party connector.

## Ground truth

Measured against `C:\gitrep\Nimbus` on 2026-07-30. Figures marked ✎ correct or add to the numbers in `NEW-SESSION-PROMPT.md`.

| Property | Value |
|---|---|
| Connectors (excluding `shared/`) | 94 |
| `package.json` byte-identical modulo `name` | 66 / 94 |
| Shared runtime deps, all 94 | `@modelcontextprotocol/sdk@1.30.0`, `@nimbus-dev/sdk@^1.8.1`, `zod@^4.4.2` |
| `tsconfig.json` byte-identical | 84 / 94 |
| `test/sandbox.test.ts` byte-identical | 79 / 94 |
| `README.md` matching the standard template | ✎ 29 / 94 |
| Uses `runReadOnlyMcpConnector` | ✎ 60 / 94 (prompt said 61) |
| `../../shared/*` import counts | `mcp-tool-kit` 99, `run-read-only-mcp-connector` 71, `search-filter` 49, `mcp-search-tool` 45 — confirms prompt exactly |
| `src/` file count | 1 file ×24, 2 ×54, 3 ×14, 4 ×1, 5 ×1 |

Two findings the prompt did not mention:

- ✎ **A scaffolder already exists.** `nimbus scaffold extension <id>` lives at `packages/cli/src/commands/scaffold.ts`. It is a stub: four files, `permissions: ["read"]` (wrong shape — the real manifest uses `{ network: [...] }`), a `dist/index.js` entrypoint, no `src/server.ts`, no README. It does not produce anything resembling a real connector. This project supersedes it rather than competing with it.
- ✎ **A declarative REST layer already exists.** `shared/rest-tool-kit.ts` exports `makeRestToolRegistrar`, introduced 2026-06-20 in `refactor(dedup): Wave C — shared makeRestToolRegistrar across 10 REST connectors (#697)`. Ten connectors use it. It collapses a tool to `(name, description, schema, buildPath)` — very close to the spec format this project needs.

### Two emission styles

- **Style H (hand-rolled)** — a bespoke `<x>Get()` helper plus `reg(...)` with an inline handler. 84 connectors, including all four of the simplest.
- **Style R (`rest-tool-kit`)** — `makeRestToolRegistrar` plus `buildPath` lambdas. 10 connectors: `circleci`, `discord`, `github`, `github-actions`, `gmail`, `google-meet`, `google-photos`, `onedrive`, `outlook`, `pagerduty`.

Style R is the direction of travel. Style H is what the four simplest fixtures use. The generator supports both; new connectors default to Style R.

## Decisions

| # | Decision | Rationale |
|---|---|---|
| D1 | Stage A only | The Stage B distribution question is better answered after the diff harness has taught us what actually varies. |
| D2 | Tiered fidelity: declarative REST spec, stub fallback | A frame-only generator makes the byte-diff harness prove almost nothing. Full fidelity blows up into a connector-description language richer than the TypeScript it emits. |
| D3 | Boundary: one GET, path templated over declared args and env-derived values | Smallest rule that covers `newrelic` *and* `sentry` exactly. Everything else degrades to a visible stub. |
| D4 | Fixtures by reference, vendor nothing | This repo is MIT; all 94 connectors are AGPL-3.0-only. Only our own spec JSONs live here. |
| D5 | Emission style is a spec field, default `rest-kit` | Buys zero-diff fixtures on both sides and stops the generator from minting new instances of the duplication PR #697 removed. |
| D6 | Emit canonical TS, then run Biome over it | The fixtures *are* Biome output; matching its line-breaking by hand is a losing game. |

## Architecture

### Generation is a pure function

Generation is two stages, deliberately separated so the purity claim is literally true rather than approximately true:

```ts
generate(spec: ConnectorSpec): GeneratedFile[]     // pure. canonical, UNFORMATTED TS
formatAll(files: GeneratedFile[]): GeneratedFile[]  // SYNCHRONOUS. impure at init, then deterministic
```

`generate` touches no filesystem, no `process.env`, no clock, and no child process. It emits semantically correct TypeScript with naive line breaks. `formatAll` is the only stage that needs Biome, and it is shared verbatim by all three consumers so none of them can disagree about formatting:

1. the interactive CLI, which writes the result to disk;
2. `--dry-run`, which prints the tree;
3. the golden-diff harness, which compares in memory against a real connector directory.

This split is the load-bearing choice. It makes the harness a short pure-comparison script rather than a temp-dir fixture rig, makes every emitter unit-testable without touching disk *or* loading Biome, and confines all environment dependence to one function.

### Module layout

```
src/
  spec.ts             ConnectorSpec type + strict Zod schema + defaults
  validate.ts         identifier-uniqueness + out-of-scope-key checks
  prompts.ts          interactive session -> ConnectorSpec
  format.ts           formatAll() — Biome WASM, the only impure stage
  emit/
    index.ts          generate(spec) -> GeneratedFile[]
    package-json.ts
    tsconfig.ts
    manifest.ts       nimbus.extension.json
    readme.ts
    sandbox-test.ts   constant, zero substitutions
    server/
      index.ts        imports -> env accessors -> fetch helper -> tools
      env.ts          env accessor functions (shared by both styles)
      fetch-helper.ts style-dependent
      tools-hand.ts   Style H tool registrations
      tools-rest.ts   Style R tool registrations
      path-template.ts  path template parser + interpolation codegen
  cli.ts              arg parsing, --dry-run, --spec, disk writes
scripts/
  diff-golden.ts      the harness
fixtures/
  newrelic.spec.json  datadog.spec.json  grafana.spec.json  sentry.spec.json
  discord.spec.json   google-meet.spec.json
```

Only `server/` is genuinely complex; the other five emitters are thin string templates driven directly by spec fields.

## The `ConnectorSpec`

JSON on disk, Zod-validated on load. One file per fixture. Shape:

```jsonc
{
  "name": "sentry",
  "title": "Sentry",
  "displayName": "Sentry",
  "id": "com.nimbus.sentry",
  "description": "...",
  "serviceLabel": "Sentry",
  "style": "hand-rolled",
  "network": ["sentry.io"],
  "syncInterval": 300,
  "minNimbusVersion": "0.2.0",

  "env": [
    { "vars": ["SENTRY_URL"], "local": "apiRoot", "bindings": ["u"],
      "default": "https://sentry.io", "transform": "stripTrailingSlash", "suffix": "/api/0" },
    { "vars": ["SENTRY_ORG_SLUG"],   "local": "org",     "bindings": ["o"], "required": true },
    { "vars": ["SENTRY_AUTH_TOKEN"], "local": "headers", "bindings": ["t"], "auth": "bearer" }
  ],

  "fetchHelper": { "local": "sentryGet", "base": "${env.apiRoot}", "headers": "${env.headers}" },

  "tools": [
    {
      "name": "sentry_issue_list",
      "description": "List unresolved issues for a project.",
      "args": {
        "projectSlug": { "type": "string", "min": 1 },
        "limit": { "type": "number", "int": true, "min": 1, "max": 100,
                   "optional": true, "default": 20, "local": "lim" }
      },
      "path": "/projects/${env.org}/${arg.projectSlug}/issues/?query=is:unresolved&limit=${arg.limit|num}"
    }
  ]
}
```

Defaults: `title` = capitalize(`name`), `id` = `com.nimbus.<name>`, `style` = `rest-kit`, `syncInterval` = 300, `minNimbusVersion` = `0.2.0`.

### Path template language

The whole DSL. A path is a literal string with `${...}` placeholders:

| Placeholder | Emits | Seen in |
|---|---|---|
| `${env.X}` | call to env accessor `X()` | sentry `org()` |
| `${arg.X}` | `p.X` verbatim | sentry `projectSlug` |
| `${arg.X\|enc}` | `encodeURIComponent(...)` | grafana `query`, discord ids |
| `${arg.X\|num}` | `String(...)` | datadog / sentry `limit` |
| `${arg.X\|bool}` | the hoisted boolean local, verbatim | newrelic `only_open` |

An arg with a `default`, or of `type: "boolean"`, is hoisted to a `const` preamble line inside
the handler, named by its `local` field. This mirrors what every real connector does. The
`"true"`/`"false"` conversion comes from that hoist itself (`renderHoists`, keyed on
`type === "boolean"`) — it is not something the `|bool` placeholder does. `|bool` merely
renders whatever local the hoist produced; it exists so a boolean-valued path segment reads
as intentional rather than as a bare `${arg.X}` that happens to work. Validation rejects
`|bool` applied to a non-boolean arg, since there the mode would otherwise be a silent alias
for `|raw` (no hoist, no conversion).

A tool that cannot be expressed sets `"impl": "stub"`; the emitter produces a typed handler that throws `"<tool> not implemented"`. The harness counts stubs per fixture so degradation is always visible.

### Env accessors

Each `env` entry emits exactly one accessor function. An entry declares `vars` as an **array**, because an accessor may read more than one variable: datadog's `headers()` reads `DD_API_KEY` and `DD_APP_KEY` and throws a single joint error, `"DD_API_KEY and DD_APP_KEY must be set"`. Single-variable accessors — the common case — carry a one-element array.

Observed variants, all four fixtures covered:

- **required** — `?.trim()`, throw `"<NAME> is not set"` if empty (newrelic `apiKey`, grafana `baseUrl`, sentry `org`)
- **required, multi-var** — all vars checked in one condition, joint error `"<A> and <B> must be set"` (datadog `headers`)
- **defaulted** — `process.env["X"]?.trim() || "<default>"` (sentry `SENTRY_URL`, datadog `DD_SITE`)
- **transform** — `stripTrailingSlash` → `.replace(/\/$/, "")` (grafana, sentry)
- **prefix / suffix** — wrap the result (sentry `/api/0`, datadog `api.` host prefix)
- **auth: bearer** — returns `{ Authorization: \`Bearer ${t}\`, Accept: "application/json" }` (grafana, sentry)
- **auth: headers** — returns a record of named headers, one per var (datadog `DD-API-KEY` / `DD-APPLICATION-KEY`; newrelic's `X-Api-Key`, which is inlined into the fetch helper rather than given its own accessor)

The error-message wording is derived, not spec-supplied: one var yields `"<NAME> is not set"`, multiple yield `"<A> and <B> must be set"`. Both forms are observed verbatim in the fixtures.

#### Accessor pipeline order

The stages compose in exactly this order, and the order is **not** configurable:

```
read process.env["<VAR>"]
  -> ?.trim()
  -> default  (|| "<default>")   XOR   required check (throw if undefined or "")
  -> transform (stripTrailingSlash)
  -> prefix / suffix
  -> auth wrapper (bearer | headers)
```

`default` and the required check are mutually exclusive: an entry with a `default` can never be empty, so emitting a throw would be dead code. The schema rejects an entry declaring both.

Transform-before-suffix is not a coin flip — the fixtures decide it. `sentry`'s `apiRoot()` reads:

```ts
const u = process.env["SENTRY_URL"]?.trim() || "https://sentry.io";
return `${u.replace(/\/$/, "")}/api/0`;
```

The strip applies to the env-derived value only; the `/api/0` suffix is appended afterwards and is never itself stripped. Applying the suffix first would corrupt it. `datadog`'s `siteHost()` (`` `api.${s}` `` after trim-and-default) and `grafana`'s `baseUrl()` (required check, then strip, no suffix) are consistent with the same pipeline.

### Fetch helper

Style-dependent, with a small set of knobs drawn from observed variation:

- base URL: literal (`newrelic`), env accessor (`grafana`, `sentry`), or computed host (`datadog`'s `https://${siteHost()}`)
- headers: inline object (`newrelic`) or an accessor call (`datadog`, `grafana`, `sentry`)
- error snippet length: uniformly 400 across all four fixtures — a constant, not a knob
- `normalizeLeadingSlash` — grafana only
- `jsonFallbackRaw` — grafana only, returns `{ raw: text }` on parse failure

The last two are single-fixture flags. See "Spec cosmetics policy" for why they are permitted and where the line is.

## Spec validation

Validation runs before any emission. A spec that would produce broken, shadowed, or silently-incomplete output is rejected with a message naming the offending field — the generator never emits code it knows is wrong.

### Identifier uniqueness

Every identifier the emitter introduces lives in one flat namespace per generated file, and all must be distinct. That covers:

- **spec-supplied names** — each `env[].local`, `fetchHelper.local`, and each hoisted `args[].local`
- **reserved emitter names** — `mcp`, `server`, `reg`, `transport`, `z`, `jsonResult`, `p`, `parsed`, plus the imported `createRegisterSimpleTool`, `createZodToolRegistrar`, `makeRestToolRegistrar`, and the Style-R `register<Title>Tool`

Hoisted argument locals live in handler scope but are checked against the **whole** module namespace, not just the names a given tool's path happens to reference. This is stricter than strictly necessary and deliberately so: the rule is one flat set-uniqueness check, which is far easier to reason about — and to trust — than a per-tool reachability analysis.

The failure this prevents is not hypothetical. `sentry` declares a module-scope accessor `org()`. A tool declaring `{ "limit": { "local": "org", "default": 20 } }` would hoist `const org = p.limit ?? 20`, shadowing the accessor, so `${env.org}` would emit `org()` — a call on a number. `tsc` would eventually catch that, but only for someone who runs it; validation catches it at the source with a message that says which two fields collided.

### Strict schemas

All Zod object schemas in the spec are `.strict()`. Any unknown key is a validation error.

This is how out-of-scope features fail fast, and it generalises better than enumerating them: a tool declaring `method`, `body`, `hitl`, or any other Stage B/C field is rejected because Stage A's schema has no such key. Known-future keys additionally get a targeted message — `"method" is not supported in Stage A (non-GET tools are out of scope); use "impl": "stub"` — so the error explains the boundary rather than just reporting a typo.

Note the deliberate choice: a tool declaring a non-GET method is a **hard error, not an automatic downgrade to `"impl": "stub"`**. Auto-stubbing would emit a connector silently missing functionality its author explicitly requested, and the stub count in the harness report would understate the gap. Making the author write `"impl": "stub"` themselves keeps the omission intentional and visible.

## Formatting

The emitter never hand-formats. `newrelic`'s two `reg(...)` calls are formatted differently from each other — one collapsed onto three lines, one fully expanded — purely because of 100-column line-breaking. Reproducing that by hand is a losing game. Since the fixtures are themselves Biome output, running both sides through the same normal form makes byte-equality reachable, and generated connectors pass `biome check` by construction rather than by luck.

**Formatting runs in-process via WASM, not by shelling out.** `formatAll` uses `@biomejs/js-api` (v6) with the `@biomejs/wasm-nodejs` backend. No child process, no `biome` binary on `PATH`, no dependence on the caller's working directory or on a `biome.json` being discoverable — the configuration is applied programmatically:

```
indentStyle: space, indentWidth: 2, lineWidth: 100, lineEnding: lf
quoteStyle: double, trailingCommas: all, semicolons: always
```

Shelling out to the CLI was rejected: it would make the generator depend on an external executable and on config-file discovery, and would fold process-spawn failures into every code path.

### Version pinning

The monorepo pins `@biomejs/biome: ^2.5.6` in its root `package.json`. (The `2.5.0` in `biome.json`'s `$schema` URL is the *schema* version and is not the tool pin — do not key off it.) This repo pins `@biomejs/wasm-nodejs` to the same `^2.5.6` line, which satisfies `js-api@6`'s `^2.5.0` peer range.

Formatter output can change between Biome minor versions. The harness therefore prints the resolved Biome version in its report, and treats a mismatch against the monorepo's installed version as a warning — a diff observed under a different formatter version is not trustworthy evidence either way.

## The golden-fixture diff harness

```
bun run diff:golden                              # all fixtures
bun run diff:golden sentry --nimbus-root D:\Nimbus
```

### Locating the monorepo

Resolution order, all platform-neutral:

1. `--nimbus-root <path>`
2. `$NIMBUS_ROOT`
3. a sibling of this repository named `Nimbus` or `nimbus` — i.e. `<repo>/../Nimbus`, resolved from the script's own location, not from `process.cwd()`

No absolute path is hardcoded. The earlier draft's `C:\gitrep\Nimbus` fallback baked one developer's Windows layout into the tool and would fail confusingly on macOS and Linux; the sibling probe covers the same real-world layout without naming a drive.

Whichever candidate is chosen must contain the marker file `packages/mcp-connectors/shared/mcp-tool-kit.ts`. A path that exists but lacks the marker is rejected as "not a Nimbus checkout" rather than producing a wall of missing-fixture errors — this is what catches a stale `$NIMBUS_ROOT` pointing at a moved or renamed directory.

**If no candidate resolves, the harness prints every path it tried, states which check each one failed, and exits 1.** It is a standalone script, not a `bun:test` file, deliberately: `test/sandbox.test.ts` in the monorepo is wrapped in `describe.skipIf(!process.env["NIMBUS_TEST_HARNESS"])` and that variable is set nowhere in `.github/`, `scripts/`, or `package.json` — all 79 of those tests skip on every CI run. That is the exact false-green this harness must not reproduce.

Per fixture it reports each of the six files as identical / differing (with a unified diff) / missing, plus a stub count, and compares the *set* of byte-identical file paths against `fixtures/expectations.json`. It exits non-zero if any fixture **diverges from its declared expectation in either direction** — a file that stopped matching, or one that newly matches without being declared, either of which means the expectations file and the criterion-2 gap report have gone stale. Comparing the set rather than a count is what makes a count-preserving swap (one file newly matching while another breaks) a failure instead of a silent PASS. A fixture with no declared expectation throws rather than defaulting to a passing value. This is an expectation check, not an allow-list: nothing is forgiven, only recorded.

## Acceptance criteria

1. `bun run diff:golden` reports **zero diff across all six files** for `newrelic`, `datadog`, `grafana`, and `sentry` — or a written justification in this document for every residual diff.
2. `discord` and `google-meet` are attempted as Style-R fixtures. Whatever they do not reach is documented here as a known gap, not quietly dropped.
3. A newly generated connector, placed in `packages/mcp-connectors/`, passes `tsc --noEmit` and `biome check` inside the monorepo with no manual edits.
4. Its README passes `bun run audit:package-readmes`.
5. The emitters have unit tests that do not require the monorepo, so this repo's CI is meaningful on its own.

   **What CI actually covers.** `.github/workflows/ci.yml` runs three gates on every push and pull request: `bun test`, `bunx tsc --noEmit`, and `bunx biome check src/ test/ scripts/`. It does **not** run `diff:golden` or `acceptance` — both need a Nimbus checkout that is not present on a runner, and vendoring one was rejected in D4. So the project's most valuable test, the byte diff against real connectors, is a local pre-merge gate rather than a CI check. That is a real limitation and is stated here rather than implied by a green badge.

Note that criterion 3 is the real functional bar. Contract tests are explicitly **not** an acceptance signal — see the harness section.

### Acceptance criteria — results (2026-07-30, Task 18)

Measured against `C:\gitrep\Nimbus`, Biome `2.5.6`, Bun `1.3.14`.

**Criterion 1 — PASS.** `bun run diff:golden --nimbus-root C:\gitrep\Nimbus`. `newrelic`, `datadog`, `grafana`, and `sentry` each report `PASS  <name>  6/6 files identical` with no residual diff.

**Criterion 2 — PASS (gap documented, not closed).** Same command; `discord` reports `PASS  discord  3/6 files identical (expected partial, 1 stub tool(s))` and `google-meet` reports `PASS  google-meet  2/6 files identical (expected partial, 2 stub tool(s))`, matching the file sets declared in `fixtures/expectations.json` and the per-file gap tables below. The harness would fail the run if either set drifted in either direction; it did not.

**Criterion 3 — PASS.** `bun run acceptance C:\gitrep\Nimbus` (`scripts/acceptance.ts`) generates the `zzscratch` fixture (`fixtures/zzscratch.spec.json`) into `packages/mcp-connectors/zzscratch/` inside the live monorepo and runs the monorepo's own toolchain against it, with a `try/finally` that removes the scratch connector regardless of outcome:

```
PASS  tsc --noEmit
PASS  biome check
PASS  audit:package-readmes
PASS  monorepo working tree clean

All acceptance checks passed.
```

Cleanup-under-failure was verified separately, not assumed: a temporary `throw` was inserted into `scripts/acceptance.ts` immediately *after* `writeFiles(...)` (i.e. after the scratch connector's six files already existed on disk inside the Nimbus checkout) and the harness was re-run. It exited non-zero (`error: script "acceptance" exited with code 1`) and `git -C C:\gitrep\Nimbus status --short packages/mcp-connectors/` was still empty — the `finally` block removed the on-disk files before the process exited. The injected throw was then reverted and the harness re-run clean (all four `PASS` lines again), confirming this repo's own `git status` and the Nimbus checkout's `git status` were both clean afterward.

**Criterion 4 — PASS.** Folded into the criterion-3 run above: `PASS  audit:package-readmes` is `bun run audit:package-readmes` (`scripts/audit/package-readmes.ts` in the monorepo) run against the full `packages/mcp-connectors/` tree including the generated `zzscratch/README.md`, with exit 0.

**Criterion 5 — PASS.** `bun test` — 174 pass, 0 fail, across 17 files, with no `NIMBUS_ROOT` set and no Nimbus checkout required (the golden-harness and acceptance scripts are separate entry points, not part of the `bun:test` suite).

**On `fixtures/zzscratch.spec.json` and the golden harness:** this fixture is purpose-built for criterion 3, not criterion 1 — there is no real `zzscratch` connector in the monorepo to diff against. Rather than exempting it from `scripts/diff-golden.ts`'s directory scan (which would let an undeclared fixture silently bypass the expectations check the harness exists to enforce), it is declared in `fixtures/expectations.json` as `"zzscratch": []`. The harness reports it as `PASS  zzscratch  0/6 files identical (expected partial)` with all six files listed `MISSING — not present in the real connector`, which is the correct and expected verdict for a fixture with no real counterpart, not a bypass.

### Criterion 2: `discord` and `google-meet` gap report

Both fixtures (`fixtures/discord.spec.json`, `fixtures/google-meet.spec.json`) are `style: "rest-kit"`, modelled directly on `packages/mcp-connectors/{discord,google-meet}/src/server.ts` and `nimbus.extension.json` in the monorepo. Neither reaches zero diff, by design — Task 16 exists to characterise the gap, not close it. `bun run diff:golden discord google-meet --nimbus-root <root>` reports:

The exact sets of byte-identical files below (3/6 and 2/6) are checked in as machine-readable expectations in `fixtures/expectations.json`. The harness (`scripts/diff-golden.ts`) fails the run if reality diverges from a declared set **in either direction** — including an unexpected improvement, and including a swap that leaves the count unchanged — so this table cannot silently drift out of date; closing any part of the gap requires updating both the expectation and this section in the same change.

**`discord` — 3/6 files identical, 1 stub tool**

| File | Result | Blocking construct |
|---|---|---|
| `src/server.ts` | DIFF | The hand-written `discordFetch` sends `Authorization: \`Bot ${token}\`` plus a static `"User-Agent"` header; the rest-kit `FetchHelperSchema` has no `authScheme` field (bearer is hardcoded in `renderRestKitFetchHelper`) and no way to add a header that isn't `${env.X}`-templated, since the schema explicitly forbids `${env.*}` references in a rest-kit `fetchHelper` (the token is resolved by `makeRestToolRegistrar`, not an env accessor). Also, `discord_channel_messages` builds its path with `new URL(...)` plus conditional `u.searchParams.set(...)` calls (an `after` param only added `if (parsed.after !== undefined && parsed.after !== "")`) — the D3 path-template DSL renders one fixed template string per tool and cannot express conditional query-parameter inclusion, so this tool is `"impl": "stub"`. |
| `package.json` | DIFF | Real file adds a `"bin": { "nimbus-mcp-discord": "./dist/server.js" }` entry and `"dev"`/`"build"` scripts (`bun build --compile --outfile`) for standalone-binary distribution; `emitPackageJson` only emits `typecheck`/`lint`/`test`/`clean`. Standalone distribution is out of Stage A scope (see "Out of scope"). |
| `nimbus.extension.json` | DIFF | Real manifest declares `"hitlRequired": ["write", "delete"]`; `emitManifest` always emits `"hitlRequired": []` — HITL population is explicitly Stage C (see "Out of scope" and `OUT_OF_SCOPE_TOOL_KEYS` in `src/spec.ts`). |
| `tsconfig.json` | identical | — |
| `README.md` | identical | Discord's hand-written README happens to be exactly the generic boilerplate `emitReadme` produces. |
| `test/sandbox.test.ts` | identical | — |

**`google-meet` — 2/6 files identical, 2 stub tools**

| File | Result | Blocking construct |
|---|---|---|
| `src/server.ts` | DIFF | Real `meetFetch` delegates to `fetchBearerAuthorizedJson` + `resolveUrlWithBase` imported from `shared/fetch-bearer-json.ts` — a different, more-shared fetch primitive than the self-contained helper `renderRestKitFetchHelper` emits; the emitter models exactly one rest-kit fetch-helper shape and has no spec field selecting an alternate shared module. `google_meet_list` and `google_meet_search` both build their path with `new URL(...)` + conditional `searchParams.set(...)` (optional `pageToken`, and for search an optional `filter`) — the same conditional-query-parameter construct as discord's stub tool, outside the D3 path-template DSL — so both are `"impl": "stub"`. Only `google_meet_get` (a plain `/conferenceRecords/${id}` path, no query string) reaches full expression. |
| `package.json` | DIFF | Same `bin` + `dev`/`build`-script gap as discord, for the same reason (standalone-binary distribution, out of scope). |
| `tsconfig.json` | DIFF | Real file adds `"../shared/**/*.ts"` to `"include"` because `server.ts` imports `shared/fetch-bearer-json.ts` directly; `emitTsconfig` emits a fixed `["src/**/*"]` and has no notion of a per-connector extra include, which is downstream of the fetch-helper gap above, not a separate cause. |
| `README.md` | DIFF | Real README is several paragraphs of hand-authored product prose (OAuth scope, gateway-side sync behavior, a vault-key table) — `emitReadme` only ever produces the fixed four-section boilerplate. No boilerplate rewording closes this; it is a content gap, not a formatting one. |
| `nimbus.extension.json` | identical | Google Meet's real manifest has `"hitlRequired": []` already, so the Stage-C gap above happens not to surface here. |
| `test/sandbox.test.ts` | identical | — |

No emitter bug was found or fixed while producing these two fixtures. Every diff traces to one of: (a) a fetch-helper shape the rest-kit schema does not model (auth scheme / extra static header / an alternate shared fetch module), (b) a path-building construct (`new URL()` + conditional `searchParams`) outside the D3 boundary, or (c) manifest/package.json surface explicitly deferred to Stage B/C. `registerDiscordTool`'s factory block and both non-stub tool registrations are byte-identical to the real file, confirming the `makeRestToolRegistrar` wiring itself is correct; `google-meet`'s registrar name (`registerGoogleMeetTool`, from the fixed `register${title}Tool` formula) does not match the real hand-picked short name `registerMeetTool` — a cosmetic author choice, not something the formula can or should chase without a new naming-override field. Two additional per-connector authoring choices were confirmed, by grepping every monorepo connector that calls `makeRestToolRegistrar`, to be genuine style variance rather than bugs: the wiring line (`const reg = createZodToolRegistrar(createRegisterSimpleTool(server));` one-liner vs. a `registerSimpleTool` intermediate + blank line) and the tail (`const transport = ...; await server.connect(transport);` vs. inline `await server.connect(new StdioServerTransport());`) are each used by roughly half of the real rest-kit connectors (e.g. `github-actions`/`outlook` match the emitter's one-liner wiring exactly; `gmail`/`onedrive`/`outlook`/`google-photos`/`google-meet` use the inline tail while `github`/`circleci`/`pagerduty`/`discord` use the two-line form) — so there is no single "correct" idiom to converge on, and the emitter's fixed choice is left as-is.

## Spec cosmetics policy

Byte-exactness forces some cosmetics into the spec. Real connectors hoist defaulted args to local consts with human-chosen abbreviations: `const lim = p.limit ?? 10` (datadog), `const q = p.query ?? ""` (grafana), `const only = p.only_open === true ? "true" : "false"` (newrelic). There is no derivable rule — `limit`→`lim` and `query`→`q` are taste. The same applies to accessor names (`headers` vs `authHeaders`) and fetch-helper names (`nrGet`, `ddGet`, `grafanaGet`, `sentryGet`).

There is a second instance of the same axis inside accessors. Each reads its env var into a short internal binding, and those are equally hand-chosen: `k` (newrelic), `s`/`ak`/`app` (datadog), `u`/`tok` (grafana), `u`/`o`/`t` (sentry). Hence the `bindings` array, parallel to `vars`, defaulting to `camelCase(<VAR_NAME>)`.

The policy: **`local` and `bindings` are permitted everywhere as optional strings defaulting to a sensible derivation.** Beyond that, the two grafana-only flags (`normalizeLeadingSlash`, `jsonFallbackRaw`) are accepted because they change behaviour, not just appearance. If any further fixture requires a new purely-cosmetic field to reach zero diff, it is recorded as a documented irreducible diff instead of growing the spec. Spec surface is the cost being controlled here; a generator whose input is harder to write than the output is a failed generator.

## Out of scope

Write tools, non-GET methods, request bodies, `hitlRequired` population. Multi-fetch, paginated, and multi-step tools. GraphQL (`linear`), IMAP, and CLI-backed (`azure`, `gcp`, `kubernetes`, `iac`) connectors. The per-connector `src/search-filter.ts` second file, present in 49 connectors. Standalone / `bunx` distribution. Gateway wiring (sync handlers, catalog, connector-secrets-manifest, rate-limiter).

### Considered and deferred: reverse spec generator

A utility that parses an existing `src/server.ts` back into a draft `ConnectorSpec` — bootstrapping fixture specs automatically instead of by hand, and plausible for Style R connectors given how declarative `makeRestToolRegistrar` already is.

Deferred, for two reasons. First, YAGNI at this scale: Stage A has **six** fixtures, and hand-writing six spec files is perhaps an hour of work, whereas a reverse parser is a real component — AST handling or a regex scanner that must itself be tested, and one whose failure mode is a *plausible but subtly wrong* spec that then poisons the diff harness's verdict. Second, it inverts the trust relationship the harness depends on: the harness is meaningful precisely because the spec is an independent statement of intent that we then check the real connector against. Deriving the spec *from* the connector makes agreement partly self-fulfilling and weakens the signal.

It becomes genuinely attractive in Stage C, where the task is surveying the unmeasured OAuth and write-tool tail across dozens of connectors — the scale at which hand-writing stops being viable and where its output would be an input to analysis rather than to an acceptance test. Revisit it there.

## Risks

| Risk | Mitigation |
|---|---|
| Path-template DSL creeps toward a general language | D3 boundary is a hard rule; stubs are the escape valve, and stub counts are reported per fixture |
| Only 4 of 94 connectors are byte-reproducible under D3 | Accepted and stated plainly. The four are the prompt's own starting ladder; coverage growth is Stage C's problem, not a reason to widen Stage A |
| Biome version drift between this repo and the monorepo changes formatting | Pin `@biomejs/wasm-nodejs` to the monorepo's `^2.5.6` line; the harness prints the resolved version and warns on mismatch, since a diff measured under a different formatter is not evidence |
| The harness cannot run in this repo's CI (no monorepo) | Accepted per D4. CI (`.github/workflows/ci.yml`) runs tests, typecheck and lint only; the byte-diff harness and the monorepo acceptance check are local pre-merge gates and are **not** covered by CI. A green CI badge on this repo does not mean the fixtures still match |
| Generated connectors drift as the monorepo's shared kit evolves | The harness *is* the drift detector — running it against a newer monorepo surfaces divergence immediately |

## Open questions deferred to Stage B

- Distribution: inline the dep-free `mcp-tool-kit.ts`, publish it as `@nimbus-dev/sdk/connector-kit`, or a hybrid. `mcp-tool-kit.ts` is deliberately dependency-free (it structurally types Zod rather than importing it) so it *can* move into the zero-dependency SDK; `run-read-only-mcp-connector.ts` imports `@modelcontextprotocol/sdk` directly and cannot.
- Whether generated standalone packages keep `style: "rest-kit"`, given that `rest-tool-kit.ts` itself depends on `fetch-bearer-json.ts` and `mcp-tool-kit.ts`.
