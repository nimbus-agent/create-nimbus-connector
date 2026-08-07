---
name: cnc-add-fixture
description: >
  The golden-fixture workflow: transcribing a real Nimbus connector into a spec,
  closing the byte diff, and documenting what is irreducible instead of forcing a
  match. Use when adding a fixture to fixtures/, raising byte-reproduction
  coverage, or when a fixture's diff will not close.
---

# Adding a golden fixture

A golden fixture is a hand-written spec that targets a real Nimbus connector. Generating from
it and diffing against the real directory is the acceptance test for the *template* — where the
diff is irreducible, that is either a spec field the template must expose or an honest
limitation to document.

**This is the highest-value work in the repo and also the easiest to fake.** The whole exercise
is worthless if a diff is closed by weakening the expectation rather than by fixing the emitter.

## Before you start

**Never copy connector source into this repository.** Nimbus is AGPL-3.0-only and this repo is
MIT. Read the real connector, transcribe its *parameters* into a spec, and let the harness read
the original from a path at runtime. Descriptions and tool names are parameters — copying a
`server.ts` is not.

Pick a target that adds an axis. A fifth connector identical in shape to `newrelic` proves
nothing new; one with a shape no fixture covers proves something.

## The loop

**1. Read the real connector.**

```
C:\gitrep\Nimbus\packages\mcp-connectors\<name>\src\server.ts
C:\gitrep\Nimbus\packages\mcp-connectors\<name>\nimbus.extension.json
```

Note its style (does it call `runReadOnlyMcpConnector`?), its auth shape, whether handlers are
expression-bodied or block, whether arg schemas are one-line or expanded, and whether it hoists
a base URL const. Those last three are `handlerStyle`, `argsSchemaStyle` and
`fetchHelper.baseConst` — per-connector conventions that are pure bytes.

**2. Write `fixtures/<name>.spec.json`.** Follow the shape of an existing fixture of the same
style. **Copy tool descriptions verbatim** — they are part of the bytes being matched.

**3. Declare the expectation.** Add an entry to `fixtures/expectations.json` listing the files
you expect to match. Start optimistic — list all six or seven — and let the harness tell you
which do not.

**4. Diff, and read the output.**

```bash
bun run diff:golden --nimbus-root C:/gitrep/Nimbus
```

**5. Close each difference at its source.** Every remaining diff is exactly one of three things:

- **A spec field you did not set.** Most common. Fix the spec.
- **A real emitter defect.** Fix it in the owning module, gated so the four locked fixtures
  cannot move, with a unit test.
- **Genuinely irreducible.** Document it. Remove that file from the expectation entry so the
  gap is on screen on every run, and add it to
  [`docs/ROADMAP.md`](../../docs/ROADMAP.md)'s **Known limitations** section with the reason.

**6. Confirm nothing else moved.** `newrelic`, `datadog`, `grafana` and `sentry` must still
report `6/6`.

## The line you do not cross

**Never remove a file from an expectation entry to make a failing diff disappear.** Removing a
file is a claim: *"this file can never match, and here is why."* It is legitimate only when the
reason is structural and written down.

Real examples of legitimate omissions, each recorded under
[Known limitations](../../docs/ROADMAP.md#known-limitations):

- `README.md` for `mercury`, `zendesk`, `bitrise` — all three carry hand-written prose naming
  their specific item types and deferred follow-ups. No spec field derives it.
- `test/sandbox.test.ts` for `bitrise` — the real package **does not contain one**. 15 of the 94
  connectors lack it. The harness reports `MISSING`, not `DIFF`.

"It did not match and I could not work out why" is not in that category.

## Synthetic fixtures

A `zz`-prefixed fixture matches no real connector and declares `[]`, meaning "nothing should
match" — the correct answer, not a gap. They exist to exercise paths the corpus cannot reach,
or to be compiled and executed by the standalone harness.

Add one to `scripts/standalone-acceptance.ts`'s `FIXTURES` array when the path it covers needs
a real `tsc`, a real `biome`, and a server that actually answers `tools/list`. That harness has
caught defects — unused imports, unresolvable specifiers, import ordering — that no substring
assertion in `test/` could see.

## When a tool cannot be expressed

Declare it `impl: "stub"`. The verdict line then prints `N stub tool(s)`, which is an honest
signal rather than a hidden gap. Do **not** contort the spec language for one connector; a
conditional-path or enum-argument feature designed against a single example is a change to what
a connector spec *is*, and needs its own design.
