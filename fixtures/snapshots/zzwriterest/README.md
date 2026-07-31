# Zzwriterest Connector

## What this is

Nimbus MCP connector for Zzwriterest. Indexes and provides context from Zzwriterest to the Nimbus agent.

## Install

```bash
bun install
bun run build
```

## Quickstart

Set the credentials this connector reads from the environment:

```bash
export ZZWRITEREST_TOKEN=...
```

Then register it with Nimbus, or run it directly over stdio:

```bash
bun src/server.ts
```

## See also

- [Zzwriterest Connector Documentation](https://nimbus-agent.dev/user-guide/connectors/)
- [Nimbus Architecture Overview](https://nimbus-agent.dev/architecture-overview/)
- [HITL and Safety](https://nimbus-agent.dev/user-guide/hitl-and-safety/)

## License

UNLICENSED — no license is granted for this package. Regenerate with `--license <spdx>`, or edit `package.json` and this section, to publish under one.
