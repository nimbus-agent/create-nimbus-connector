import { describe, expect, it } from "bun:test";
import { parseModule } from "../../src/derive/ast.ts";
import { createClaimSet } from "../../src/derive/claims.ts";
import { frameFailureKind, recognizeFrame } from "../../src/derive/server/index.ts";

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

// Every module recognizeFrame must refuse, each with the reason it exists. One row per case:
// the assertions are identical in all of them — no frame recognized, and nothing claimed — so
// only the source and its rationale differ.
const REFUSED_FRAMES = [
  [
    "returns undefined and claims nothing for a read-only-kit module",
    'import { runReadOnlyMcpConnector } from "../../shared/x.ts";',
  ],
  [
    "rejects partial frames: McpServer with unrelated connect call",
    [
      'const mcp = new McpServer({ name: "nimbus-otherstyle", version: "0.1.0" });',
      "function somethingCompletelyDifferent() { return 1; }",
      "await socket.connect(other);",
    ].join("\n"),
  ],

  // Final fix wave, Fix 2: claims.claim(s, "frame") claims each of these statements' whole byte
  // range at the top level, so a mutation to what is INSIDE one of them was previously invisible
  // to the totality rule — the statement was still claimed, mutation and all. isConstFrom and
  // getMcpServerInfo now verify the interior instead of only the callee/key names.
  [
    "rejects createZodToolRegistrar called with an extra argument",
    FRAME.replace(
      "const reg = createZodToolRegistrar(createRegisterSimpleTool(mcp));",
      "const reg = createZodToolRegistrar(createRegisterSimpleTool(mcp), { strict: true });",
    ),
  ],
  [
    'rejects a McpServer literal whose version does not match the emitted "0.1.0"',
    FRAME.replace(
      'const mcp = new McpServer({ name: "nimbus-newrelic", version: "0.1.0" });',
      'const mcp = new McpServer({ name: "nimbus-newrelic", version: "2.4.1" });',
    ),
  ],
  [
    "rejects frame where connect receiver is not the mcp variable",
    [
      'import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";',
      'import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";',
      'import { z } from "zod";',
      'import { createRegisterSimpleTool, createZodToolRegistrar, mcpJsonResult as jsonResult } from "../../shared/mcp-tool-kit.ts";',
      'const mcp = new McpServer({ name: "nimbus-newrelic", version: "0.1.0" });',
      "const reg = createZodToolRegistrar(createRegisterSimpleTool(mcp));",
      "const transport = new StdioServerTransport();",
      "await other.connect(transport);",
    ].join("\n"),
  ],

  // Over-claiming defect: isConstFrom(node, "createZodToolRegistrar", 1) checked only the outer
  // callee and argument COUNT, so createZodToolRegistrar(unrelated) — a single-argument call to
  // the right name whose argument is not createRegisterSimpleTool(mcp) at all — matched anyway.
  // isRegistrarConst now verifies the argument's own identity down to the mcp binding it must
  // close over.
  [
    "rejects createZodToolRegistrar called with an argument that is not createRegisterSimpleTool(mcp)",
    FRAME.replace(
      "const reg = createZodToolRegistrar(createRegisterSimpleTool(mcp));",
      "const reg = createZodToolRegistrar(unrelated);",
    ),
  ],

  // Over-claiming defect: isConnect checked only the receiver (`mcp`) and the property name
  // (`connect`), never the call's argument — `await mcp.connect(other)` matched just as readily
  // as `await mcp.connect(transport)`. isConnect now requires exactly one argument matching the
  // transport const's own variable name.
  [
    "rejects await mcp.connect(other) where other is not the transport variable",
    FRAME.replace("await mcp.connect(transport);", "await mcp.connect(other);"),
  ],

  // Fix 2: `let`/`var` both produce a VariableDeclaration node, same as `const` — only
  // node["kind"] tells them apart. Before this fix, isRegistrarConst never read `kind`, so a
  // `let reg = ...` registrar passed every other check and was claimed as the documented
  // `const` frame.
  [
    "rejects a `let` registrar instead of claiming it as the documented `const` frame",
    FRAME.replace(
      "const reg = createZodToolRegistrar(createRegisterSimpleTool(mcp));",
      "let reg = createZodToolRegistrar(createRegisterSimpleTool(mcp));",
    ),
  ],

  // Fix 3: a computed MemberExpression (`mcp[connect](transport)`) can have an Identifier
  // `property` too — the KEY variable's name, not a property name. Before this fix, isConnect
  // never checked `computed`, so this was accepted as `mcp.connect(transport)` whenever the
  // index variable happened to be named "connect".
  [
    "rejects a computed mcp[connect](transport) instead of establishing mcp.connect",
    FRAME.replace("await mcp.connect(transport);", "await mcp[connect](transport);"),
  ],

  // Same class as Fix 2 above, but for getMcpServerInfo: before this fix it never read `kind`,
  // so `let mcp = new McpServer(...)` passed every check below and was claimed as the documented
  // `const` frame.
  [
    "rejects a `let` McpServer const instead of claiming it as the documented `const` frame",
    FRAME.replace(
      'const mcp = new McpServer({ name: "nimbus-newrelic", version: "0.1.0" });',
      'let mcp = new McpServer({ name: "nimbus-newrelic", version: "0.1.0" });',
    ),
  ],

  // Same class as Fix 2 above, but for isConstFrom (the transport const's own matcher): before
  // this fix it never read `kind`, so `let transport = new StdioServerTransport()` passed every
  // check below and was claimed as the documented `const` frame.
  [
    "rejects a `let` transport const instead of claiming it as the documented `const` frame",
    FRAME.replace(
      "const transport = new StdioServerTransport();",
      "let transport = new StdioServerTransport();",
    ),
  ],
];

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

  // Every REFUSED_FRAMES row: no frame recognized, and nothing claimed. See that table for each
  // case's own rationale.
  it.each(REFUSED_FRAMES)("%s", (_name, source) => {
    const statements = parseModule(source);
    const claims = createClaimSet();

    expect(recognizeFrame(statements, claims)).toBeUndefined();
    expect(claims.claims()).toEqual([]);
  });

  // Task 5: rest-kit is the hand-rolled five elements plus an import from rest-tool-kit.ts —
  // wiring() emits the same prologue/epilogue for both styles (only the McpServer binding's own
  // name differs, "mcp" vs "server", and this recognizer already reads that off the node), so
  // the discriminator is exactly this one extra import.
  it('recognizes "rest-kit" when a rest-tool-kit.ts import is present, claiming it too', () => {
    const source = [
      'import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";',
      'import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";',
      'import { z } from "zod";',
      'import { createRegisterSimpleTool, createZodToolRegistrar } from "../../shared/mcp-tool-kit.ts";',
      'import { makeRestToolRegistrar } from "../../shared/rest-tool-kit.ts";',
      'const server = new McpServer({ name: "nimbus-zzstandalone", version: "0.1.0" });',
      "const reg = createZodToolRegistrar(createRegisterSimpleTool(server));",
      "const transport = new StdioServerTransport();",
      "await server.connect(transport);",
    ].join("\n");
    const statements = parseModule(source);
    const claims = createClaimSet();

    const frame = recognizeFrame(statements, claims);
    expect(frame?.name).toBe("zzstandalone");
    expect(frame?.style).toBe("rest-kit");
    expect(claims.unclaimed(statements)).toEqual([]);
  });

  it('recognizes "hand-rolled", not "rest-kit", when no rest-tool-kit.ts import is present', () => {
    // FRAME itself has no such import — re-asserted here (rather than only inferred from the
    // very first test above) so a future change to FRAME that accidentally added one would fail
    // this test rather than silently making the two styles indistinguishable.
    const frame = recognizeFrame(parseModule(FRAME), createClaimSet());
    expect(frame?.style).toBe("hand-rolled");
  });
});

describe("frameFailureKind", () => {
  it("names the two-line registrar idiom (discord, github, and 9 more found by measurement)", () => {
    const source = FRAME.replace(
      "const reg = createZodToolRegistrar(createRegisterSimpleTool(mcp));",
      [
        "const registerSimpleTool = createRegisterSimpleTool(mcp);",
        "const reg = createZodToolRegistrar(registerSimpleTool);",
      ].join("\n"),
    );
    expect(frameFailureKind(parseModule(source))).toBe("frame:registrar-not-inlined");
  });

  it("names the inlined transport tail (gmail, onedrive, outlook, google-*)", () => {
    const source = FRAME.replace(
      "const transport = new StdioServerTransport();\nawait mcp.connect(transport);",
      "await mcp.connect(new StdioServerTransport());",
    );
    expect(frameFailureKind(parseModule(source))).toBe("frame:tail-inlined-transport");
  });

  it("names a missing kit import", () => {
    expect(frameFailureKind(parseModule("const x = 1;"))).toBe("frame:no-kit-import");
  });

  it("names a missing McpServer const when the kit import is present but no server const is", () => {
    const source = FRAME.split("\n")
      .filter((line) => !line.startsWith("const mcp = new McpServer"))
      .join("\n");
    expect(frameFailureKind(parseModule(source))).toBe("frame:no-mcp-server");
  });

  // apple, fastmail, imap and protonmail: no createZodToolRegistrar call anywhere — each
  // registers its tools through a single hand-authored `registerXTools(server, ...)` call
  // instead. Not a near miss (no bare-identifier createZodToolRegistrar call exists to spot),
  // so this is the plain "no registrar recognized at all" bucket, not "not inlined".
  it("names a missing registrar when no createZodToolRegistrar call exists at all", () => {
    const source = FRAME.replace(
      "const reg = createZodToolRegistrar(createRegisterSimpleTool(mcp));",
      "registerNewrelicTools(mcp);",
    );
    expect(frameFailureKind(parseModule(source))).toBe("frame:no-registrar");
  });

  it("names a missing transport when neither a transport const nor an inlined one exists", () => {
    const source = FRAME.replace(
      "const transport = new StdioServerTransport();\nawait mcp.connect(transport);",
      "await mcp.connect(somethingElse);",
    );
    expect(frameFailureKind(parseModule(source))).toBe("frame:no-transport");
  });

  it("names a missing connect call when the transport const exists but nothing connects it", () => {
    const source = FRAME.replace("await mcp.connect(transport);", "doSomethingElse();");
    expect(frameFailureKind(parseModule(source))).toBe("frame:no-connect");
  });

  // Task 4's read-only-kit frame moved 50 connectors rather than the ~60 predicted; the
  // shortfall is exactly this shape — argocd, bigeye, flux, looker, mlflow, monte-carlo,
  // powerbi, snowflake, tableau, workday all pass an already-declared function by name rather
  // than inlining the `(reg) => { ... }` arrow the emitter always writes, AND all ten gate the
  // call behind `if (import.meta.main) { ... }` — an entrypoint guard `recognizeReadOnlyFrame`'s
  // top-level scan does not look inside, since doing so there would be a claim, not a label.
  it("names the named-callback read-only idiom, gated behind if (import.meta.main)", () => {
    const source = [
      'import { runReadOnlyMcpConnector } from "../../shared/run-read-only-mcp-connector.ts";',
      "function registerZzTools(reg) {}",
      "if (import.meta.main) {",
      '  await runReadOnlyMcpConnector("nimbus-zzreadonly", registerZzTools);',
      "}",
    ].join("\n");
    expect(frameFailureKind(parseModule(source))).toBe("frame:readonly-callback-not-inline");
  });

  // The bare (un-gated) form of the same near miss — no corpus connector writes this today, but
  // withTopLevelIfBodies only ADDS candidate statements, so the un-nested form must keep working.
  it("also names the named-callback idiom when it is not gated behind an if at all", () => {
    const source = [
      'import { runReadOnlyMcpConnector } from "../../shared/run-read-only-mcp-connector.ts";',
      "function registerZzTools(reg) {}",
      'await runReadOnlyMcpConnector("nimbus-zzreadonly", registerZzTools);',
    ].join("\n");
    expect(frameFailureKind(parseModule(source))).toBe("frame:readonly-callback-not-inline");
  });

  // frameFailureKind is only ever called by deriveSpec once recognizeFrame has already
  // returned undefined for the same statements, so a module that satisfies every element this
  // function checks can never reach it through that path — recognizeFrame would have recognized
  // it first. Calling it directly on a fully valid frame is synthetic, not a corpus shape, but
  // it is what proves the function is total (always returns a string, never falls off the end)
  // rather than merely "total for the shapes seen so far".
  it("falls back to frame:unrecognized for a module its own checks cannot fault", () => {
    expect(frameFailureKind(parseModule(FRAME))).toBe("frame:unrecognized");
  });
});
