import type { ConnectorSpec } from "../../spec.ts";
import type { GeneratedFile } from "../../types.ts";
import type { GenerateTarget } from "../index.ts";
import { renderEnvAccessors } from "./env.ts";
import { renderReadHelper, renderWriteHelper } from "./fetch-helper.ts";
import { renderHandRolledTools } from "./tools-hand.ts";
import { renderRestKitTools } from "./tools-rest.ts";

const KIT = "@nimbus-dev/sdk/connector-kit";

function imports(spec: ConnectorSpec, target: GenerateTarget): string {
  // z.object(...) is only emitted per tool — a zero-tool spec never calls it.
  const usesZod = spec.tools.length > 0;
  // Stub handlers only throw; jsonResult(...) is only emitted by a non-stub hand-rolled tool.
  const usesJsonResult = spec.style === "hand-rolled" && spec.tools.some((t) => t.impl !== "stub");
  // Only the "basic" branch of the client-credentials token exchange calls
  // encodeBasicAuthHeader — a "body" entry never references it, so gating on credentialsIn
  // (rather than merely "a client-credentials entry exists") is what keeps the import used,
  // satisfying noUnusedLocals.
  const usesBasicClientCredentials = spec.env.some(
    (e) => e.auth === "client-credentials" && e.credentialsIn === "basic",
  );

  const zodImport = 'import { z } from "zod";';
  const head = [
    'import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";',
    'import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";',
  ];

  if (target === "standalone") {
    // One barrel export, so one import regardless of style. Unlike the monorepo target's
    // trailing `../../shared/*` import — a relative specifier, which Biome sorts into its
    // own group behind a blank line — the kit is a package specifier, and
    // "@nimbus-dev/sdk/connector-kit" sorts after the "@modelcontextprotocol/*" entries but
    // BEFORE "zod". It therefore belongs inside the first group, in that position.
    const names = ["createRegisterSimpleTool", "createZodToolRegistrar"];
    // Alphabetical insertion point: "encodeBasicAuthHeader" sorts after
    // "createZodToolRegistrar" and before "makeRestToolRegistrar" / "mcpJsonResult as
    // jsonResult", and Biome's organizeImports enforces that order in the generated
    // package's own `bun run lint`.
    if (usesBasicClientCredentials) names.push("encodeBasicAuthHeader");
    if (usesJsonResult) names.push("mcpJsonResult as jsonResult");
    if (spec.style === "rest-kit") names.push("makeRestToolRegistrar");
    if (names.length === 2) {
      head.push(`import { ${names.join(", ")} } from "${KIT}";`);
    } else {
      head.push("import {", ...names.map((n) => `  ${n},`), `} from "${KIT}";`);
    }
    if (usesZod) head.push(zodImport);
    return head.join("\n");
  }

  // monorepo — unchanged from Stage A
  if (usesZod) head.push(zodImport);
  head.push("");
  if (spec.style === "hand-rolled") {
    // Same alphabetical constraint as the standalone branch above, against the same
    // export set — "../../shared/mcp-tool-kit.ts" also exports encodeBasicAuthHeader.
    const names = ["createRegisterSimpleTool", "createZodToolRegistrar"];
    if (usesBasicClientCredentials) names.push("encodeBasicAuthHeader");
    if (usesJsonResult) names.push("mcpJsonResult as jsonResult");
    if (names.length === 2) {
      head.push(`import { ${names.join(", ")} } from "../../shared/mcp-tool-kit.ts";`);
    } else {
      head.push(
        "import {",
        ...names.map((n) => `  ${n},`),
        '} from "../../shared/mcp-tool-kit.ts";',
      );
    }
  } else {
    head.push(
      'import { createRegisterSimpleTool, createZodToolRegistrar } from "../../shared/mcp-tool-kit.ts";',
      'import { makeRestToolRegistrar } from "../../shared/rest-tool-kit.ts";',
    );
  }
  return head.join("\n");
}

function wiring(spec: ConnectorSpec): string {
  const v = spec.style === "hand-rolled" ? "mcp" : "server";
  return [
    `const ${v} = new McpServer({ name: "nimbus-${spec.name}", version: "0.1.0" });`,
    `const reg = createZodToolRegistrar(createRegisterSimpleTool(${v}));`,
  ].join("\n");
}

function tail(spec: ConnectorSpec): string {
  const v = spec.style === "hand-rolled" ? "mcp" : "server";
  return ["const transport = new StdioServerTransport();", `await ${v}.connect(transport);`].join(
    "\n",
  );
}

export function emitServer(spec: ConnectorSpec, target: GenerateTarget): GeneratedFile {
  const isHand = spec.style === "hand-rolled";
  const readHelper = renderReadHelper(spec);
  const writeHelper = renderWriteHelper(spec);
  const sections = [
    imports(spec, target),
    // Env accessors are emitted for hand-rolled ONLY. Rest-kit's makeRestToolRegistrar
    // resolves the credential itself via requireProcessEnv(cfg.tokenEnv), so an accessor
    // would never be called; calling renderEnvAccessors unconditionally would emit dead code.
    ...(isHand && spec.env.length > 0 ? [renderEnvAccessors(spec)] : []),
    // Both helpers are conditional, on the same rule stated twice: emit it only if the
    // emitted server calls it. The read helper is skipped when no non-stub GET tool exists
    // (see renderReadHelper); the write helper is skipped when no non-GET tool exists (see
    // renderWriteHelper). A read-only spec reaches neither branch, which is what keeps
    // newrelic/datadog/grafana/sentry byte-safe.
    ...(readHelper === undefined ? [] : [readHelper]),
    ...(writeHelper === undefined ? [] : [writeHelper]),
    wiring(spec),
    isHand ? renderHandRolledTools(spec) : renderRestKitTools(spec),
    tail(spec),
  ].filter((s) => s.trim() !== "");

  return { path: ["src", "server.ts"], content: `${sections.join("\n\n")}\n` };
}
