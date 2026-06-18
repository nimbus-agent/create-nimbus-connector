# create-nimbus-connector

A scaffolding generator for [**Nimbus**](https://github.com/nimbus-agent/Nimbus) MCP connectors.

> **Status: SCAFFOLD — not yet built.** This repo holds its vision and a [build prompt](./NEW-SESSION-PROMPT.md).

## What it will do

```
bunx create-nimbus-connector my-service
```

…interactively scaffolds a new first-party-style MCP connector package — the same shape as the ~94 connectors in [`packages/mcp-connectors`](https://github.com/nimbus-agent/Nimbus/tree/main/packages/mcp-connectors) — so third parties can build a Nimbus connector in minutes instead of reverse-engineering the contract.

Connectors depend on [`@nimbus-dev/sdk`](https://github.com/nimbus-agent/Nimbus/tree/main/packages/sdk) (MIT) only.

## What the generated package will contain

Following the connector authoring contract (see the `nimbus-connector-authoring` skill in the main repo), the generated package includes:

- The **mandatory tool surface** — `list` / `get` / `search` (read) and the conditionally/always HITL-gated `create` / `update` / `move` / `delete` write tools.
- A **manifest** declaring the server, tools, and any `hitlRequired` write tools.
- A **sync handler** implementing the delta-sync contract (`sync(db, lastSyncToken)` → upserted/deleted/nextSyncToken).
- **Contract tests** asserting the tool surface + the metadata-only boundary.
- A **README** with the required public-tier sections.

### Intended generated tree

```
my-service/
  package.json            # depends on @nimbus-dev/sdk
  src/
    server.ts             # MCP server entry
    manifest.ts
    sync.ts               # delta-sync handler
    tools/                # list/get/search + write tools
  test/
    contract.test.ts
  README.md
  tsconfig.json
```

## License

[MIT](./LICENSE).
