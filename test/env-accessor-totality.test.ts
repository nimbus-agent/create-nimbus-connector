import { describe, expect, it } from "bun:test";
import { renderEnvAccessor, TRIM_TRAILING_SLASH_FN } from "../src/emit/server/env.ts";
import { EnvSchema, type EnvSpec, parseSpec } from "../src/spec.ts";

/**
 * Every env accessor the schema accepts, RUN — not read, and not typechecked either.
 *
 * The defect this file closes is the minimal entry: `{ "vars": ["X"], "local": "acc" }`, with
 * `required` left at its schema default of `false`. It emits
 * `function acc(): string { const x = process.env["X"]?.trim(); return x; }` — TS2322 in the
 * generated package — and no fixture has that shape, so `diff:golden` never saw it.
 *
 * A test that asserted the refusal message would have been worth nothing: the refusal is the
 * fix, and restating it proves only that the schema agrees with itself. What this file asserts
 * instead is the PROPERTY the rule exists to protect — an env accessor is total. With its
 * variable unset it either throws a named error or returns a real value; it never hands back
 * `undefined`, and never the literal text "undefined" spliced into a URL.
 *
 * That property is checked by EXECUTING the emitted accessor, because three of the six broken
 * shapes typecheck. `prefix`/`suffix` splice the binding into a template literal, so
 * `` return `https://${zzUrl}` `` compiles clean and returns `"https://undefined"`. A compiler
 * cannot see that one; running it is the only thing that can.
 */

/** The variable is deliberately never set, so `process.env[…]` is undefined for every shape. */
const VAR = "ZZ_ACCESSOR_TOTALITY_UNSET";

/**
 * Every field of a non-auth entry that changes what the accessor returns, with every value it
 * can take. `auth` is excluded because every auth branch guards unconditionally
 * (`guardLines`' `needsGuard` is `required || auth !== undefined`), which is the half of the
 * space this rule does not touch.
 */
const AXES = {
  required: [undefined, false, true],
  default: [undefined, "fallback"],
  transform: [undefined, "stripTrailingSlash", "trimTrailingSlashFn"],
  prefix: [undefined, "p-"],
  suffix: [undefined, "-s"],
} as const;

type Shape = { readonly label: string; readonly fields: Record<string, unknown> };

function crossProduct(): Shape[] {
  let shapes: Shape[] = [{ label: "", fields: {} }];
  for (const [key, values] of Object.entries(AXES)) {
    shapes = shapes.flatMap((s) =>
      (values as readonly unknown[]).map((v) => ({
        label: v === undefined ? s.label : `${s.label} ${key}=${String(v)}`,
        fields: v === undefined ? s.fields : { ...s.fields, [key]: v },
      })),
    );
  }
  return shapes.map((s) => ({ ...s, label: s.label.trim() === "" ? "(bare)" : s.label.trim() }));
}

const SHAPES = crossProduct();

/**
 * The emitted accessor's value with the variable unset, or the error it threw.
 *
 * Transpiled and invoked rather than compiled: `Bun.Transpiler` strips the type annotations that
 * make the emitted text invalid JavaScript, and `process` is passed in as a parameter so the
 * accessor reads an empty environment whatever the test runner's own env holds.
 *
 * The `new Function` here evaluates emitter output built from `AXES` and `VAR`, both literals in
 * this file — no spec, fixture or environment value reaches it. That boundary is the reason this
 * is a test and not something the generator itself does.
 */
function runAccessor(
  e: EnvSpec,
): { threw: true; error: unknown } | { threw: false; value: unknown } {
  const source = [
    ...(e.transform === "trimTrailingSlashFn" ? [TRIM_TRAILING_SLASH_FN] : []),
    renderEnvAccessor(e),
  ].join("\n\n");
  const js = new Bun.Transpiler({ loader: "ts" }).transformSync(source);
  const call = new Function("process", `${js}\nreturn ${e.local}();`) as (p: unknown) => unknown;
  try {
    return { threw: false, value: call({ env: {} }) };
  } catch (error) {
    return { threw: true, error };
  }
}

/** The entry a shape denotes, built without the schema so a REFUSED shape can still be run. */
function unchecked(fields: Record<string, unknown>): EnvSpec {
  return {
    vars: [VAR],
    local: "acc",
    required: false,
    ...fields,
  } as EnvSpec;
}

describe("every env accessor the schema accepts is total", () => {
  const accepted = SHAPES.filter((s) => EnvSchema.safeParse(unchecked(s.fields)).success);
  const refused = SHAPES.filter((s) => !EnvSchema.safeParse(unchecked(s.fields)).success);

  it("explores a space with both outcomes in it", () => {
    expect(SHAPES).toHaveLength(72);
    expect(accepted.length).toBeGreaterThan(0);
    expect(refused.length).toBeGreaterThan(0);
    // Both arms of the property below have to be exercised, or "throws its own error or returns
    // a value" is satisfiable by a space in which nothing ever throws.
    const outcomes = accepted.map((s) => runAccessor(EnvSchema.parse(unchecked(s.fields))).threw);
    expect(outcomes).toContain(true);
    expect(outcomes).toContain(false);
  });

  for (const shape of accepted) {
    it(`throws its own error, or returns a real value: ${shape.label}`, () => {
      const result = runAccessor(EnvSchema.parse(unchecked(shape.fields)));
      if (result.threw) {
        // The connector's OWN diagnostic, naming the variable the operator has to set — not a
        // TypeError from a method call on an undefined binding, which is what the refused
        // shapes below produce.
        expect(result.error).toBeInstanceOf(Error);
        expect(result.error).not.toBeInstanceOf(TypeError);
        expect((result.error as Error).message).toBe(`${VAR} is not set`);
        return;
      }
      expect(typeof result.value).toBe("string");
      expect(result.value as string).not.toContain("undefined");
    });
  }
});

/**
 * The other direction: nothing is refused that would have worked.
 *
 * Each shape below is built WITHOUT the schema and run anyway, so the rule is justified by the
 * accessor it would have emitted rather than by its own message. A shape that came back with a
 * usable value would be an over-rejection — a spec refused for a defect it does not have.
 *
 * Scoped BEHAVIOURALLY, not by restating the predicate: a shape belongs to this rule when adding
 * `"required": true` is what makes the schema accept it. The first draft of this block took every
 * refused shape and failed on twelve of them — `required` + `default` together, which the
 * neighbouring rule refuses and whose accessor returns its default perfectly well. That rule's
 * shapes are not this one's to justify.
 */
describe("every shape this rule refuses would have emitted a defective accessor", () => {
  const refused = SHAPES.filter(
    (s) =>
      !EnvSchema.safeParse(unchecked(s.fields)).success &&
      EnvSchema.safeParse(unchecked({ ...s.fields, required: true })).success,
  );

  it("finds shapes to check, and fewer than the schema refuses in total", () => {
    const allRefused = SHAPES.filter((s) => !EnvSchema.safeParse(unchecked(s.fields)).success);
    expect(refused.length).toBeGreaterThan(0);
    expect(refused.length).toBeLessThan(allRefused.length);
  });

  for (const shape of refused) {
    it(`is refused for cause: ${shape.label}`, () => {
      const result = runAccessor(unchecked(shape.fields));
      // What every member has in common is what it does NOT do: produce the guard's own
      // "<VAR> is not set". A `transform` shape calls a string method on an undefined binding
      // and dies with a TypeError; every other shape hands back `undefined`, bare or spliced
      // into the returned text.
      if (result.threw) {
        expect(result.error).toBeInstanceOf(TypeError);
        return;
      }
      expect(String(result.value)).toContain("undefined");
    });
  }
});

describe("the reproduction, refused at parse time", () => {
  const spec = (entry: Record<string, unknown>): unknown => ({
    name: "zzmin",
    displayName: "Zz Min",
    description: "Minimal connector.",
    serviceLabel: "ZzMin",
    style: "hand-rolled",
    env: [
      { vars: ["ZZ_URL"], local: "apiRoot", ...entry },
      { vars: ["ZZ_TOKEN"], local: "authHeaders", auth: "bearer" },
    ],
    fetchHelper: { local: "zzGet", base: "https://${env.apiRoot}", headers: "authHeaders" },
    tools: [{ name: "zzmin_get", description: "Get.", path: "/v1/things" }],
  });

  it("refuses the minimal entry, naming the emitted return type", () => {
    expect(() => parseSpec(spec({}))).toThrow(/must set "required": true/);
    expect(() => parseSpec(spec({}))).toThrow(/string \| undefined/);
  });

  it("accepts the two spellings the message names", () => {
    expect(() => parseSpec(spec({ required: true }))).not.toThrow();
    expect(() => parseSpec(spec({ default: "https://api.example.com" }))).not.toThrow();
  });
});
