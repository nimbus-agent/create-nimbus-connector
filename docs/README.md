# create-nimbus-connector documentation

A generator for Nimbus MCP connector packages. Describe a connector as a JSON spec; get a
package byte-identical to a hand-written one.

## Start here

| If you want to | Read |
| --- | --- |
| Generate a connector | [USAGE.md](./USAGE.md) |
| Look up a spec field | [SPEC.md](./SPEC.md) — every field, generated from the schema |
| Understand how the fields work together | [SPEC-RULES.md](./SPEC-RULES.md) — the same language in prose, and the rules that reject a spec |
| Understand how it is built | [ARCHITECTURE.md](./ARCHITECTURE.md) |
| Know what a green check actually proves | [TESTING.md](./TESTING.md) |
| Know where it is going | [ROADMAP.md](./ROADMAP.md) |
| Know why the org still ships two scaffolders | [CONSOLIDATION.md](./CONSOLIDATION.md) — the four preconditions, and what each blocks |
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
recording what was measured in the Nimbus corpus and what was decided. **All of them have now
been retired.** Their durable conclusions are folded into the pages above and into the source
comments named below; git history has the originals, and nothing else cites them.

That is a deliberate policy rather than tidying, and [GOVERNANCE.md](./GOVERNANCE.md) states it:
*reasoning that lives only in a dated document nobody opens again is reasoning that gets
re-litigated.* A design document is the right artifact while a stage is being built and the wrong
one afterwards, because it freezes predictions beside conclusions — and several of these
documents' predictions were measured wrong on the way. Where a retired plan and the code
disagree, the code is authoritative.

**Where each kind of thing went:**

- **What the generator cannot do, and why** → [ROADMAP.md § Known limitations](./ROADMAP.md#known-limitations)
- **Proposals measured and rejected** → [ROADMAP.md § Considered and declined](./ROADMAP.md#considered-and-declined),
  which now carries the `query` design's six declined alternatives and the search-filter entry
  design's three, each with the measurement that settled it
- **How the corpus reach number is arrived at, and the three earlier counts that were wrong**
  → [ROADMAP.md § Measuring reach](./ROADMAP.md#measuring-reach)
- **How each harness works and what it proves** → [ARCHITECTURE.md § The verification layers](./ARCHITECTURE.md#the-verification-layers)
- **Which emitted shape each check actually covers, and which gates can pass while asserting
  nothing** → [TESTING.md](./TESTING.md)
- **The deriver's vocabulary — tiers, blockers, the totality rule, case 1 vs case 2**
  → [GLOSSARY.md § Reach and derivation](./GLOSSARY.md#reach-and-derivation)
- **Corpus measurements behind a default** → [SPEC-RULES.md](./SPEC-RULES.md), next to the field they justify
- **The traps that bite an agent working here** → [CLAUDE.md](../CLAUDE.md)

Three arguments were folded into **source comments** rather than a page, because each is a rule
about one module and belongs where it is enforced: why an unguarded AST field read is a compile
error (`src/derive/read.ts`), why the read-only-kit frame splices the callback's body in rather
than claiming the wrapper (`src/derive/server/frame.ts`), and why an aggregator over these gates
is the most dangerous thing in the repository (`scripts/_lib/preflight.ts`).

**Live numbers are written down in exactly one place.** Fixture counts and pass rates move with
the corpus; `bun run diff:golden --nimbus-root <path>` is the answer, and a document restating it
goes stale silently. The one sanctioned exception is
[ROADMAP § The measured ceiling](./ROADMAP.md#the-measured-ceiling), which states the corpus
regeneration counts on purpose and earns it by carrying the date and the `packages/mcp-connectors`
tree they were measured against — see [CLAUDE.md](../CLAUDE.md), which defines the rule and this
exception together. A number without those two is what the rule forbids.

## The other repos

- [Nimbus](https://github.com/nimbus-agent/Nimbus) — AGPL-3.0-only: the gateway, the apps, and
  the connectors this generator reproduces
- [nimbus-sdk](https://github.com/nimbus-agent/nimbus-sdk) — MIT: publishes `@nimbus-dev/sdk`,
  whose `connector-kit` export a standalone connector imports
