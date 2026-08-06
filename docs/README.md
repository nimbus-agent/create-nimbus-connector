# create-nimbus-connector documentation

A generator for Nimbus MCP connector packages. Describe a connector as a JSON spec; get a
package byte-identical to a hand-written one.

## Start here

| If you want to | Read |
| --- | --- |
| Generate a connector | [USAGE.md](./USAGE.md) |
| Look up a spec field | the [README](../README.md) — the spec language reference |
| Understand how it is built | [ARCHITECTURE.md](./ARCHITECTURE.md) |
| Know where it is going | [ROADMAP.md](./ROADMAP.md) |
| Work on it with Claude Code | [CLAUDE.md](../CLAUDE.md) |
| Look up a term | [GLOSSARY.md](./GLOSSARY.md) |

## Project

- [CONTRIBUTING.md](../CONTRIBUTING.md) — how to propose a change
- [GOVERNANCE.md](./GOVERNANCE.md) — how decisions get made
- [RELEASING.md](./RELEASING.md) — how a version reaches npm
- [SECURITY.md](../SECURITY.md) — reporting a vulnerability, and what is in scope
- [CHANGELOG.md](../CHANGELOG.md) — including hand-written notes for output changes that no
  commit subject would surface

## Where the reasoning lives

This project was built in stages, each with a long design document and implementation plan
recording what was measured in the Nimbus corpus and what was decided. Stages A-D's four
documents have been retired — their durable conclusions are folded into the pages above, and
git history has the originals. What remains under `docs/superpowers/` is kept for one of two
reasons, and the difference matters before you start work.

**Still-live specification — not a historical record.**

- [Completing the deriver's recognizer set](./superpowers/specs/2026-08-04-completing-the-recognizer-set-design.md)
  specifies a seven-commit sequence of which only the first three have shipped. The search,
  query, body and search-filter recognizers it describes do not exist yet, which is why
  `test/derive/round-trip.test.ts` still lists 13 fixtures as blocked.
  [Its review](./superpowers/specs/2026-08-04-completing-the-recognizer-set-review.md) leaves
  two questions open against that unbuilt work.
- [Guarded accessors and the two missing frames](./superpowers/plans/2026-08-04-guarded-accessors-and-frames.md)
  executed those first three commits and carries the plan-1 / plan-2 boundary: which of the
  design's remaining work is deferred, to what, and with what connector counts. Plan 2 has not
  been written.

**Historical record, kept because each still holds something the pages above do not.**

- [Search-filter field extractors](./superpowers/specs/2026-08-02-search-filter-extractors-design.md)
  records the entry-kind options measured and declined, and the 12 → 7 → 9 corpus split that
  [ROADMAP § Measuring reach](./ROADMAP.md#measuring-reach) later corrected again, to 26;
  [its plan](./superpowers/plans/2026-08-02-search-filter-extractors.md) records the task
  breakdown.
- [Conditional query parameters](./superpowers/specs/2026-08-02-conditional-query-params-design.md)
  records six alternatives measured and declined — a path-DSL optionality marker, setting every
  parameter unconditionally, a `default` field on the query entry, an inline-default knob, a
  `!== null` clause on the `"empty"` guard, and renaming the emitted `u` local — plus the
  caution against publishing its six-connector figure as a corpus number without reading every
  file. [Its plan](./superpowers/plans/2026-08-02-conditional-query-params.md) records two
  review suggestions declined with precedent rather than preference.
- [Corpus reach measurement](./superpowers/specs/2026-08-03-from-connector-reach-design.md) is
  the design the recognizer-set work follows from. Its *Not built — plan 2's territory*
  paragraph names the five recognizer modules it deferred and is kept as a record of what that
  plan built, so it is amended rather than rewritten as those modules land.
  [Its plan](./superpowers/plans/2026-08-03-reach-measurement-harness.md) is the only tracked
  account of how the harness was built — the fix ledger from its execution is gitignored and
  does not ship — and its *Refinement of the spec* section records the one deliberate deviation
  the design above still states the old way (`Derivation.spec` is `Record<string, unknown>`,
  not `ConnectorSpec`).

**Everything else that was folded out** lives on the pages above:

- **What the generator cannot do, and why** → [ROADMAP.md § Known limitations](./ROADMAP.md#known-limitations)
- **Proposals measured and rejected** → [ROADMAP.md § Considered and declined](./ROADMAP.md#considered-and-declined)
- **How each harness works and what it proves** → [ARCHITECTURE.md § The verification layers](./ARCHITECTURE.md#the-verification-layers)
- **Corpus measurements behind a default** → the [README](../README.md), next to the field they justify
- **The traps that bite an agent working here** → [CLAUDE.md](../CLAUDE.md)

**Live numbers are not written down anywhere.** Fixture counts and pass rates move with the
corpus; `bun run diff:golden --nimbus-root <path>` is the answer, and a document restating it
would go stale silently.

## The other repos

- [Nimbus](https://github.com/nimbus-agent/Nimbus) — AGPL-3.0-only: the gateway, the apps, and
  the connectors this generator reproduces
- [nimbus-sdk](https://github.com/nimbus-agent/nimbus-sdk) — MIT: publishes `@nimbus-dev/sdk`,
  whose `connector-kit` export a standalone connector imports
