import type { ConnectorSpec } from "../spec.ts";
import type { GeneratedFile } from "../types.ts";

export function emitReadme(spec: ConnectorSpec): GeneratedFile {
  const t = spec.title;
  const content = `# ${t} Connector

## What this is

Nimbus MCP connector for ${t}. Indexes and provides context from ${t} to the Nimbus agent.

## Install

Bundled with Nimbus — no separate install required.

## Quickstart

\`\`\`bash
nimbus connector auth ${spec.name}
nimbus ask "Summarize my recent activity in ${t}"
\`\`\`

## See also

- [${t} Connector Documentation](https://nimbus-agent.dev/user-guide/connectors/)
- [Nimbus Architecture Overview](https://nimbus-agent.dev/architecture-overview/)
- [HITL and Safety](https://nimbus-agent.dev/user-guide/hitl-and-safety/)

## License

AGPL-3.0
`;
  return { path: ["README.md"], content };
}
