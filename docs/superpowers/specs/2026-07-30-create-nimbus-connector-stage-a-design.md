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

```ts
generate(spec: ConnectorSpec): GeneratedFile[]   // { path: string[]; content: string }[]
```

No filesystem, no `process.env`, no clock. Three consumers sit on top:

1. the interactive CLI, which writes the result to disk;
2. `--dry-run`, which prints the tree;
3. the golden-diff harness, which compares in memory against a real connector directory.

This purity is the load-bearing choice. It makes the harness a short pure-comparison script rather than a temp-dir fixture rig, and it makes every emitter unit-testable without touching disk.

### Module layout

```
src/
  spec.ts             ConnectorSpec type + Zod schema + defaults
  prompts.ts          interactive session -> ConnectorSpec
  format.ts           Biome formatting of emitted TypeScript
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
    { "vars": ["SENTRY_URL"], "local": "apiRoot", "default": "https://sentry.io",
      "transform": "stripTrailingSlash", "suffix": "/api/0" },
    { "vars": ["SENTRY_ORG_SLUG"],   "local": "org",     "required": true },
    { "vars": ["SENTRY_AUTH_TOKEN"], "local": "headers", "auth": "bearer" }
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
| `${arg.X\|bool}` | `"true"` / `"false"` | newrelic `only_open` |

An arg with a `default` (or a `bool` placeholder) is hoisted to a `const` preamble line inside the handler, named by its `local` field. This mirrors what every real connector does.

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

### Fetch helper

Style-dependent, with a small set of knobs drawn from observed variation:

- base URL: literal (`newrelic`), env accessor (`grafana`, `sentry`), or computed host (`datadog`'s `https://${siteHost()}`)
- headers: inline object (`newrelic`) or an accessor call (`datadog`, `grafana`, `sentry`)
- error snippet length: uniformly 400 across all four fixtures — a constant, not a knob
- `normalizeLeadingSlash` — grafana only
- `jsonFallbackRaw` — grafana only, returns `{ raw: text }` on parse failure

The last two are single-fixture flags. See "Spec cosmetics policy" for why they are permitted and where the line is.

## Formatting

The emitter never hand-formats. It produces semantically correct TypeScript with naive line breaks, then runs `@biomejs/biome`'s formatter over it with a config mirroring the monorepo's:

```
indentStyle: space, indentWidth: 2, lineWidth: 100, lineEnding: lf
quoteStyle: double, trailingCommas: all, semicolons: always
```

`newrelic`'s two `reg(...)` calls are formatted differently from each other — one collapsed onto three lines, one fully expanded — purely because of 100-column line-breaking. Since the fixtures are themselves Biome output, formatting both sides through the same normal form makes byte-equality reachable. It also means generated connectors pass `biome check` by construction.

## The golden-fixture diff harness

```
bun run diff:golden                              # all fixtures
bun run diff:golden sentry --nimbus-root D:\Nimbus
```

Monorepo resolution order: `--nimbus-root` → `$NIMBUS_ROOT` → `C:\gitrep\Nimbus`.

**If the monorepo cannot be found, the harness prints every path it tried and exits 1.** It is a standalone script, not a `bun:test` file, deliberately: `test/sandbox.test.ts` in the monorepo is wrapped in `describe.skipIf(!process.env["NIMBUS_TEST_HARNESS"])` and that variable is set nowhere in `.github/`, `scripts/`, or `package.json` — all 79 of those tests skip on every CI run. That is the exact false-green this harness must not reproduce.

Per fixture it reports each of the six files as identical / differing (with a unified diff) / missing, plus a stub count, and exits non-zero if any fixture regresses against a checked-in expectations file.

## Acceptance criteria

1. `bun run diff:golden` reports **zero diff across all six files** for `newrelic`, `datadog`, `grafana`, and `sentry` — or a written justification in this document for every residual diff.
2. `discord` and `google-meet` are attempted as Style-R fixtures. Whatever they do not reach is documented here as a known gap, not quietly dropped.
3. A newly generated connector, placed in `packages/mcp-connectors/`, passes `tsc --noEmit` and `biome check` inside the monorepo with no manual edits.
4. Its README passes `bun run audit:package-readmes`.
5. The emitters have unit tests that do not require the monorepo, so this repo's CI is meaningful on its own.

Note that criterion 3 is the real functional bar. Contract tests are explicitly **not** an acceptance signal — see the harness section.

## Spec cosmetics policy

Byte-exactness forces some cosmetics into the spec. Real connectors hoist defaulted args to local consts with human-chosen abbreviations: `const lim = p.limit ?? 10` (datadog), `const q = p.query ?? ""` (grafana), `const only = p.only_open === true ? "true" : "false"` (newrelic). There is no derivable rule — `limit`→`lim` and `query`→`q` are taste. The same applies to accessor names (`headers` vs `authHeaders`) and fetch-helper names (`nrGet`, `ddGet`, `grafanaGet`, `sentryGet`).

The policy: **`local` is permitted everywhere as one optional string defaulting to a sensible derivation.** Beyond that, the two grafana-only flags (`normalizeLeadingSlash`, `jsonFallbackRaw`) are accepted because they change behaviour, not just appearance. If any further fixture requires a new purely-cosmetic field to reach zero diff, it is recorded as a documented irreducible diff instead of growing the spec. Spec surface is the cost being controlled here; a generator whose input is harder to write than the output is a failed generator.

## Out of scope

Write tools, non-GET methods, request bodies, `hitlRequired` population. Multi-fetch, paginated, and multi-step tools. GraphQL (`linear`), IMAP, and CLI-backed (`azure`, `gcp`, `kubernetes`, `iac`) connectors. The per-connector `src/search-filter.ts` second file, present in 49 connectors. Standalone / `bunx` distribution. Gateway wiring (sync handlers, catalog, connector-secrets-manifest, rate-limiter).

## Risks

| Risk | Mitigation |
|---|---|
| Path-template DSL creeps toward a general language | D3 boundary is a hard rule; stubs are the escape valve, and stub counts are reported per fixture |
| Only 4 of 94 connectors are byte-reproducible under D3 | Accepted and stated plainly. The four are the prompt's own starting ladder; coverage growth is Stage C's problem, not a reason to widen Stage A |
| Biome version drift between this repo and the monorepo changes formatting | Pin `@biomejs/biome` to the monorepo's `2.5.0` and assert the version in the harness |
| The harness cannot run in this repo's CI (no monorepo) | Accepted per D4. Emitter unit tests (criterion 5) carry CI; the harness is a local/pre-merge gate |
| Generated connectors drift as the monorepo's shared kit evolves | The harness *is* the drift detector — running it against a newer monorepo surfaces divergence immediately |

## Open questions deferred to Stage B

- Distribution: inline the dep-free `mcp-tool-kit.ts`, publish it as `@nimbus-dev/sdk/connector-kit`, or a hybrid. `mcp-tool-kit.ts` is deliberately dependency-free (it structurally types Zod rather than importing it) so it *can* move into the zero-dependency SDK; `run-read-only-mcp-connector.ts` imports `@modelcontextprotocol/sdk` directly and cannot.
- Whether generated standalone packages keep `style: "rest-kit"`, given that `rest-tool-kit.ts` itself depends on `fetch-bearer-json.ts` and `mcp-tool-kit.ts`.
