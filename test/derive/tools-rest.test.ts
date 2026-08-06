import { beforeAll, describe, expect, it } from "bun:test";
import { initParser, parseModule } from "../../src/derive/ast.ts";
import { createClaimSet } from "../../src/derive/claims.ts";
import { recognizeRestRegistrar, recognizeRestTools } from "../../src/derive/server/tools-rest.ts";

beforeAll(async () => {
  await initParser();
});

const REST = [
  "const registerZzTool = makeRestToolRegistrar({",
  "  registrar: reg,",
  '  tokenEnv: "ZZ_TOKEN",',
  '  serviceLabel: "Zz",',
  "  fetch: zzFetch,",
  "});",
  "",
  "registerZzTool(",
  '  "zz_list",',
  '  "List things.",',
  "  z.object({}),",
  '  () => "/things",',
  ");",
].join("\n");

/**
 * A refused module must claim NOTHING — the same "wrong-recognizer gap" property
 * test/derive/frame-readonly.test.ts's `expectRejected` checks: a recognizer that
 * partially claims a module it ultimately refuses leaves the totality rule reporting blockers
 * for statements a DIFFERENT recognizer would have claimed, which reads as a spec-language gap
 * when it is really this recognizer over-claiming. Applies to `recognizeRestRegistrar` in full
 * (a malformed factory has nothing to claim) — `recognizeRestTools`'s own all-or-nothing case is
 * asserted separately below, since the FACTORY is claimed independently there by design; see
 * tools-rest.ts's module docstring.
 */
function expectRegistrarRejected(source: string): void {
  const claims = createClaimSet();
  expect(recognizeRestRegistrar(parseModule(source), claims)).toBeUndefined();
  expect(claims.claims()).toEqual([]);
}

describe("recognizeRestRegistrar", () => {
  it("recovers the factory's fields and the registrar name, claiming only the factory statement", () => {
    const statements = parseModule(REST);
    const claims = createClaimSet();
    const result = recognizeRestRegistrar(statements, claims);

    expect(result).toEqual({
      registrar: "registerZzTool",
      serviceLabel: "Zz",
      tokenEnv: "ZZ_TOKEN",
      fetchLocal: "zzFetch",
    });
    // Statement 0 is the factory const; statement 1 is the (unrelated, from this recognizer's
    // point of view) registerZzTool(...) call — recognizeRestRegistrar never looks at it.
    expect(claims.covers(statements[0]!)).toBe(true);
    expect(claims.covers(statements[1]!)).toBe(false);
  });

  it("rejects a let-bound factory — the emitter only writes const", () => {
    expectRegistrarRejected(REST.replace("const registerZzTool", "let registerZzTool"));
  });

  it("rejects a factory object with an unexpected key", () => {
    expectRegistrarRejected(REST.replace("  fetch: zzFetch,", "  fetch: zzFetch,\n  extra: 1,"));
  });

  it("rejects a factory object missing a required key", () => {
    expectRegistrarRejected(REST.replace('  tokenEnv: "ZZ_TOKEN",\n', ""));
  });

  it("rejects a factory whose keys are out of the emitter's fixed order", () => {
    expectRegistrarRejected(
      REST.replace(
        '  tokenEnv: "ZZ_TOKEN",\n  serviceLabel: "Zz",',
        '  serviceLabel: "Zz",\n  tokenEnv: "ZZ_TOKEN",',
      ),
    );
  });

  it('rejects a factory whose "registrar" key is not bound to the identifier `reg`', () => {
    expectRegistrarRejected(REST.replace("registrar: reg,", "registrar: otherReg,"));
  });

  it("returns undefined and claims nothing when no factory is present at all", () => {
    expectRegistrarRejected('registerZzTool("a", "d", z.object({}), () => "/a");');
  });
});

describe("recognizeRestTools", () => {
  it("recovers each tool and claims the calls, given the registrar's name", () => {
    const statements = parseModule(REST);
    const claims = createClaimSet();
    const tools = recognizeRestTools(statements, claims, "registerZzTool");

    expect(tools?.tools.map((t) => t.name)).toEqual(["zz_list"]);
    expect(claims.covers(statements[1]!)).toBe(true);
    // The factory (statement 0) is NOT this function's concern — recognizeRestRegistrar claims
    // it, separately.
    expect(claims.covers(statements[0]!)).toBe(false);
  });

  it(
    "refuses the whole call set when one call is not understood, without disturbing the " +
      "factory's own (separate) claim",
    () => {
      // All-or-nothing over the CALLS, matching recognizeTools: nine recognized tools and one
      // bespoke handler is not nine-tenths regenerable, it is blocked. Deriving the nine would
      // emit a server.ts missing a tool and misattribute the byte mismatch to formatting. The
      // factory carries no such risk on its own, which is exactly why it is claimed by a
      // different function — see tools-rest.ts's module docstring.
      const source = `${REST}\nregisterZzTool("bad", "d", z.object({}), someBespokeThing);`;
      const statements = parseModule(source);
      const claims = createClaimSet();

      const registrar = recognizeRestRegistrar(statements, claims);
      expect(registrar?.registrar).toBe("registerZzTool");

      const tools = recognizeRestTools(statements, claims, "registerZzTool");
      expect(tools).toBeUndefined();

      // statements[0] = factory (claimed by recognizeRestRegistrar, above).
      // statements[1] = the "zz_list" call, statements[2] = the bad call — NEITHER claimed,
      // because recognizeRestTools refused the whole set.
      expect(claims.covers(statements[0]!)).toBe(true);
      expect(claims.covers(statements[1]!)).toBe(false);
      expect(claims.covers(statements[2]!)).toBe(false);
    },
  );

  it("refuses arity 5 — a non-GET method is plan 2's territory", () => {
    const source = REST.replace(
      '() => "/things",',
      '() => "/things",\n  () => ({ method: "DELETE" }),',
    );
    const claims = createClaimSet();
    expect(recognizeRestTools(parseModule(source), claims, "registerZzTool")).toBeUndefined();
    expect(claims.claims()).toEqual([]);
  });

  it("refuses an async path fn — src/emit/server/tools-rest.ts never writes async here", () => {
    const source = REST.replace('() => "/things",', 'async () => "/things",');
    const claims = createClaimSet();
    expect(recognizeRestTools(parseModule(source), claims, "registerZzTool")).toBeUndefined();
    expect(claims.claims()).toEqual([]);
  });

  it("refuses the query branch (a block whose body contains `const u = new URL(...)`)", () => {
    const source = REST.replace(
      '() => "/things",',
      "(parsed) => {\n    const u = new URL(`https://x.test/things`);\n    return `${u}`;\n  },",
    );
    const claims = createClaimSet();
    expect(recognizeRestTools(parseModule(source), claims, "registerZzTool")).toBeUndefined();
    expect(claims.claims()).toEqual([]);
  });

  it("recovers a path referencing a plain (non-hoisted) arg — the expression-bodied `(parsed) => ...` form", () => {
    const source = REST.replace(
      "  z.object({}),\n" + '  () => "/things",',
      "  z.object({ id: z.string().min(1) }),\n" +
        "  (parsed) => `/things/${encodeURIComponent(parsed.id)}`,",
    );
    const tools = recognizeRestTools(parseModule(source), createClaimSet(), "registerZzTool");
    expect(tools?.tools[0]?.path).toBe("/things/${arg.id|enc}");
  });

  it("recovers a default-hoisted arg in the block form", () => {
    const source = REST.replace(
      "  z.object({}),\n" + '  () => "/things",',
      "  z.object({ mode: z.string().optional() }),\n" +
        "  (parsed) => {\n" +
        '    const mode = parsed.mode ?? "merge";\n' +
        "    return `/things/${mode}`;\n" +
        "  },",
    );
    const statements = parseModule(source);
    const claims = createClaimSet();
    const tools = recognizeRestTools(statements, claims, "registerZzTool");
    expect(tools?.tools[0]?.path).toBe("/things/${arg.mode}");
    expect(tools?.tools[0]?.args.mode).toEqual({
      type: "string",
      optional: true,
      default: "merge",
    });
    expect(claims.covers(statements[1]!)).toBe(true);
  });

  it("recovers a boolean-hoisted arg in the block form, with its `local` name", () => {
    const source = REST.replace(
      "  z.object({}),\n" + '  () => "/things",',
      "  z.object({ onlyOpen: z.boolean() }),\n" +
        "  (parsed) => {\n" +
        '    const oo = parsed.onlyOpen === true ? "true" : "false";\n' +
        "    return `/things?open=${oo}`;\n" +
        "  },",
    );
    const tools = recognizeRestTools(parseModule(source), createClaimSet(), "registerZzTool");
    expect(tools?.tools[0]?.path).toBe("/things?open=${arg.onlyOpen|bool}");
    expect(tools?.tools[0]?.args.onlyOpen).toEqual({ type: "boolean", local: "oo" });
  });

  it("refuses a block form whose non-last statement is not a recognized hoist", () => {
    const source = REST.replace(
      "  z.object({}),\n" + '  () => "/things",',
      "  z.object({}),\n" +
        "  (parsed) => {\n" +
        "    const extra = doSomething();\n" +
        "    return `/things`;\n" +
        "  },",
    );
    const claims = createClaimSet();
    expect(recognizeRestTools(parseModule(source), claims, "registerZzTool")).toBeUndefined();
    expect(claims.claims()).toEqual([]);
  });

  it("returns an empty tools array for zero matching calls — not an ambiguous refusal", () => {
    // Unlike tools-hand.ts's recognizeTools (whose ONLY signal of a hand-rolled connector is a
    // `reg(...)` call, so zero of them is ambiguous between "no tools" and "recognizer
    // failure"), `registrar` here was already positively identified by a separate, successful
    // recognizeRestRegistrar call — there is no "did this even run" question left open.
    const source = [
      "const registerZzTool = makeRestToolRegistrar({",
      "  registrar: reg,",
      '  tokenEnv: "ZZ_TOKEN",',
      '  serviceLabel: "Zz",',
      "  fetch: zzFetch,",
      "});",
    ].join("\n");
    const claims = createClaimSet();
    const tools = recognizeRestTools(parseModule(source), claims, "registerZzTool");
    expect(tools).toEqual({ tools: [], staticPathStyles: [], schemaShapes: [] });
    expect(claims.claims()).toEqual([]);
  });
});
