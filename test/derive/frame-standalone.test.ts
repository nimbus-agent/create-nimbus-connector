/**
 * The standalone target's frame shape — the one part of this generator's own output that is
 * fully verifiable in CI with no AGPL Nimbus checkout, since every input here is emitted by
 * this repository's own `generate()` rather than read from the monorepo. See
 * src/derive/server/index.ts's `isStandaloneKitImport` and `isInlinedRunReadOnlyHelper` for the
 * two predicates this exercises, and test/derive/round-trip.test.ts for the monorepo-target
 * round trip these same fixtures already prove.
 */
import { beforeAll, describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { initParser, parseModule } from "../../src/derive/ast.ts";
import { createClaimSet } from "../../src/derive/claims.ts";
import { functionName, typeAliasName } from "../../src/derive/read.ts";
import { frameFailureKind, recognizeFrame } from "../../src/derive/server/index.ts";
import { generate } from "../../src/emit/index.ts";
import { formatAll, initFormatter } from "../../src/format.ts";
import { parseSpec } from "../../src/spec.ts";

beforeAll(async () => {
  await initFormatter();
  await initParser();
});

function standaloneServer(fixture: string): string {
  const raw = JSON.parse(readFileSync(`fixtures/${fixture}.spec.json`, "utf8"));
  const files = formatAll(generate(parseSpec(raw), { target: "standalone" }));
  return files.find((f) => f.path.join("/") === "src/server.ts")!.content;
}

describe("recognizeFrame reads this generator's standalone output", () => {
  it("accepts the rest-kit standalone frame", () => {
    const frame = recognizeFrame(parseModule(standaloneServer("zzstandalone")), createClaimSet());
    expect(frame?.style).toBe("rest-kit");
    expect(frame?.name).toBe("zzstandalone");
  });

  it("accepts the read-only-kit standalone frame and claims the inlined helper", () => {
    const claims = createClaimSet();
    const body = parseModule(standaloneServer("zzreadonly"));
    const frame = recognizeFrame(body, claims);
    expect(frame?.style).toBe("read-only-kit");

    // The inlined `async function runReadOnlyMcpConnector` and the `type ZodToolRegistrar`
    // alias its signature names must not reach the totality rule as unclaimed statements —
    // checked by IDENTITY, not by bare node type: this fixture's `headers()`/`zzGet()` fetch
    // helpers are also FunctionDeclarations and are legitimately still unclaimed here, since
    // only recognizeFrame has run (recognizeEnv/recognizeFetchHelper claim those two, and
    // don't run in this test) — a type-only assertion would flag them as false positives.
    const unclaimed = claims.unclaimed(frame!.verifyStatements);
    expect(unclaimed.some((n) => functionName(n) === "runReadOnlyMcpConnector")).toBe(false);
    expect(unclaimed.some((n) => typeAliasName(n) === "ZodToolRegistrar")).toBe(false);
  });

  it("still rejects a module with no kit import at all", () => {
    expect(recognizeFrame(parseModule("const a = 1;\n"), createClaimSet())).toBeUndefined();
  });
});

/**
 * I1 (final whole-branch review): `frameFailureKind` used to check only the monorepo signals
 * (`hasMcpToolKitImport`, `RUN_READ_ONLY_SUFFIX`) even though `recognizeFrame` and
 * `recognizeReadOnlyFrame` had already been widened to the standalone ones
 * (`isStandaloneKitImport`, `isInlinedRunReadOnlyHelper`). A standalone module whose frame import
 * is fine but fails on a LATER element was mislabeled "frame:no-kit-import" — telling the user to
 * add an import already on line 1. Both cases below are built from THIS repo's own standalone
 * output (never hand-written connector-shaped source) with exactly one later element broken, and
 * pin the label the correctly-widened discriminator produces instead of the misleading one.
 */
describe("frameFailureKind reads this generator's standalone output", () => {
  it("names the real break (no-connect), not no-kit-import, for a rest-kit standalone module", () => {
    // Element 1 (the "@nimbus-dev/sdk/connector-kit" import) is untouched and present; only
    // element 5 (the connect call's own argument) is broken. The old unwidened check found no
    // "/mcp-tool-kit.ts" import (standalone never has one) and reported "no-kit-import" before
    // ever looking at the connect call at all.
    const source = standaloneServer("zzstandalone").replace(
      "await server.connect(transport);",
      "await server.connect(other);",
    );
    expect(frameFailureKind(parseModule(source))).toBe("frame:no-connect");
  });

  it("names the real break (no-mcp-server), not no-kit-import, for a read-only-kit standalone module", () => {
    // Element 1 for a standalone module is the "@nimbus-dev/sdk/connector-kit" import, which is
    // present here and untouched; the old unwidened check looked only for "/mcp-tool-kit.ts",
    // which a standalone module never has, and reported "no-kit-import" — telling the user to add
    // an import already on line 1.
    //
    // The label this pins used to be `frame:readonly-callback-not-inline`, now retired: the ten
    // corpus connectors that bucket named write the THREE-statement shape
    // `recognizeReadOnlyFrame` reads today (test/derive/frame-readonly.test.ts), not this bare
    // named callback, so the bucket was empty and the diagnostic never printed. The form below —
    // a named callback with no `startConnector` and no entrypoint guard — is still refused, and
    // falls through to the hand-rolled branch: kit import present, no top-level McpServer const
    // (the standalone one is declared INSIDE the inlined helper, not at module scope).
    const wrapperCall = [
      'await runReadOnlyMcpConnector("nimbus-zzreadonly", (reg) => {',
      '  reg("zzreadonly_widget_list", "List widgets.", z.object({}), async () =>',
      '    jsonResult(await zzGet("/v1/widgets")),',
      "  );",
      "",
      "  reg(",
      '    "zzreadonly_widget_get",',
      '    "Get one widget by id.",',
      "    z.object({ widgetId: z.string().min(1) }),",
      "    async (p) => jsonResult(await zzGet(`/v1/widgets/${encodeURIComponent(p.widgetId)}`)),",
      "  );",
      "});",
    ].join("\n");
    const namedCallbackForm = [
      "function registerZzreadonlyTools(reg) {",
      '  reg("zzreadonly_widget_list", "List widgets.", z.object({}), async () =>',
      '    jsonResult(await zzGet("/v1/widgets")),',
      "  );",
      "",
      "  reg(",
      '    "zzreadonly_widget_get",',
      '    "Get one widget by id.",',
      "    z.object({ widgetId: z.string().min(1) }),",
      "    async (p) => jsonResult(await zzGet(`/v1/widgets/${encodeURIComponent(p.widgetId)}`)),",
      "  );",
      "}",
      "",
      'await runReadOnlyMcpConnector("nimbus-zzreadonly", registerZzreadonlyTools);',
    ].join("\n");

    const emitted = standaloneServer("zzreadonly");
    expect(emitted).toContain(wrapperCall); // Fails loudly if the emitter's own shape ever drifts.
    const source = emitted.replace(wrapperCall, namedCallbackForm);
    expect(frameFailureKind(parseModule(source))).toBe("frame:no-mcp-server");
  });
});
