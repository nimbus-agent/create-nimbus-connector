import { beforeAll, describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { initParser, parseModule } from "../../src/derive/ast.ts";
import { createClaimSet } from "../../src/derive/claims.ts";
import { deriveSpec } from "../../src/derive/index.ts";
import { frameFailureKind, recognizeFrame } from "../../src/derive/server/index.ts";
import { generate } from "../../src/emit/index.ts";
import { formatAll, initFormatter } from "../../src/format.ts";
import { parseSpec } from "../../src/spec.ts";
import { displayPath } from "../../src/types.ts";

beforeAll(async () => {
  await initFormatter();
  await initParser();
});

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

  // The split-registrar axis is a CLAIM now (both consts), not the label it used to be, so the
  // linkage between the two statements has to be structural: the second const's argument must be
  // the identifier the FIRST one binds. Without that check `createZodToolRegistrar(<anything>)`
  // beside an unrelated `createRegisterSimpleTool(mcp)` const would claim two statements whose
  // relationship was never established — the same over-claim `isRegistrarConst` closed for the
  // inlined form (see the argument-identity row above).
  [
    "rejects a split registrar whose second const passes an identifier the first does not bind",
    FRAME.replace(
      "const reg = createZodToolRegistrar(createRegisterSimpleTool(mcp));",
      [
        "const registerSimpleTool = createRegisterSimpleTool(mcp);",
        "const reg = createZodToolRegistrar(somethingElse);",
      ].join("\n"),
    ),
  ],

  // The inlined-transport axis, likewise promoted from label to claim: the connect call's sole
  // argument must be `new StdioServerTransport()` specifically. `new SomethingElse()` is a
  // transport this generator can neither emit nor describe, and claiming the tail on the strength
  // of the receiver and the property name alone is exactly what `isConnect`'s own argument check
  // exists to prevent on the two-statement form.
  [
    "rejects an inlined transport whose argument is not new StdioServerTransport()",
    FRAME.replace(
      "const transport = new StdioServerTransport();\nawait mcp.connect(transport);",
      "await mcp.connect(new SomethingElse());",
    ),
  ],
];

/**
 * One replacement, proving it fired EXACTLY once.
 *
 * An anchor that matched nothing would leave the canonical fixture in place and make the
 * deep-equality assertions below vacuous — they would be comparing a fixture against itself. An
 * anchor that matched twice would rewrite the wrong occurrence and quietly test a different
 * module than the one named. `split` settles both in one comparison.
 */
function rewrite(source: string, from: string, to: string): string {
  expect(source.split(from)).toHaveLength(2);
  return source.replace(from, to);
}

/**
 * A fixture's emitted `src/server.ts` and `nimbus.extension.json`.
 *
 * The near-miss modules below are built by surgery on THIS repository's own output, never
 * transcribed from a real connector: `src/`, `test/` and `fixtures/` may not carry AGPL connector
 * source (CLAUDE.md's licensing constraint). It is also the stronger test — a fixture-derived
 * near miss has a canonical counterpart whose derived spec it can be compared against field for
 * field, which a hand-written module would not.
 */
function emitted(name: string): { server: string; manifest: string } {
  const specPath = join(import.meta.dir, "..", "..", "fixtures", `${name}.spec.json`);
  const files = formatAll(generate(parseSpec(JSON.parse(readFileSync(specPath, "utf8")))));
  const read = (path: string): string => {
    const file = files.find((f) => displayPath(f.path) === path);
    if (file === undefined) throw new Error(`${name} emitted no ${path}`);
    return file.content;
  };
  return { server: read("src/server.ts"), manifest: read("nimbus.extension.json") };
}

/** The spec `deriveSpec` recovers from a fixture's emitted output, `rewrite`n first when given. */
function derive(name: string, surgery?: (source: string) => string): Record<string, unknown> {
  const files = emitted(name);
  const server = surgery === undefined ? files.server : surgery(files.server);
  const result = deriveSpec({ ...files, server });
  if (!result.ok) {
    throw new Error(`${name} did not derive: ${result.blockers.map((b) => b.kind).join(", ")}`);
  }
  return result.spec;
}

/** `const <mcpVar>` -> the two-const split form, with `blankLine` between the McpServer const and it. */
function splitRegistrar(mcpVar: string, blankLine: boolean): (source: string) => string {
  return (source) =>
    rewrite(
      source,
      `const reg = createZodToolRegistrar(createRegisterSimpleTool(${mcpVar}));`,
      [
        ...(blankLine ? [""] : []),
        `const registerSimpleTool = createRegisterSimpleTool(${mcpVar});`,
        "const reg = createZodToolRegistrar(registerSimpleTool);",
      ].join("\n"),
    );
}

/** The two-statement transport tail -> the one-statement inlined one. */
function inlinedTransport(mcpVar: string): (source: string) => string {
  return (source) =>
    rewrite(
      source,
      `const transport = new StdioServerTransport();\nawait ${mcpVar}.connect(transport);`,
      `await ${mcpVar}.connect(new StdioServerTransport());`,
    );
}

/**
 * Condition (b) for the split-registrar and inlined-transport axes: every spec field recovered
 * from the near-miss shape is correct.
 *
 * Deep equality against the spec derived from the CANONICAL shape rather than a hand-listed set
 * of fields — the near miss recovers the same spec, field for field, with no opportunity to
 * forget one. Both axes are case 2 under docs/ROADMAP.md's *Shape variance the emitter models
 * one way* ("Wiring and tail idiom"): they are shapes `wiring()` and `tail()` never write, so
 * `diff:golden` cannot check this widening and these assertions are the whole of what stands
 * between a correct one and a wrong one.
 *
 * The byte-diff's silence here is structural, not an oversight: because the emitter writes the
 * canonical form, a connector in either near-miss shape re-emits as the canonical one and reaches
 * `emits`, never `server-identical`.
 */
describe("recognizeFrame reads the split registrar and the inlined transport", () => {
  it("derives the same spec from a split registrar as from the inlined one (hand-rolled)", () => {
    expect(derive("zzscratch", splitRegistrar("mcp", true))).toEqual(derive("zzscratch"));
  });

  // obsidian writes the two consts with no blank line above them where the other 12 have one, so
  // the pair must not be pinned to a layout. Biome preserves line breaks (CLAUDE.md's emitter
  // conventions), so this is a real difference in the bytes, not one the formatter erases.
  it("derives the same spec with no blank line above the split pair, as obsidian writes it", () => {
    expect(derive("zzscratch", splitRegistrar("mcp", false))).toEqual(derive("zzscratch"));
  });

  it("derives the same spec from a split registrar as from the inlined one (rest-kit)", () => {
    expect(derive("zzstandalone", splitRegistrar("server", true))).toEqual(derive("zzstandalone"));
  });

  it("derives the same spec from an inlined transport tail as from the transport const", () => {
    expect(derive("zzscratch", inlinedTransport("mcp"))).toEqual(derive("zzscratch"));
  });

  // Both styles, same as the split registrar above, because this axis spans both.
  //
  // Measured 2026-08-07 against `packages/mcp-connectors` tree `94fd3623` (Nimbus commit
  // `b3a6f159`), re-measurable in two greps over that directory — the recipe
  // `isInlinedTransportConnect`'s own docstring records, and the reason these figures are dated
  // here rather than deleted: which style this test has to run on is a CONCLUSION drawn from them,
  // so a reader who cannot check the premise cannot check the conclusion.
  //
  //   grep -rl "connect(new StdioServerTransport())" --include=server.ts   -> the TEN
  //   ... intersected with a `createZodToolRegistrar` grep                 -> the SIX
  //
  // Ten corpus connectors write the inlined tail; six of them reach this matcher at all (the other
  // four — `apple`, `fastmail`, `imap`, `protonmail` — are `frame:no-registrar`). Of the six, five
  // are rest-kit (`gmail`, `onedrive`, `outlook`, `google-meet`, `google-photos`) and
  // `google-drive` is hand-rolled. The hand-rolled case alone would have proved the axis only on
  // the MINORITY style — `isInlinedTransportConnect` takes the McpServer binding as a parameter
  // precisely because `wiring()` names it `mcp` for one style and `server` for the other, and a
  // parameter that is only ever exercised with one value is a parameter nothing has checked.
  it("derives the same spec from an inlined transport tail on the rest-kit style too", () => {
    expect(derive("zzstandalone", inlinedTransport("server"))).toEqual(derive("zzstandalone"));
  });

  // google-meet and google-photos write BOTH near misses. frameFailureKind checks the registrar
  // element before the transport one, so either axis alone leaves them blocked on the registrar
  // bucket — which is why the two land together, and why the combination is asserted rather than
  // inferred from the two single-axis cases above.
  it("derives the same spec when a module writes both near misses, as google-meet does", () => {
    const both = (source: string): string =>
      inlinedTransport("mcp")(splitRegistrar("mcp", true)(source));
    expect(derive("zzscratch", both)).toEqual(derive("zzscratch"));
  });
});

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
  // `frame:registrar-not-inlined` is retired: element 3 accepts the split form now, so this
  // diagnostic must walk PAST it to whatever actually broke. A module writing the split registrar
  // AND breaking element 5 used to stop at the registrar bucket and blame a construct that is no
  // longer a fault at all.
  it("walks past a split registrar to the element that actually broke", () => {
    const source = FRAME.replace(
      "const reg = createZodToolRegistrar(createRegisterSimpleTool(mcp));",
      [
        "const registerSimpleTool = createRegisterSimpleTool(mcp);",
        "const reg = createZodToolRegistrar(registerSimpleTool);",
      ].join("\n"),
    ).replace("await mcp.connect(transport);", "await mcp.connect(other);");
    expect(frameFailureKind(parseModule(source))).toBe("frame:no-connect");
  });

  // `frame:tail-inlined-transport` is retired for the same reason: the inlined tail is recognized
  // now, so what remains on this axis is a tail that is inlined but not a StdioServerTransport —
  // no transport of any recognizable kind, which is the plain bucket.
  it("names a missing transport when an inlined tail constructs something else", () => {
    const source = FRAME.replace(
      "const transport = new StdioServerTransport();\nawait mcp.connect(transport);",
      "await mcp.connect(new SomethingElse());",
    );
    expect(frameFailureKind(parseModule(source))).toBe("frame:no-transport");
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

  // `frame:readonly-callback-not-inline` is retired, and unlike the two axes above it was never
  // firing in the first place: upstream commit `b3a6f159` refactored those ten connectors into the
  // shape `recognizeReadOnlyFrame` now READS (see test/derive/frame-readonly.test.ts), and the two
  // functions behind the bucket — `isNamedReadOnlyCallback` and `withTopLevelIfBodies` — were dead
  // against the whole corpus, so that diagnostic never once printed. What is asserted instead is
  // the fallback for a module in the recognized shape that still misses part of it.
  //
  // The absence is a live fact, so it carries how to re-check it: run
  // `bun run reach --verbose --nimbus-root <path>` and grep the histogram for the bucket name. It
  // was absent on 2026-08-07 against `packages/mcp-connectors` tree `94fd3623`. That is the whole
  // reason this comment names a bucket at all — a reader meeting a *present* bucket must be able
  // to tell that this sentence went stale rather than that the test is wrong.
  it("faults a partial named-callback read-only module on the element it actually lacks", () => {
    const source = [
      'import { mcpJsonResult as jsonResult } from "../../shared/mcp-tool-kit.ts";',
      'import { runReadOnlyMcpConnector } from "../../shared/run-read-only-mcp-connector.ts";',
      "export async function startConnector(): Promise<void> {",
      '  await runReadOnlyMcpConnector("nimbus-zzreadonly", registerZzTools);',
      "}",
      "if (import.meta.main) await startConnector();",
    ].join("\n");
    // `registerZzTools` is never declared, so the named read-only form is refused and the
    // hand-rolled branch takes over: the kit import is present, a top-level McpServer const is
    // not. That is the bucket the ten corpus connectors reported before this recognizer existed.
    expect(frameFailureKind(parseModule(source))).toBe("frame:no-mcp-server");
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
