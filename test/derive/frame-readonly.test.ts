import { beforeAll, describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { initParser, parseModule } from "../../src/derive/ast.ts";
import { createClaimSet } from "../../src/derive/claims.ts";
import { deriveSpec } from "../../src/derive/index.ts";
import { recognizeFrame } from "../../src/derive/server/index.ts";
import { generate } from "../../src/emit/index.ts";
import { formatAll, initFormatter } from "../../src/format.ts";
import { parseSpec } from "../../src/spec.ts";
import { displayPath } from "../../src/types.ts";

beforeAll(async () => {
  await initFormatter();
  await initParser();
});

/** A read-only-kit module: no McpServer, no transport, tools inside the wrapper callback. */
const READ_ONLY = [
  'import { z } from "zod";',
  'import { runReadOnlyMcpConnector } from "../../shared/run-read-only-mcp-connector.ts";',
  'const BASE = "https://example.test";',
  'await runReadOnlyMcpConnector("nimbus-zzreadonly", (reg) => {',
  '  reg("a", "d", z.object({}), async () => jsonResult(await zzGet("/a")));',
  "});",
].join("\n");

/**
 * A refused module must claim NOTHING — see recognizeReadOnlyFrame's docstring in
 * src/derive/server/index.ts. A recognizer that partially claims a module it ultimately
 * refuses would leave the totality rule reporting blockers for statements a DIFFERENT recognizer
 * would have claimed, which reads as a spec-language gap when it is a wrong-recognizer gap. Every
 * rejection case below is routed through this so that property is checked on each pin, not just
 * asserted once in the abstract.
 */
function expectRejected(source: string): void {
  const claims = createClaimSet();
  expect(recognizeFrame(parseModule(source), claims)).toBeUndefined();
  expect(claims.claims()).toEqual([]);
}

describe("recognizeFrame, read-only-kit", () => {
  it("recovers the name and style", () => {
    const frame = recognizeFrame(parseModule(READ_ONLY), createClaimSet());
    expect(frame?.name).toBe("zzreadonly");
    expect(frame?.style).toBe("read-only-kit");
  });

  it("hands the callback body to the tool recognizers, not the wrapper", () => {
    const frame = recognizeFrame(parseModule(READ_ONLY), createClaimSet());
    expect(frame?.toolStatements).toHaveLength(1);
    expect(frame?.toolStatements[0]?.type).toBe("ExpressionStatement");
  });

  it("swaps exactly one statement: the wrapper, for its body", () => {
    const statements = parseModule(READ_ONLY);
    const frame = recognizeFrame(statements, createClaimSet());
    // 4 top-level statements; the wrapper is replaced by its single inner statement.
    expect(statements).toHaveLength(4);
    expect(frame?.verifyStatements).toHaveLength(4);
    // The base const is still there to be claimed or blocked — the swap is not a switch from
    // checking the module to checking the callback.
    expect(frame?.verifyStatements.some((s) => s.type === "VariableDeclaration")).toBe(true);
    // The length check above passes whether or not the splice happened — the fixture's callback
    // has exactly 1 statement, the same count as the single wrapper statement it replaces — so it
    // does not by itself discriminate a swap from a no-op. Assert the swap directly: the wrapper
    // statement (the fourth top-level statement, the `await runReadOnlyMcpConnector(...)` call
    // itself) must be gone from verifyStatements, replaced by its callback body's statement.
    const wrapper = statements[3];
    expect(frame?.verifyStatements).not.toContain(wrapper);
    expect(frame?.verifyStatements).toContain(frame?.toolStatements[0]);
  });

  it("NEVER claims the wrapper, so a statement inside it stays visible", () => {
    // The containment hazard, asserted directly against the SPECIFIC statement it would hide,
    // not merely "something is unclaimed" — recognizeReadOnlyFrame claims only imports, so
    // `const BASE = ...` is unclaimed regardless of what happens to the wrapper. That made the
    // original version of this assertion (`unclaimed.length > 0`) pass even when the wrapper WAS
    // claimed, because the wrapper claim just reduced 3 unclaimed statements to 1 rather than 0.
    // Pointing at the unrecognized call inside the callback closes that gap: if the wrapper were
    // ever claimed, containment would cover this statement too, and `covers` below would flip.
    const source = READ_ONLY.replace("});", "  someUnrecognizedCall();\n});");
    const statements = parseModule(source);
    const claims = createClaimSet();
    const frame = recognizeFrame(statements, claims);

    const inner = frame!.toolStatements[1]!;
    expect(inner.type).toBe("ExpressionStatement");
    expect(claims.covers(inner)).toBe(false);
    expect(claims.unclaimed(frame!.verifyStatements)).toContain(inner);
  });

  it("rejects a wrapper whose callback is not a single-parameter arrow", () => {
    expectRejected(READ_ONLY.replace("(reg) =>", "(reg, extra) =>"));
  });

  it("rejects a non-awaited wrapper — the emitter always writes await", () => {
    expectRejected(READ_ONLY.replace("await runReadOnly", "runReadOnly"));
  });

  it("rejects a wrapper whose sole parameter is not named exactly `reg`", () => {
    expectRejected(READ_ONLY.replace("(reg) =>", "(registrar) =>"));
  });

  it("rejects a wrapper whose callback is expression-bodied rather than a block", () => {
    const source = [
      'import { z } from "zod";',
      'import { runReadOnlyMcpConnector } from "../../shared/run-read-only-mcp-connector.ts";',
      'await runReadOnlyMcpConnector("nimbus-zzreadonly", (reg) => reg("a", "d", z.object({}), async () => jsonResult(await zzGet("/a"))));',
    ].join("\n");
    expectRejected(source);
  });

  it('rejects a connector-name literal missing the "nimbus-" prefix', () => {
    expectRejected(READ_ONLY.replace('"nimbus-zzreadonly"', '"zzreadonly"'));
  });

  it("rejects a wrapper call with a third argument — arity is pinned at exactly 2", () => {
    expectRejected(READ_ONLY.replace("});", "}, true);"));
  });

  it("refuses (rather than picking one) when a module has two wrappers", () => {
    const source = [
      'import { z } from "zod";',
      'import { runReadOnlyMcpConnector } from "../../shared/run-read-only-mcp-connector.ts";',
      'await runReadOnlyMcpConnector("nimbus-zzreadonly", (reg) => {',
      '  reg("a", "d", z.object({}), async () => jsonResult(await zzGet("/a")));',
      "});",
      'await runReadOnlyMcpConnector("nimbus-zzreadonly", (reg) => {',
      '  reg("b", "d2", z.object({}), async () => jsonResult(await zzGet("/b")));',
      "});",
    ].join("\n");
    expectRejected(source);
  });

  it("requires the run-read-only import source to end on a path SEGMENT, not merely a substring", () => {
    // "shared-run-read-only-mcp-connector.ts" ends with the same characters as the real suffix
    // but with no preceding "/" — a hypothetical sibling file, not the emitter's own import. The
    // whole module is refused (falls through to the hand-rolled branch, which also does not
    // match), not just this one statement.
    expectRejected(
      READ_ONLY.replace("/run-read-only-mcp-connector.ts", "-run-read-only-mcp-connector.ts"),
    );
  });

  it("rejects an async callback — the emitter never writes async (reg) =>", () => {
    expectRejected(READ_ONLY.replace("(reg) =>", "async (reg) =>"));
  });
});

/**
 * One replacement, proving it fired EXACTLY once — see the identical helper in frame.test.ts for
 * why both halves of that matter.
 */
function rewrite(source: string, from: string, to: string): string {
  expect(source.split(from)).toHaveLength(2);
  return source.replace(from, to);
}

/**
 * A fixture's emitted `src/server.ts` and `nimbus.extension.json`.
 *
 * The named-registrar module below is built by surgery on THIS repository's own zzreadonly
 * output, never transcribed from a real connector: `src/`, `test/` and `fixtures/` may not carry
 * AGPL connector source (CLAUDE.md's licensing constraint). It is also the stronger test — the
 * canonical counterpart exists, so the derived spec can be compared to it field for field.
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

const RUN_IMPORT =
  'import { runReadOnlyMcpConnector } from "../../shared/run-read-only-mcp-connector.ts";';

/**
 * zzreadonly's emitted `src/server.ts`, rewritten into the three-statement named-registrar shape
 * the ten corpus connectors write:
 *
 *   export function register<X>Tools(reg: ZodToolRegistrar): void { … }
 *   export async function startConnector(): Promise<void> {
 *     await runReadOnlyMcpConnector("nimbus-<x>", register<X>Tools);
 *   }
 *   if (import.meta.main) await startConnector();
 *
 * The type-only `ZodToolRegistrar` specifier joins the run-read-only import because that is where
 * those ten get it from; it also proves the frame still claims that import when it carries a
 * second specifier. The two-line `//` comment six of the ten write above `startConnector` is
 * deliberately NOT reproduced — the other four omit it, so no matcher may discriminate on it.
 */
function namedRegistrarForm(source: string): string {
  const withTypeImport = rewrite(
    source,
    RUN_IMPORT,
    [
      "import {",
      "  runReadOnlyMcpConnector,",
      "  type ZodToolRegistrar,",
      '} from "../../shared/run-read-only-mcp-connector.ts";',
    ].join("\n"),
  );
  const opened = rewrite(
    withTypeImport,
    'await runReadOnlyMcpConnector("nimbus-zzreadonly", (reg) => {',
    "export function registerZzreadonlyTools(reg: ZodToolRegistrar): void {",
  );
  return rewrite(
    opened,
    "\n});",
    [
      "\n}",
      "",
      "export async function startConnector(): Promise<void> {",
      '  await runReadOnlyMcpConnector("nimbus-zzreadonly", registerZzreadonlyTools);',
      "}",
      "",
      "if (import.meta.main) await startConnector();",
    ].join("\n"),
  );
}

/**
 * The named read-only registrar — `argocd`, `bigeye`, `flux`, `looker`, `mlflow`, `monte-carlo`,
 * `powerbi`, `snowflake`, `tableau`, `workday`.
 *
 * Case 2 under docs/ROADMAP.md's *Shape variance the emitter models one way*: `renderTools` writes
 * the inline `(reg) => { … }` arrow, so `emits` — never `server-identical` — is the best a
 * connector in this shape could reach. None of the ten reaches it: recognizing the frame carries
 * them PAST the frame, and they then block on statement-level constructs behind it. That is the
 * measured outcome, and it is what this widening was for.
 *
 * Which is exactly why these assertions carry the whole weight. `diff:golden` cannot check this
 * widening — no fixture byte-matches through it — and neither can the corpus tiers, since nothing
 * moves. These tests are the only thing standing between a correct recognizer and a wrong one,
 * which is why the recovery test is deep equality against the canonical derivation rather than a
 * hand-listed set of fields.
 */
describe("recognizeFrame, the named read-only registrar", () => {
  it("recovers the name and style", () => {
    const source = namedRegistrarForm(emitted("zzreadonly").server);
    const frame = recognizeFrame(parseModule(source), createClaimSet());
    expect(frame?.name).toBe("zzreadonly");
    expect(frame?.style).toBe("read-only-kit");
  });

  it("hands the tool recognizers the register function's BODY, not the declaration", () => {
    const source = namedRegistrarForm(emitted("zzreadonly").server);
    const frame = recognizeFrame(parseModule(source), createClaimSet());
    // zzreadonly registers two widgets; both must arrive as the registrar body's own statements.
    expect(frame?.toolStatements).toHaveLength(2);
    expect(frame?.toolStatements.map((s) => s.type)).toEqual([
      "ExpressionStatement",
      "ExpressionStatement",
    ]);
  });

  // The two-list contract (src/derive/server/frame.ts): the declaration is removed from
  // verifyStatements and its body spliced in, exactly as the inline wrapper is — one more
  // statement, same treatment. Asserted directly against the declaration node rather than by
  // counting, since the register function's body happens to have two statements and a count alone
  // would not discriminate a splice from a no-op.
  it("splices the register declaration out of verifyStatements, replacing it with its body", () => {
    const source = namedRegistrarForm(emitted("zzreadonly").server);
    const statements = parseModule(source);
    const frame = recognizeFrame(statements, createClaimSet());

    const declaration = statements.find((s) => s.type === "ExportNamedDeclaration");
    expect(declaration).toBeDefined();
    expect(frame?.verifyStatements).not.toContain(declaration);
    for (const tool of frame?.toolStatements ?? []) {
      expect(frame?.verifyStatements).toContain(tool);
    }
    // startConnector and the import.meta.main guard are NOT spliced — they nest no registration,
    // so they stay in the list and are claimed outright.
    expect(frame?.verifyStatements.some((s) => s.type === "IfStatement")).toBe(true);
  });

  it("NEVER claims the register declaration, so a statement inside it stays visible", () => {
    const source = namedRegistrarForm(emitted("zzreadonly").server);
    const statements = parseModule(source);
    const claims = createClaimSet();
    const frame = recognizeFrame(statements, claims);

    // Pointed at a SPECIFIC statement the declaration's range contains: if the declaration were
    // ever claimed, containment would cover this registration and `covers` would flip.
    const inner = frame?.toolStatements[0];
    expect(inner).toBeDefined();
    expect(claims.covers(inner!)).toBe(false);
    expect(claims.unclaimed(frame!.verifyStatements)).toContain(inner!);
    // startConnector and the guard, by contrast, ARE claimed.
    const guard = frame!.verifyStatements.find((s) => s.type === "IfStatement")!;
    expect(claims.covers(guard)).toBe(true);
  });

  // Condition (b): every spec field recovered from this shape is correct. Deep equality against
  // the canonical derivation is stronger than listing fields by hand — it cannot forget one.
  it("derives the same spec from the named registrar as from the inline wrapper", () => {
    const files = emitted("zzreadonly");
    const canonical = deriveSpec(files);
    const named = deriveSpec({ ...files, server: namedRegistrarForm(files.server) });
    if (!canonical.ok) throw new Error(canonical.blockers.map((b) => b.kind).join(", "));
    if (!named.ok) throw new Error(named.blockers.map((b) => b.kind).join(", "));
    expect(named.spec).toEqual(canonical.spec);
  });

  /**
   * The crux, and the reason `register<X>Tools`' declaration is removed from `verifyStatements`
   * instead of being marked claimed once its body statements are.
   *
   * Claims are byte ranges and coverage is CONTAINMENT, so claiming the declaration would cover
   * every registration inside it transitively: the totality rule would find nothing unclaimed and
   * a connector whose tools were never recognized would derive successfully — a false `emits`
   * produced by the very mechanism the rule exists to remove (src/derive/server/frame.ts).
   *
   * The assertion that matters is `ok: false`. If this ever returns `ok: true`, the declaration is
   * being claimed and the frame is producing false derivations — fix the claim, not the test.
   */
  it("does NOT derive when a spliced registration is unrecognized", () => {
    const files = emitted("zzreadonly");
    const module = namedRegistrarForm(files.server);
    // The first `reg(` is the first registration inside the register function's body — the
    // declaration's own `registerZzreadonlyTools(reg: ZodToolRegistrar)` contains no such
    // substring. Replaced by a call no recognizer models.
    const source = module.replace("reg(", "somethingElse(");
    expect(source).not.toBe(module);
    const result = deriveSpec({ ...files, server: source });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.blockers.some((b) => b.kind === "call:somethingElse")).toBe(true);
    }
  });

  it("rejects a startConnector naming a function the module does not declare", () => {
    const module = namedRegistrarForm(emitted("zzreadonly").server);
    expectRejected(
      rewrite(
        module,
        '"nimbus-zzreadonly", registerZzreadonlyTools)',
        '"nimbus-zzreadonly", other)',
      ),
    );
  });

  it("rejects an import.meta.main guard calling something other than startConnector", () => {
    const module = namedRegistrarForm(emitted("zzreadonly").server);
    expectRejected(
      rewrite(
        module,
        "if (import.meta.main) await startConnector();",
        "if (import.meta.main) await other();",
      ),
    );
  });

  // `ZodToolRegistrar` is the only parameter in all ten. A second one is a registrar shape neither
  // this emitter nor the corpus writes, and the tool recognizers would be reading a body whose
  // scope they had only half accounted for.
  it("rejects a register function taking two parameters", () => {
    const module = namedRegistrarForm(emitted("zzreadonly").server);
    expectRejected(
      rewrite(
        module,
        "(reg: ZodToolRegistrar): void {",
        "(reg: ZodToolRegistrar, extra: unknown): void {",
      ),
    );
  });

  // The guard is CLAIMED, so its test is pinned rather than taken on trust: claiming
  // `if (<anything>) await startConnector();` would grant coverage to a statement whose condition
  // this frame never verified.
  it("rejects a guard whose test is not import.meta.main", () => {
    const module = namedRegistrarForm(emitted("zzreadonly").server);
    expectRejected(rewrite(module, "if (import.meta.main)", "if (process.env.MAIN)"));
  });

  it("rejects a module with the named registrar but no entrypoint guard at all", () => {
    const module = namedRegistrarForm(emitted("zzreadonly").server);
    expectRejected(rewrite(module, "\n\nif (import.meta.main) await startConnector();", ""));
  });

  // startConnector is claimed whole, so its body is pinned to exactly the one awaited call. A
  // second statement inside it would ride in on the declaration's byte range unverified.
  it("rejects a startConnector whose body is more than the wrapper call", () => {
    const module = namedRegistrarForm(emitted("zzreadonly").server);
    expectRejected(
      rewrite(
        module,
        '  await runReadOnlyMcpConnector("nimbus-zzreadonly", registerZzreadonlyTools);',
        '  console.log("starting");\n  await runReadOnlyMcpConnector("nimbus-zzreadonly", registerZzreadonlyTools);',
      ),
    );
  });
});
