import type { ConnectorSpec } from "../spec.ts";
import type { GeneratedFile } from "../types.ts";
import type { GenerateTarget } from "./index.ts";

export function emitReadme(spec: ConnectorSpec, target: GenerateTarget): GeneratedFile {
  const t = spec.title;
  const content = target === "standalone" ? standaloneReadme(spec, t) : monorepoReadme(spec, t);
  return { path: ["README.md"], content };
}

function monorepoReadme(spec: ConnectorSpec, t: string): string {
  return `# ${t} Connector

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
}

function standaloneReadme(spec: ConnectorSpec, t: string): string {
  const vars = spec.env.flatMap((e) => e.vars);
  // A hand-rolled spec with `env: []` and literal inlineHeaders is valid and reads nothing
  // from the environment. Emitting the sentence plus an empty ```bash fence would tell the
  // reader to set credentials and then show them none.
  const credentials =
    vars.length === 0
      ? ""
      : `Set the credentials this connector reads from the environment:

\`\`\`bash
${vars.map((v) => `export ${v}=...`).join("\n")}
\`\`\`

`;
  return `# ${t} Connector

## What this is

Nimbus MCP connector for ${t}. Indexes and provides context from ${t} to the Nimbus agent.

## Install

\`\`\`bash
bun install
bun run build
\`\`\`

## Quickstart

${credentials}${vars.length === 0 ? "Register" : "Then register"} it with Nimbus, or run it directly over stdio:

\`\`\`bash
bun src/server.ts
\`\`\`

## See also

- [${t} Connector Documentation](https://nimbus-agent.dev/user-guide/connectors/)
- [Nimbus Architecture Overview](https://nimbus-agent.dev/architecture-overview/)
- [HITL and Safety](https://nimbus-agent.dev/user-guide/hitl-and-safety/)

## License

AGPL-3.0
`;
}
