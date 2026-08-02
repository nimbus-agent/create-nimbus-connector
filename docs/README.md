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

This project was built in four stages, each with a long design document and implementation plan
recording what was measured in the Nimbus corpus and what was decided. Those documents have been
retired — their durable conclusions are folded into the pages above, and git history has the
originals:

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
