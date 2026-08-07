---
name: cnc-preflight
description: >
  How to verify a create-nimbus-connector change before pushing: the full gate
  list, which gates CI cannot run, and which ones can pass while proving nothing.
  Use when the user asks "what should I run", "is this ready to push", "why did
  CI fail", "run the gates", "preflight", or before claiming any change works.
---

# create-nimbus-connector — Pre-flight

**There is no `preflight` script.** The gates are separate commands, four of them need a
Nimbus checkout, and two of them answer different questions that are easy to conflate. Run
them in this order.

## 1. The gates CI also runs

```bash
bun test
bunx tsc --noEmit
bunx biome check src/ test/ scripts/
```

`bun test` includes `test/emit/emitted-typecheck.test.ts`, which compiles emitted output with
the real TypeScript compiler. That is the one that catches an unbalanced brace or an unused
import in generated source — substring assertions cannot.

`biome check` reporting `Found N infos` is **not** a failure. Infos are pre-existing
`useLiteralKeys` / `useTemplate` notes. Only errors fail.

## 2. The gates CI cannot run

These need a checkout of the AGPL Nimbus monorepo, which CI does not have and this MIT repo
must not vendor. **They are local pre-merge gates. Do not add a CI job that skips when the
root is absent** — a silently-skipping gate reads as coverage while asserting nothing.

```bash
bun run diff:golden --nimbus-root C:/gitrep/Nimbus
bun run reach --baseline --nimbus-root C:/gitrep/Nimbus     # if src/ changed
bun run acceptance C:/gitrep/Nimbus            # if emission changed
bun run wiring:conformance --nimbus-root C:/gitrep/Nimbus   # if wiring changed
```

**`diff:golden` is the gate that matters most.** Read its output, do not just check the exit
code:

- `newrelic`, `datadog`, `grafana`, `sentry` must each report **`6/6`**. This is the
  byte-safety invariant. If one moved, a new emitter path is not gated on a spec field those
  four never set — fix the gate, do not update the fixture.
- Every other fixture must match its declared expectation. A `0/6` on a `zz*` fixture is
  correct: synthetic fixtures declare `[]` because no real connector should match them.
- The run ends `All fixtures match their declared expectations.`

**Never edit `fixtures/expectations.json` to make a diff disappear.** A file that genuinely
cannot match is omitted from the list so the gap stays on screen.

**`bun run reach --baseline` is the tier-regression gate**, and it answers a different question
from `diff:golden`: not whether one fixture's bytes match, but how far the deriver gets on each
of the 94 real connectors. It compares against `fixtures/reach-baseline.json` and exits 1 when a
connector has dropped a tier.

It exits 2 rather than comparing in three cases, and each refusal is the gate working rather
than a flag to route around: a dirty `packages/mcp-connectors`, a `connectorsTree` that differs
from the recorded one, and `--baseline` combined with connector names (a scoped run would read
every *other* baselined connector as regressed). Re-record with `bun run reach:baseline
--nimbus-root <path>` — which always measures the full corpus — and only when the corpus itself
moved. **Never edit `fixtures/reach-baseline.json` to make a regression pass**, the same rule
`expectations.json` carries.

## 3. The two standalone modes — do not confuse them

```bash
bun run standalone-acceptance --registry              # the PUBLISHED SDK
bun run standalone-acceptance C:/gitrep/nimbus-sdk    # an UNRELEASED SDK branch
```

They answer different questions:

- `--registry` installs exactly what the generator emitted, from npm. Only this mode can catch
  a `dist` missing from the published tarball's `files` array.
- Local-checkout mode rewrites the dependency to `file:` and proves an unreleased SDK branch
  satisfies the contract. It is the pre-release gate.

**Reporting a local-checkout run as though it were the registry run is a false green.** If the
registry run cannot pass — a fixture declaring an SDK floor that is not published yet — it
reports `SKIP` for that fixture and says on screen that it was not verified. A skipped run
deliberately does not print the sentence a fully-verified run prints. Quote what it actually
said.

A local run needs the SDK built (`bun run build` in the checkout) or it refuses to start.

`bun run runtime:acceptance --registry` additionally drives generated connectors against a
loopback HTTP server, asserting on the requests they actually make. Run it when auth, bodies,
or path encoding changed.

## What "it works" does not mean

- **Not** that `bun test` in a *generated* package passed. `test/sandbox.test.ts` is wrapped in
  `describe.skipIf(!process.env["NIMBUS_TEST_HARNESS"])` and that variable is set nowhere in
  Nimbus — all 79 such tests skip on every run. It is emitted to match the corpus, not as
  evidence.
- **Not** that the output "looked right". Diff it against a golden fixture and typecheck it.

## Reporting

State which gates ran and which did not, and paste real output rather than summarising it. If
a gate could not run, say so plainly instead of substituting a weaker one that passed.
