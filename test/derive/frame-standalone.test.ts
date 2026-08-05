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
import { recognizeFrame } from "../../src/derive/server/index.ts";
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
