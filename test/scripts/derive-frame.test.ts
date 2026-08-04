import { describe, expect, it } from "bun:test";
import { parseModule } from "../../scripts/_lib/derive/ast.ts";
import { createClaimSet } from "../../scripts/_lib/derive/claims.ts";
import { recognizeFrame } from "../../scripts/_lib/derive/server/index.ts";

const FRAME = [
  'import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";',
  'import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";',
  'import { z } from "zod";',
  'import { createRegisterSimpleTool, createZodToolRegistrar, mcpJsonResult as jsonResult } from "../../shared/mcp-tool-kit.ts";',
  'const mcp = new McpServer({ name: "nimbus-newrelic", version: "0.1.0" });',
  "const reg = createZodToolRegistrar(createRegisterSimpleTool(mcp));",
  "const transport = new StdioServerTransport();",
  "await mcp.connect(transport);",
].join("\n");

describe("recognizeFrame", () => {
  it("recovers the connector name and claims every frame statement", () => {
    const statements = parseModule(FRAME);
    const claims = createClaimSet();

    const frame = recognizeFrame(statements, claims);
    expect(frame?.name).toBe("newrelic");
    expect(frame?.style).toBe("hand-rolled");
    expect(claims.unclaimed(statements)).toEqual([]);
  });

  it("verifies and hands tools the top-level list for a hand-rolled module", () => {
    const statements = parseModule(FRAME);
    const frame = recognizeFrame(statements, createClaimSet());

    // Hand-rolled nests nothing, so both lists ARE the module's own statements. Asserted
    // rather than assumed: read-only-kit is the style where they differ, and a regression
    // that made them differ here would silently change what the totality rule walks.
    expect(frame?.toolStatements).toEqual(statements);
    expect(frame?.verifyStatements).toEqual(statements);
  });

  it("leaves a non-frame statement unclaimed", () => {
    const source = `${FRAME}\nfunction extra() {}`;
    const statements = parseModule(source);
    const claims = createClaimSet();

    recognizeFrame(statements, claims);
    expect(claims.unclaimed(statements).map((s) => s.type)).toEqual(["FunctionDeclaration"]);
  });

  it("returns undefined and claims nothing for a read-only-kit module", () => {
    const statements = parseModule('import { runReadOnlyMcpConnector } from "../../shared/x.ts";');
    const claims = createClaimSet();

    expect(recognizeFrame(statements, claims)).toBeUndefined();
    expect(claims.claims()).toEqual([]);
  });

  it("rejects partial frames: McpServer with unrelated connect call", () => {
    const source = [
      'const mcp = new McpServer({ name: "nimbus-otherstyle", version: "0.1.0" });',
      "function somethingCompletelyDifferent() { return 1; }",
      "await socket.connect(other);",
    ].join("\n");
    const statements = parseModule(source);
    const claims = createClaimSet();

    expect(recognizeFrame(statements, claims)).toBeUndefined();
    expect(claims.claims()).toEqual([]);
  });

  // Final fix wave, Fix 2: claims.claim(s, "frame") claims each of these statements' whole byte
  // range at the top level, so a mutation to what is INSIDE one of them was previously invisible
  // to the totality rule — the statement was still claimed, mutation and all. isConstFrom and
  // getMcpServerInfo now verify the interior instead of only the callee/key names.
  it("rejects createZodToolRegistrar called with an extra argument", () => {
    const source = FRAME.replace(
      "const reg = createZodToolRegistrar(createRegisterSimpleTool(mcp));",
      "const reg = createZodToolRegistrar(createRegisterSimpleTool(mcp), { strict: true });",
    );
    const statements = parseModule(source);
    const claims = createClaimSet();

    expect(recognizeFrame(statements, claims)).toBeUndefined();
    expect(claims.claims()).toEqual([]);
  });

  it('rejects a McpServer literal whose version does not match the emitted "0.1.0"', () => {
    const source = FRAME.replace(
      'const mcp = new McpServer({ name: "nimbus-newrelic", version: "0.1.0" });',
      'const mcp = new McpServer({ name: "nimbus-newrelic", version: "2.4.1" });',
    );
    const statements = parseModule(source);
    const claims = createClaimSet();

    expect(recognizeFrame(statements, claims)).toBeUndefined();
    expect(claims.claims()).toEqual([]);
  });

  it("rejects frame where connect receiver is not the mcp variable", () => {
    const source = [
      'import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";',
      'import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";',
      'import { z } from "zod";',
      'import { createRegisterSimpleTool, createZodToolRegistrar, mcpJsonResult as jsonResult } from "../../shared/mcp-tool-kit.ts";',
      'const mcp = new McpServer({ name: "nimbus-newrelic", version: "0.1.0" });',
      "const reg = createZodToolRegistrar(createRegisterSimpleTool(mcp));",
      "const transport = new StdioServerTransport();",
      "await other.connect(transport);",
    ].join("\n");
    const statements = parseModule(source);
    const claims = createClaimSet();

    expect(recognizeFrame(statements, claims)).toBeUndefined();
    expect(claims.claims()).toEqual([]);
  });

  // Over-claiming defect: isConstFrom(node, "createZodToolRegistrar", 1) checked only the outer
  // callee and argument COUNT, so createZodToolRegistrar(unrelated) — a single-argument call to
  // the right name whose argument is not createRegisterSimpleTool(mcp) at all — matched anyway.
  // isRegistrarConst now verifies the argument's own identity down to the mcp binding it must
  // close over.
  it("rejects createZodToolRegistrar called with an argument that is not createRegisterSimpleTool(mcp)", () => {
    const source = FRAME.replace(
      "const reg = createZodToolRegistrar(createRegisterSimpleTool(mcp));",
      "const reg = createZodToolRegistrar(unrelated);",
    );
    const statements = parseModule(source);
    const claims = createClaimSet();

    expect(recognizeFrame(statements, claims)).toBeUndefined();
    expect(claims.claims()).toEqual([]);
  });

  // Over-claiming defect: isConnect checked only the receiver (`mcp`) and the property name
  // (`connect`), never the call's argument — `await mcp.connect(other)` matched just as readily
  // as `await mcp.connect(transport)`. isConnect now requires exactly one argument matching the
  // transport const's own variable name.
  it("rejects await mcp.connect(other) where other is not the transport variable", () => {
    const source = FRAME.replace("await mcp.connect(transport);", "await mcp.connect(other);");
    const statements = parseModule(source);
    const claims = createClaimSet();

    expect(recognizeFrame(statements, claims)).toBeUndefined();
    expect(claims.claims()).toEqual([]);
  });

  // Fix 2: `let`/`var` both produce a VariableDeclaration node, same as `const` — only
  // node["kind"] tells them apart. Before this fix, isRegistrarConst never read `kind`, so a
  // `let reg = ...` registrar passed every other check and was claimed as the documented
  // `const` frame.
  it("rejects a `let` registrar instead of claiming it as the documented `const` frame", () => {
    const source = FRAME.replace(
      "const reg = createZodToolRegistrar(createRegisterSimpleTool(mcp));",
      "let reg = createZodToolRegistrar(createRegisterSimpleTool(mcp));",
    );
    const statements = parseModule(source);
    const claims = createClaimSet();

    expect(recognizeFrame(statements, claims)).toBeUndefined();
    expect(claims.claims()).toEqual([]);
  });

  // Fix 3: a computed MemberExpression (`mcp[connect](transport)`) can have an Identifier
  // `property` too — the KEY variable's name, not a property name. Before this fix, isConnect
  // never checked `computed`, so this was accepted as `mcp.connect(transport)` whenever the
  // index variable happened to be named "connect".
  it("rejects a computed mcp[connect](transport) instead of establishing mcp.connect", () => {
    const source = FRAME.replace("await mcp.connect(transport);", "await mcp[connect](transport);");
    const statements = parseModule(source);
    const claims = createClaimSet();

    expect(recognizeFrame(statements, claims)).toBeUndefined();
    expect(claims.claims()).toEqual([]);
  });

  // Same class as Fix 2 above, but for getMcpServerInfo: before this fix it never read `kind`,
  // so `let mcp = new McpServer(...)` passed every check below and was claimed as the documented
  // `const` frame.
  it("rejects a `let` McpServer const instead of claiming it as the documented `const` frame", () => {
    const source = FRAME.replace(
      'const mcp = new McpServer({ name: "nimbus-newrelic", version: "0.1.0" });',
      'let mcp = new McpServer({ name: "nimbus-newrelic", version: "0.1.0" });',
    );
    const statements = parseModule(source);
    const claims = createClaimSet();

    expect(recognizeFrame(statements, claims)).toBeUndefined();
    expect(claims.claims()).toEqual([]);
  });

  // Same class as Fix 2 above, but for isConstFrom (the transport const's own matcher): before
  // this fix it never read `kind`, so `let transport = new StdioServerTransport()` passed every
  // check below and was claimed as the documented `const` frame.
  it("rejects a `let` transport const instead of claiming it as the documented `const` frame", () => {
    const source = FRAME.replace(
      "const transport = new StdioServerTransport();",
      "let transport = new StdioServerTransport();",
    );
    const statements = parseModule(source);
    const claims = createClaimSet();

    expect(recognizeFrame(statements, claims)).toBeUndefined();
    expect(claims.claims()).toEqual([]);
  });
});
