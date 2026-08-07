<!--
Conventional Commits drive the release. The PR title becomes the squashed subject:
  fix:  patch    feat:  minor    feat!: / BREAKING CHANGE:  major
  docs: test: chore: refactor: style:  no release
-->

## What and why

<!-- What changes, and what made it necessary. If a corpus measurement motivated it, give the
     number and how you counted — that is the currency this repo trades in. -->

## Gates

CI cannot run the **four** gates that need a Nimbus checkout. Run them locally and paste the real
output — not a summary, and not copied from a plan.

`bun run preflight --nimbus-root <path>` runs the first eight boxes in order and names any it
could not run. Tick that one and paste its verdict, or tick them individually.

- [ ] `bun run preflight --nimbus-root <path>` — and it printed the **fully verified** sentence
- [ ] `bun test`
- [ ] `bunx tsc --noEmit`
- [ ] `bunx biome check src/ test/ scripts/`
- [ ] `bun test --coverage` (the per-file floors; a bare `bun test` does not evaluate them)
- [ ] `bun run diff:golden --nimbus-root <path>` — **`newrelic`, `datadog`, `grafana` and
      `sentry` still `6/6`**
- [ ] `bun run reach --baseline --nimbus-root <path>` — no connector lost a tier
- [ ] `bun run wiring:conformance --nimbus-root <path>` (if the wiring skeleton changed)
- [ ] `bun run acceptance <nimbus-root>` (if emission changed)
- [ ] `bun run standalone-acceptance --registry` (if standalone emission changed)
- [ ] `bun run runtime:acceptance --registry` (if auth, bodies or path encoding changed)

<details><summary>Output</summary>

```
```

</details>

If a gate could not run, say which and why. **Do not substitute a weaker gate that passed** —
in particular, a local-checkout `standalone-acceptance` run is not a `--registry` run, and
reporting it as one is a false green.

## Emitted-byte changes

- [ ] This changes the bytes a generated connector contains

If checked: describe the diff an existing user sees when they regenerate, and add it to the
`Unreleased` section of `CHANGELOG.md`. Release-please derives its notes from commit subjects,
which will not mention this.

## Spec compatibility

- [ ] A spec that parsed before still parses

If not — a new reserved identifier, a new refinement — name the field and the fix, and record
it in `CHANGELOG.md`.

## Checklist

- [ ] New emitter paths are gated on a field the four locked fixtures never set
- [ ] Any new module-scope name the emitter declares is in `RESERVED_IDENTIFIERS`
- [ ] `fixtures/expectations.json` was **not** edited to hide a mismatch
- [ ] Comments explain *why*, and cite the measurement where there is one
- [ ] No Nimbus (AGPL) source was copied into this repo
