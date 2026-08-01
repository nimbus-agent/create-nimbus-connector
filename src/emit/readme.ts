import { DEFAULT_STANDALONE_LICENSE, defaultLicenseFor } from "../license.ts";
import type { ConnectorSpec } from "../spec.ts";
import type { GeneratedFile } from "../types.ts";
import type { GenerateTarget } from "./index.ts";

/**
 * `license` affects the standalone README only. The monorepo README's License section is
 * byte-locked against the real connectors and stays the literal "AGPL-3.0" those files
 * carry — note that is the section heading text, not the SPDX id in package.json.
 */
export function emitReadme(
  spec: ConnectorSpec,
  target: GenerateTarget,
  license: string = defaultLicenseFor(target),
): GeneratedFile {
  const t = spec.title;
  const content =
    target === "standalone" ? standaloneReadme(spec, t, license) : monorepoReadme(spec, t);
  return { path: ["README.md"], content };
}

/**
 * `runReadOnlyMcpConnector` is a bootstrap-helper name inherited from Nimbus; it does not
 * restrict a connector from declaring write tools. Nine corpus connectors use it while
 * declaring `hitlRequired: ["write"]` — say so in the README (a file this generator authors
 * outright) rather than as a server.ts comment, since no corpus connector carries one and
 * emitting one would forfeit byte-matching for exactly the connectors that need the caveat.
 *
 * Standalone-only: the monorepo README is one of the six files byte-diffed against the
 * Nimbus corpus, and no corpus README carries this text (confirmed by grep across all 94).
 * Emitting it there would introduce a permanent mismatch for the next read-only-kit fixture
 * whose README is still generator boilerplate — the standalone README is authored outright
 * by this generator, so it costs nothing there.
 */
function readOnlyKitCaveat(spec: ConnectorSpec): string {
  return spec.style === "read-only-kit"
    ? "\n\nThis connector registers its tools through `runReadOnlyMcpConnector`. That name is a " +
        "bootstrap convention inherited from Nimbus and **does not restrict** the connector " +
        "from declaring write tools — nine connectors in the Nimbus corpus use it while " +
        'declaring `hitlRequired: ["write"]`. Check `nimbus.extension.json` for the ' +
        "capabilities this connector actually declares."
    : "";
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

function standaloneReadme(spec: ConnectorSpec, t: string, license: string): string {
  // UNLICENSED means "no license granted", which is easy to ship by accident. Say what it
  // implies and how to change it rather than leaving a bare word under the heading.
  const licenseText =
    license === DEFAULT_STANDALONE_LICENSE
      ? `${DEFAULT_STANDALONE_LICENSE} — no license is granted for this package. Regenerate with ` +
        "`--license <spdx>`, or edit `package.json` and this section, to publish under one."
      : license;
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

Nimbus MCP connector for ${t}. Indexes and provides context from ${t} to the Nimbus agent.${readOnlyKitCaveat(spec)}

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

${licenseText}
`;
}
