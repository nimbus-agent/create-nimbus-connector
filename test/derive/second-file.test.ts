import { beforeAll, describe, expect, it } from "bun:test";
import { initParser, parseModule } from "../../src/derive/ast.ts";
import { createClaimSet } from "../../src/derive/claims.ts";
import { recognizeFrame } from "../../src/derive/server/index.ts";
import { applySecondFile } from "../../src/derive/server/second-file.ts";

beforeAll(async () => {
  await initParser();
});

/**
 * The read-only-kit frame, as a shim. The import path is
 * "../../shared/run-read-only-mcp-connector.ts" and not "../../shared/mcp-tool-kit.ts": that is
 * the module `RUN_READ_ONLY` (src/emit/server/index.ts) writes, and `recognizeReadOnlyFrame`'s
 * `RUN_READ_ONLY_SUFFIX` is a path-SEGMENT match on it. Sourcing `runReadOnlyMcpConnector` from
 * mcp-tool-kit.ts instead makes the whole fixture unrecognizable — no frame, so every case below
 * would fail in setup rather than in what it means to test.
 */
const SHIM = [
  'import { runReadOnlyMcpConnector } from "../../shared/run-read-only-mcp-connector.ts";',
  'import { registerAcmeTools } from "./tools.ts";',
  'await runReadOnlyMcpConnector("nimbus-acme", (reg) => {',
  "  registerAcmeTools(reg);",
  "});",
  "",
].join("\n");

const TOOLS_OK = [
  'import type { ZodToolRegistrar } from "../../shared/mcp-tool-kit.ts";',
  "export function registerAcmeTools(reg: ZodToolRegistrar) {",
  '  reg("acme_list", "List things.", {}, async () => ({ ok: true }));',
  "}",
  "",
].join("\n");

function frameOf(server: string) {
  const claims = createClaimSet();
  const frame = recognizeFrame(parseModule(server), claims);
  if (frame === undefined) throw new Error("test setup: frame not recognized");
  return { frame, claims };
}

/**
 * The success case, narrowed. A refusal here fails with the REASON rather than with
 * "cannot read property of undefined" twenty lines later, which is the difference between a test
 * that tells you what broke and one that tells you only that something did.
 */
function spliceOf(server: string, tools: string) {
  const { frame, claims } = frameOf(server);
  const result = applySecondFile(frame, claims, tools);
  if ("refused" in result) throw new Error(`expected a splice, got refusal: ${result.refused}`);
  return { ...result, serverClaims: claims };
}

describe("applySecondFile", () => {
  it("splices the exported registrar's body into the statements recognizers scan", () => {
    const spliced = spliceOf(SHIM, TOOLS_OK);

    // The registration is now visible to the tool recognizers...
    expect(spliced.frame.toolStatements).toHaveLength(1);
    // ...and the shim's own call is gone rather than sitting there unrecognized.
    expect(spliced.frame.toolStatements.map((s) => s.type)).toEqual(["ExpressionStatement"]);
  });

  it("removes the shim's call from verifyStatements rather than claiming it", () => {
    // The splice rule, stated as an assertion: a spliced statement is REMOVED, never marked
    // claimed. Claiming it would be retroactive over the registrations that replace it.
    const { frame, claims } = frameOf(SHIM);
    const before = frame.verifyStatements;
    const result = applySecondFile(frame, claims, TOOLS_OK);
    if ("refused" in result) throw new Error(`expected a splice, got refusal: ${result.refused}`);

    const call = before.find((s) => !result.frame.verifyStatements.includes(s));
    expect(call?.type).toBe("ExpressionStatement");
    expect(claims.covers(call!)).toBe(false);
    // The import it bound IS claimed — an import declaration nests no registration.
    const toolsImport = result.frame.verifyStatements.find((s) => s.type === "ImportDeclaration");
    expect(claims.unclaimed(result.frame.verifyStatements)).toHaveLength(0);
    expect(toolsImport).toBeDefined();
  });

  it("carries tools.ts's other module-scope statements as foreign, with their own source", () => {
    // The safety property. Without this the type import below is invisible, and a connector whose
    // helpers are unrecognizable would derive SUCCESSFULLY — a false `emits` produced by the very
    // mechanism the totality rule exists to remove.
    const spliced = spliceOf(SHIM, TOOLS_OK);

    expect(spliced.foreign.file).toBe("src/tools.ts");
    expect(spliced.foreign.source).toBe(TOOLS_OK);
    expect(spliced.foreign.statements).toHaveLength(1);
    expect(spliced.foreign.statements[0]!.type).toBe("ImportDeclaration");
  });

  it("refuses a registrar bound as an arrow const rather than declared", () => {
    // Deliberately strict: the refusal count IS part of the measurement. A looser matcher would
    // recover a shape the emitter could not re-emit.
    const arrow = [
      'import type { ZodToolRegistrar } from "../../shared/mcp-tool-kit.ts";',
      "export const registerAcmeTools = (reg: ZodToolRegistrar) => {};",
      "",
    ].join("\n");
    const { frame, claims } = frameOf(SHIM);
    // The reason is asserted, not just the refusal: "there is no such export" and "there is one,
    // in a shape this matcher does not accept" point at completely different work, and telling
    // them apart is what the histogram is for.
    expect(applySecondFile(frame, claims, arrow)).toEqual({
      refused: "registrar-not-a-declaration",
    });
  });

  it("refuses when tools.ts exports no declaration under the imported name", () => {
    const other = "export function registerSomethingElseTools(reg: ZodToolRegistrar) {}\n";
    const { frame, claims } = frameOf(SHIM);
    expect(applySecondFile(frame, claims, other)).toEqual({ refused: "no-matching-export" });
  });

  it("refuses two declarations of the imported name rather than picking one", () => {
    // Measured 2026-08-09 against @babel/parser as resolved by this repo's lockfile, not
    // assumed: the parser rejects a duplicate module-scope binding before
    // applySecondFile ever sees it, so the `duplicate-export` arm is unreachable through
    // parseModule today and this input lands on `unparseable`. The arm stays anyway — it is the
    // same "refuse rather than pick" rule namedReadOnlyEntry enforces one file over, where the
    // two matches CAN differ and the arm is live — and it is asserted here as what it actually
    // is, so nobody reads a passing `duplicate-export` test as evidence the parser permits it.
    const twice = [
      "export function registerAcmeTools(reg: ZodToolRegistrar) {}",
      "export function registerAcmeTools(reg: ZodToolRegistrar) {}",
      "",
    ].join("\n");
    const { frame, claims } = frameOf(SHIM);
    expect(applySecondFile(frame, claims, twice)).toEqual({ refused: "unparseable" });
  });

  it("refuses a server that is not a shim, so passing tools.ts to one is inert", () => {
    const inline = [
      'import { runReadOnlyMcpConnector } from "../../shared/run-read-only-mcp-connector.ts";',
      'await runReadOnlyMcpConnector("nimbus-acme", (reg) => {',
      '  reg("acme_list", "List things.", {}, async () => ({ ok: true }));',
      "});",
      "",
    ].join("\n");
    const { frame, claims } = frameOf(inline);
    // "not-a-shim" is the INERT refusal: supplying tools.ts to a non-shim connector must change
    // nothing about it, which is what keeps the plumbing safe for all 94.
    expect(applySecondFile(frame, claims, TOOLS_OK)).toEqual({ refused: "not-a-shim" });
  });

  it("refuses unparseable tools.ts rather than throwing", () => {
    const { frame, claims } = frameOf(SHIM);
    expect(applySecondFile(frame, claims, "const = ;")).toEqual({ refused: "unparseable" });
  });

  it("gives tools.ts its own claim set, so server.ts's byte ranges cannot cover it", () => {
    // The bug this pins is invisible to every other test here, and it is the one that would
    // defeat the whole design: claims are byte RANGES and `covers` is containment, so a tools.ts
    // node checked against server.ts's set is asking whether its offsets fall inside a range
    // claimed in a different file. Both files start at offset 0, so the answer is sometimes yes
    // — and a "yes" silently marks a foreign statement claimed, which is the false `emits` the
    // totality rule exists to prevent.
    //
    // Constructed so the trap fires: a long server whose frame claims a wide byte range, and a
    // SHORT tools.ts whose helper sits entirely inside that range numerically.
    const tools = [
      "function shorten(s: string) { return s.slice(0, 5); }",
      "export function registerAcmeTools(reg: ZodToolRegistrar) {",
      '  reg("acme_list", "List things.", {}, async () => ({ ok: shorten("xyz") }));',
      "}",
      "",
    ].join("\n");
    const spliced = spliceOf(SHIM, tools);

    const helper = spliced.foreign.statements.find((s) => s.type === "FunctionDeclaration");
    expect(helper).toBeDefined();

    // The helper is unclaimed in ITS OWN set...
    expect(spliced.foreignClaims.unclaimed([helper!])).toHaveLength(1);
    // ...and the trap is real rather than hypothetical: the SERVER's set does cover this node, so
    // sharing one set would have marked it claimed.
    expect(spliced.serverClaims.covers(helper!)).toBe(true);
    // ...and asking the SERVER's set is the mistake — asserted explicitly so that anyone who
    // "simplifies" this back to one shared set fails here rather than in a corpus run they
    // cannot reproduce.
    expect(spliced.foreignClaims).not.toBe(spliced.serverClaims);
  });

  it("claims a type-only import so the histogram measures behaviour, not TypeScript's demands", () => {
    // Without this, every shim blocks on the `import type { ZodToolRegistrar }` its own registrar
    // signature requires, and the measurement is noise. Deliberately narrow: type-only.
    const spliced = spliceOf(SHIM, TOOLS_OK);
    expect(spliced.foreignClaims.unclaimed(spliced.foreign.statements)).toHaveLength(0);
  });

  it("claims the inline `import { type X }` spelling too", () => {
    // The same fact, written the other way round. Babel records it on a different node — the
    // specifier rather than the declaration — so reading only one spelling silently blocks half
    // the corpus on an import that binds no value either way.
    const tools = [
      'import { type ZodToolRegistrar } from "../../shared/mcp-tool-kit.ts";',
      "export function registerAcmeTools(reg: ZodToolRegistrar) {}",
      "",
    ].join("\n");
    const spliced = spliceOf(SHIM, tools);
    expect(spliced.foreignClaims.unclaimed(spliced.foreign.statements)).toHaveLength(0);
  });

  it("does NOT claim a value import, which is a real blocker", () => {
    const tools = [
      'import { readFileSync } from "node:fs";',
      "export function registerAcmeTools(reg: ZodToolRegistrar) {",
      '  reg("acme_list", "List.", {}, async () => ({ ok: readFileSync !== undefined }));',
      "}",
      "",
    ].join("\n");
    const spliced = spliceOf(SHIM, tools);
    expect(spliced.foreignClaims.unclaimed(spliced.foreign.statements)).toHaveLength(1);
  });

  it("does NOT claim a bare side-effect import, which binds nothing but runs code", () => {
    const tools = [
      'import "./polyfill.ts";',
      "export function registerAcmeTools(reg: ZodToolRegistrar) {}",
      "",
    ].join("\n");
    const spliced = spliceOf(SHIM, tools);
    expect(spliced.foreignClaims.unclaimed(spliced.foreign.statements)).toHaveLength(1);
  });
});
