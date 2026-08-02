# Glossary

Terms as this repository uses them. Where a word means something narrower here than it does
generally, the narrow meaning is the one that matters.

## The generator

**Spec** — a `ConnectorSpec`: the JSON description of a connector, parsed and validated by
`src/spec.ts`. The generator's only input. Reviewable, diffable, and the unit of reuse.

**Target** — `"monorepo"` or `"standalone"`. The seam that decides where a connector lives and
where it imports its helpers from. Threaded through the emitters as a parameter, never global.

**Style** — how a connector registers its tools, and the field with the widest blast radius:

- `rest-kit` — `makeRestToolRegistrar` does the fetching and result-wrapping. Cannot do OAuth
  or search: it performs the request and wraps the result itself, leaving no seam for either.
- `hand-rolled` — the connector builds its own `McpServer`, registrar and fetch helper.
- `read-only-kit` — as `hand-rolled`, but the registrations are wrapped in
  `runReadOnlyMcpConnector`. The shape 60 of the 94 corpus connectors use.

**Impl** — a tool's kind: `rest` (one HTTP request), `search` (substring search over rows),
`stub` (a typed handler that throws). `get` is a deprecated alias for `rest`.

**Effect** — a tool's declared intent: `read`, `write` or `delete`. Drives the manifest's
`hitlRequired`. Deliberately **not** derived from the HTTP method — in the corpus a POST is
often a query, not a mutation.

**Emitter** — a module under `src/emit/` that turns a spec into one file's source. Returns
**unformatted** text; `formatAll()` runs real Biome over it.

**Reserved identifier** — a name the emitter itself declares in generated source, so a spec may
not reuse it. `RESERVED_IDENTIFIERS` in `src/validate.ts` is authoritative.

**Fixture** — a hand-written spec in `fixtures/`. Named after a real connector when it targets
byte reproduction (`mercury`), or prefixed `zz` when it is synthetic and matches nothing
(`zzsearch`).

**Expectation** — the per-fixture list in `fixtures/expectations.json` of files expected to
match the real connector. An empty list means "nothing should match" — the correct answer for a
synthetic fixture. **Never edited to hide a mismatch**; a file that cannot match is omitted so
the gap shows on every run.

## Verification

**Golden fixture / byte reproduction** — generating from a fixture spec and diffing the output
against the real connector in a Nimbus checkout. The acceptance test for the template itself.

**Byte-safety invariant** — `newrelic`, `datadog`, `grafana` and `sentry` reproduce 6/6 files
and must stay there. Every new emitter path is gated on a field those four never set.

**False green** — a check that passes while asserting nothing. This repo's recurring concern;
several gates exist because a weaker version of them was vacuous. The generated
`test/sandbox.test.ts` skipping on every CI run is the canonical example.

**Registry mode vs local-checkout mode** — the two questions `standalone-acceptance` can answer.
`--registry` installs the *published* SDK and can catch a `dist` missing from the tarball;
local-checkout rewrites the dependency to `file:` and proves an *unreleased branch* satisfies
the contract. Reporting one as the other is a false green.

**Skipped fixture** — in registry mode, a fixture whose declared SDK floor is not published yet.
Reported as `SKIP` with the version named, because the question is unanswerable rather than
answered "no". A run with skips does not print the sentence a fully-verified run prints.

**Stub tool** — a tool the spec language cannot express, declared `impl: "stub"` and emitted as
a typed handler that throws. An honest gap, not a silent guess or a dropped tool.

## Nimbus

**Connector** — a package under `packages/mcp-connectors/<name>/` exposing a service's data to
Nimbus as MCP tools over stdio.

**Manifest** — `nimbus.extension.json`: id, display name, `permissions.network`, `hitlRequired`,
`syncInterval`, runtime.

**HITL** — human-in-the-loop. A capability in `hitlRequired` means the gateway gates that class
of action behind user approval.

**The kit** — the shared connector helpers. Published as `@nimbus-dev/sdk/connector-kit`;
mirrored in the monorepo at `packages/mcp-connectors/shared/*` as named re-exports.

**Gateway wiring** — the type-coupled registration a first-party connector needs *outside* its
package: a sync handler in `packages/gateway/src/connectors/`, plus catalog, secrets-manifest
and rate-limiter entries. Not generated; the CLI prints a verified checklist instead.

**Sandbox test** — `test/sandbox.test.ts`, identical across 79 connectors and wrapped in
`describe.skipIf(!process.env["NIMBUS_TEST_HARNESS"])`. That variable is set nowhere in Nimbus,
so it skips everywhere. Emitted to match the corpus, not as evidence.

## The three repos

| Repo | License | Role |
| --- | --- | --- |
| `create-nimbus-connector` | MIT | this generator |
| [`Nimbus`](https://github.com/nimbus-agent/Nimbus) | AGPL-3.0-only | gateway, apps, 94+ connectors |
| [`nimbus-sdk`](https://github.com/nimbus-agent/nimbus-sdk) | MIT | publishes `@nimbus-dev/sdk` |

The MIT/AGPL split is load-bearing: **no Nimbus source may be copied into this repository.**
The harnesses read a checkout at runtime instead.
