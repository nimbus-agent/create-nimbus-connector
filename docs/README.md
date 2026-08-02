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

## Design history

`superpowers/specs/` holds one design document per stage and `superpowers/plans/` the
implementation plan beside it. Each design records what was measured in the Nimbus corpus, what
was decided and why, and — after implementation — what was actually observed, including where a
claim had to be qualified rather than asserted.

They are the reason numbers are not repeated elsewhere: they are dated, they record the
measurement method, and they are not rewritten when the corpus moves.

| Stage | What it added |
| --- | --- |
| [A](./superpowers/specs/2026-07-30-create-nimbus-connector-stage-a-design.md) | The generator, the six-file tree, the golden-fixture harness |
| [B](./superpowers/specs/2026-07-30-create-nimbus-connector-stage-b-design.md) | Standalone connectors, the SDK kit, npm publishing |
| [C](./superpowers/specs/2026-07-31-create-nimbus-connector-stage-c-design.md) | Writes, HITL, OAuth `client-credentials`, Gateway wiring |
| [D](./superpowers/specs/2026-08-01-create-nimbus-connector-stage-d-design.md) | The `read-only-kit` style and search tools |

## The other repos

- [Nimbus](https://github.com/nimbus-agent/Nimbus) — AGPL-3.0-only: the gateway, the apps, and
  the connectors this generator reproduces
- [nimbus-sdk](https://github.com/nimbus-agent/nimbus-sdk) — MIT: publishes `@nimbus-dev/sdk`,
  whose `connector-kit` export a standalone connector imports
