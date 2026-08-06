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
    expect(tools).toEqual({
      tools: [],
      staticPathStyles: [],
      schemaShapes: [],
      basePrefixes: [],
    });
    expect(claims.claims()).toEqual([]);
  });
});

/** A `makeRestToolRegistrar(...)` factory plus whatever `<registrar>(...)` calls the caller supplies. */
function restModule(calls: string): string {
  return [
    "const registerZzTool = makeRestToolRegistrar({",
    "  registrar: reg,",
    '  tokenEnv: "ZZ_TOKEN",',
    '  serviceLabel: "Zz",',
    "  fetch: zzFetch,",
    "});",
    "",
    calls,
  ].join("\n");
}

// The bodyless DELETE: arity 5, a zero-param init callback, `{ method: "DELETE" }` — no `body`
// key at all, which is what `renderTool` writes when the tool's default body is empty (every arg
// is carried by the path).
const DELETE_CALL = [
  "registerZzTool(",
  '  "zz_item_delete",',
  '  "Delete an item.",',
  "  z.object({ itemId: z.string().min(1) }),",
  "  (parsed) => `/things/${encodeURIComponent(parsed.itemId)}`,",
  '  () => ({ method: "DELETE" }),',
  ");",
].join("\n");

// The PATCH-with-body: arity 5, a one-param init callback, `{ method: "PATCH", body: … }`. Its
// `mode` arg is hoisted (with a default) in the PATH callback but referenced INLINE in the INIT
// callback — the same arg, two different expressions — which is what pins `hoistsInScope: false`
// at this call site rather than merely asserting it at the recognizeBodyExpr unit level (already
// covered by test/derive/body.test.ts's "contract for the rest-kit caller" tests). Its observed
// body (`title`, `mode`) differs from the DEFAULT (`title` alone — `mode` is in the path) by one
// key, so it also exercises the explicit-mapping path, not just the omit-when-default one.
const PATCH_CALL = [
  "registerZzTool(",
  '  "zz_item_update",',
  '  "Update an item.",',
  "  z.object({ itemId: z.string().min(1), title: z.string().min(1), mode: z.string().optional() }),",
  "  (parsed) => {",
  '    const mode = parsed.mode ?? "merge";',
  "    return `/things/${encodeURIComponent(parsed.itemId)}?mode=${mode}`;",
  "  },",
  "  (parsed) => ({",
  '    method: "PATCH",',
  '    body: JSON.stringify({ title: parsed.title, mode: parsed.mode ?? "merge" }),',
  "  }),",
  ");",
].join("\n");

const REST_WRITE = restModule([DELETE_CALL, "", PATCH_CALL].join("\n\n"));

describe("recognizeRestTools reads the arity-5 initFn", () => {
  it("recovers method and body from a bodyless DELETE and a PATCH with an explicit body", () => {
    const statements = parseModule(REST_WRITE);
    const claims = createClaimSet();
    const tools = recognizeRestTools(statements, claims, "registerZzTool");
    expect(tools?.tools.map((t) => ({ name: t.name, method: t.method, body: t.body }))).toEqual([
      { name: "zz_item_delete", method: "DELETE", body: undefined },
      { name: "zz_item_update", method: "PATCH", body: { title: "title", mode: "mode" } },
    ]);
    // Both calls claimed, same as any other successful recognizeRestTools result — the factory
    // (statement 0) is a different recognizer's concern, so it is deliberately excluded.
    expect(claims.covers(statements[1]!)).toBe(true);
    expect(claims.covers(statements[2]!)).toBe(true);
  });

  /**
   * Every shape `recognizeInitFn` must refuse, as a mutation of a module the emitter actually
   * writes — so each row is provably one edit away from a producible shape, and each asserts it
   * changed something before asserting the refusal (a corruption that silently no-ops proves
   * nothing).
   */
  const REFUSED_INIT_FNS: ReadonlyArray<readonly [string, string, string]> = [
    [
      "a fifth argument that is not an arrow",
      '  () => ({ method: "DELETE" }),',
      "  someBespokeInitFn,",
    ],
    [
      // Two keys, not three: the object already has one (`method`), and this adds a second whose
      // NAME is wrong (`extra`, not `body`) — the genuine three-key case is already refused by
      // `props.length`'s own gate and needs no separate row. This is what actually forces
      // `bodyProp.key !== "body"` to fire.
      "a second key that is not `body`",
      '() => ({ method: "DELETE" }),',
      '() => ({ method: "DELETE", extra: 1 }),',
    ],
    [
      // `renderTool` always writes `method` first — `objectProps` preserves source order, so a
      // `body`-before-`method` object is a shape the emitter cannot write. Load-bearing on
      // `methodProp.key !== "method"` seeing "body" in that slot instead, not merely on the key
      // being present somewhere in the object.
      "a `body` key before `method` — renderTool always writes `method` first",
      '    method: "PATCH",\n    body: JSON.stringify({ title: parsed.title, mode: parsed.mode ?? "merge" }),',
      '    body: JSON.stringify({ title: parsed.title, mode: parsed.mode ?? "merge" }),\n    method: "PATCH",',
    ],
    [
      // `renderTool`'s `initArg` never writes `async` here — the same pin `read.ts`'s `isAsync`
      // documents elsewhere, and the ONE guard in `recognizeInitFn`'s four-disjunct check that
      // nothing downstream re-catches: `arrow.isBlock` is redundant with `objectProps` refusing a
      // block body, and a params mismatch is re-caught by the `props.length` branches below, but
      // an async arrow's params and body shape are otherwise identical to the non-async form.
      "an async init arrow — renderTool never writes async here",
      '() => ({ method: "DELETE" }),',
      'async () => ({ method: "DELETE" }),',
    ],
    [
      "a parameter with no body — renderTool's initParam is `()` when there is nothing to reference",
      '() => ({ method: "DELETE" }),',
      '(parsed) => ({ method: "DELETE" }),',
    ],
    [
      "a body with no parameter — renderTool's initParam is `(parsed)` whenever body references it",
      "  (parsed) => ({",
      "  () => ({",
    ],
  ];

  it.each(REFUSED_INIT_FNS)("refuses %s", (_name, from, to) => {
    const pristine = REST_WRITE;
    const corrupted = pristine.replace(from, to);
    expect(corrupted).not.toBe(pristine);

    const claims = createClaimSet();
    expect(recognizeRestTools(parseModule(corrupted), claims, "registerZzTool")).toBeUndefined();
    // All-or-nothing: the OTHER call (PATCH, still well-formed) stays unclaimed too.
    expect(claims.claims()).toEqual([]);
  });
});
