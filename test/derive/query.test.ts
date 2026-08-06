import { beforeAll, describe, expect, it } from "bun:test";
import { type AstNode, initParser, parseModule } from "../../src/derive/ast.ts";
import { deriveSpec } from "../../src/derive/index.ts";
import { arrowFn, blockBody, callArgs, expressionOf } from "../../src/derive/read.ts";
import { type ArgFields, recognizeArgs } from "../../src/derive/server/args.ts";
import { type HoistSection, splitHoists } from "../../src/derive/server/hoists.ts";
import { recognizeQueryBlock, recognizeQueryLines } from "../../src/derive/server/query.ts";
import { generate } from "../../src/emit/index.ts";
import { formatAll, initFormatter } from "../../src/format.ts";
import { parseSpec } from "../../src/spec.ts";
import { displayPath } from "../../src/types.ts";

/**
 * One rest-kit connector exercising every query shape `renderQueryLines` (src/emit/server/
 * query.ts) writes: an unconditional string entry, an `omitWhen: "absent"` guard, an
 * `omitWhen: "empty"` guard, a NUMBER-typed entry (which `wrapsInString` wraps in `String(...)`)
 * and an entry whose arg is hoisted by a `??` default, so its value expression is the hoisted
 * const rather than `parsed.<arg>`.
 *
 * The input is this repository's own emitter output rather than a hand-written string — the same
 * technique test/derive/search-filter.test.ts uses — so a test asserting on bytes the emitter no
 * longer writes fails here rather than passing against a shape that has moved on.
 *
 * `limit` declares `"optional": true` beside its `"default"` because ArgSchema requires the pair
 * ("a required argument's default can never be reached"); the default is what makes the hoist
 * `const limit = parsed.limit ?? 50;` reachable at all.
 */
const SPEC = {
  name: "zzqueryunit",
  displayName: "ZZ Query Unit",
  description: "Fixture for the query recognizer.",
  serviceLabel: "ZZ Query Unit",
  style: "rest-kit",
  network: ["api.zzqueryunit.test"],
  syncInterval: 600,
  minNimbusVersion: "0.2.0",
  env: [{ vars: ["ZZQUERYUNIT_TOKEN"], local: "restAuthToken", auth: "bearer" }],
  fetchHelper: { local: "zzGet", base: "https://api.zzqueryunit.test" },
  tools: [
    {
      name: "zzqueryunit_list",
      description: "List items.",
      path: "/v1/items",
      args: {
        q: { type: "string" },
        after: { type: "string", optional: true },
        filter: { type: "string", optional: true },
        page: { type: "number", optional: true },
        limit: { type: "number", optional: true, default: 50 },
      },
      query: [
        { name: "q", arg: "q" },
        { name: "after", arg: "after", omitWhen: "absent" },
        { name: "filter", arg: "filter", omitWhen: "empty" },
        { name: "page", arg: "page", omitWhen: "absent" },
        { name: "limit", arg: "limit" },
      ],
    },
  ],
};

/**
 * The same connector with its base hoisted to a module-scope const, so `baseExpr`'s OTHER branch
 * (`` `${BASE}` `` rather than the resolved literal) is what reaches `new URL(...)` — the form
 * discord and google-meet write.
 */
const HOISTED_BASE_SPEC = {
  ...SPEC,
  fetchHelper: { ...SPEC.fetchHelper, baseConst: "ZZ_BASE" },
};

/**
 * A query tool beside a tool whose path is fully static and therefore QUOTED — one of the two
 * pairs `voteStaticPathStyle` would block on if the query tool voted. See the abstention tests.
 */
const MIXED_QUOTED_SPEC = {
  ...SPEC,
  tools: [...SPEC.tools, { name: "zzqueryunit_ping", description: "Ping.", path: "/v1/ping" }],
};

/**
 * The MIRROR of it: the same pair under `staticPathStyle: "template"`, where the static tool
 * votes "template" and a query tool voting "quoted" would block instead. Abstention has two
 * directions and the quoted case alone proves only one — neither `discord` nor `google-meet`
 * covers this one, both using the schema's "quoted" default.
 */
const MIXED_TEMPLATE_SPEC = {
  ...MIXED_QUOTED_SPEC,
  fetchHelper: { ...SPEC.fetchHelper, staticPathStyle: "template" },
};

function emit(spec: unknown): Map<string, string> {
  const files = formatAll(generate(parseSpec(spec)));
  return new Map(files.map((f) => [displayPath(f.path), f.content]));
}

function emittedServer(spec: unknown): string {
  const server = emit(spec).get("src/server.ts");
  if (server === undefined) throw new Error("no src/server.ts emitted");
  return server;
}

let PRISTINE: string;
let HOISTED_BASE: string;

beforeAll(async () => {
  await initFormatter();
  await initParser();
  PRISTINE = emittedServer(SPEC);
  HOISTED_BASE = emittedServer(HOISTED_BASE_SPEC);
});

/** The module's first block-bodied `pathFn`, plus the args of the same registrar call's schema. */
function queryCall(source: string): { body: AstNode; args: Record<string, ArgFields> } {
  for (const statement of parseModule(source)) {
    const args = callArgs(expressionOf(statement));
    if (args?.length !== 4) continue;
    const arrow = arrowFn(args[3]);
    if (arrow === undefined || !arrow.isBlock) continue;
    const schema = recognizeArgs(args[2]!);
    if (schema === undefined) throw new Error("the call's z.object schema was not recognized");
    return { body: arrow.body, args: schema.args };
  }
  throw new Error("the emitted module has no block-bodied pathFn");
}

/** A targeted mutation, guarded so a pattern that matched nothing fails loudly rather than silently asserting on pristine bytes. */
function corrupt(source: string, from: string | RegExp, to: string): string {
  const out = source.replace(from, to);
  expect(out).not.toBe(source);
  return out;
}

function sectionOf(source: string): HoistSection {
  const { body } = queryCall(source);
  const statements = blockBody(body);
  if (statements === undefined) throw new Error("the pathFn body is not a block");
  return splitHoists(statements);
}

/** The statements between the `new URL` const and the `` return `${u}`; `` tail. */
function queryLinesOf(source: string): AstNode[] {
  return sectionOf(source).rest.slice(1, -1);
}

describe("recognizeQueryLines", () => {
  it("recovers every entry renderQueryLines writes, in order", () => {
    const section = sectionOf(PRISTINE);
    expect(recognizeQueryLines(section.rest.slice(1, -1), "u", section.locals)).toEqual([
      { name: "q", arg: "q", wrapped: false },
      { name: "after", arg: "after", omitWhen: "absent", wrapped: false },
      { name: "filter", arg: "filter", omitWhen: "empty", wrapped: false },
      { name: "page", arg: "page", omitWhen: "absent", wrapped: true },
      { name: "limit", arg: "limit", wrapped: true },
    ]);
  });

  it("refuses searchParams.append — repeated keys, not the `set` the emitter writes", () => {
    const source = corrupt(PRISTINE, 'u.searchParams.set("q"', 'u.searchParams.append("q"');
    expect(
      recognizeQueryLines(queryLinesOf(source), "u", sectionOf(source).locals),
    ).toBeUndefined();
  });

  it("refuses a receiver other than the new URL const", () => {
    const source = corrupt(PRISTINE, 'u.searchParams.set("q"', 'other.searchParams.set("q"');
    expect(
      recognizeQueryLines(queryLinesOf(source), "u", sectionOf(source).locals),
    ).toBeUndefined();
  });

  it("refuses a guard of a third shape", () => {
    const source = corrupt(PRISTINE, "parsed.after !== undefined)", "parsed.after !== null)");
    expect(
      recognizeQueryLines(queryLinesOf(source), "u", sectionOf(source).locals),
    ).toBeUndefined();
  });

  it("refuses a guard naming a different value from the set call it wraps", () => {
    const source = corrupt(PRISTINE, "parsed.after !== undefined)", "parsed.page !== undefined)");
    expect(
      recognizeQueryLines(queryLinesOf(source), "u", sectionOf(source).locals),
    ).toBeUndefined();
  });
});

describe("recognizeQueryBlock", () => {
  it("keeps a literal base on the recovered path, and hands back the whole leading quasi", () => {
    const { body, args } = queryCall(PRISTINE);
    const block = recognizeQueryBlock(body, args);
    expect(block?.path).toBe("https://api.zzqueryunit.test/v1/items");
    // The quasi is base + the path's first literal segment, fused — NOT the base, which is
    // exactly why the caller does the split. See BasePrefix.
    expect(block?.basePrefix).toEqual({
      kind: "literal",
      leadingQuasi: "https://api.zzqueryunit.test/v1/items",
    });
    expect(block?.query).toEqual([
      { name: "q", arg: "q" },
      { name: "after", arg: "after", omitWhen: "absent" },
      { name: "filter", arg: "filter", omitWhen: "empty" },
      { name: "page", arg: "page", omitWhen: "absent" },
      { name: "limit", arg: "limit" },
    ]);
  });

  it("drops a hoisted base const from the path and names it as the prefix", () => {
    const { body, args } = queryCall(HOISTED_BASE);
    const block = recognizeQueryBlock(body, args);
    expect(block?.path).toBe("/v1/items");
    expect(block?.basePrefix).toEqual({ kind: "const", name: "ZZ_BASE" });
  });

  it("recovers the hoist's own Gap A / Gap B metadata", () => {
    const { body, args } = queryCall(PRISTINE);
    expect(recognizeQueryBlock(body, args)?.hoistMeta.get("limit")).toEqual({
      local: "limit",
      default: 50,
    });
  });

  it("refuses String(...) around a string-typed arg — a shape wrapsInString cannot write", () => {
    const source = corrupt(PRISTINE, 'set("q", parsed.q)', 'set("q", String(parsed.q))');
    const { body, args } = queryCall(source);
    expect(recognizeQueryBlock(body, args)).toBeUndefined();
  });

  it("refuses a bare number-typed arg — wrapsInString always wraps one", () => {
    const source = corrupt(PRISTINE, 'set("limit", String(limit))', 'set("limit", limit)');
    const { body, args } = queryCall(source);
    expect(recognizeQueryBlock(body, args)).toBeUndefined();
  });

  it("refuses the corpus's `u.toString()` tail — renderTool writes the template form", () => {
    const source = corrupt(PRISTINE, "return `${u}`;", "return u.toString();");
    const { body, args } = queryCall(source);
    expect(recognizeQueryBlock(body, args)).toBeUndefined();
  });

  it("refuses the corpus's `${u.pathname}${u.search}` tail", () => {
    const source = corrupt(PRISTINE, "return `${u}`;", "return `${u.pathname}${u.search}`;");
    const { body, args } = queryCall(source);
    expect(recognizeQueryBlock(body, args)).toBeUndefined();
  });

  it("refuses a URL const under any name but `u`", () => {
    const renamed = corrupt(PRISTINE, "const u = new URL(", "const v = new URL(")
      .replaceAll("u.searchParams", "v.searchParams")
      .replace("return `${u}`;", "return `${v}`;");
    const { body, args } = queryCall(renamed);
    expect(recognizeQueryBlock(body, args)).toBeUndefined();
  });

  it("refuses a block with no query lines — renderTool would not have written the trio", () => {
    const source = corrupt(
      PRISTINE,
      /(const u = new URL\(`[^`]*`\);\n)[\s\S]*?(\s*return `\$\{u\}`;)/,
      "$1$2",
    );
    const { body, args } = queryCall(source);
    expect(recognizeQueryBlock(body, args)).toBeUndefined();
  });
});

describe("the query branch inside deriveSpec", () => {
  function derive(files: Map<string, string>, server = files.get("src/server.ts")!) {
    return deriveSpec({ server, manifest: files.get("nimbus.extension.json")! });
  }

  function expectRoundTrip(spec: unknown): void {
    const files = emit(spec);
    const derivation = derive(files);
    if (!derivation.ok) throw new Error(derivation.blockers.map((b) => b.kind).join(", "));
    const reEmitted = emit(derivation.spec);
    expect([...reEmitted.keys()].sort()).toEqual([...files.keys()].sort());
    for (const [path, content] of files) expect(reEmitted.get(path)).toBe(content);
  }

  it("round-trips a query connector with a literal base", () => {
    expectRoundTrip(SPEC);
  });

  it("round-trips a query connector with a hoisted base const", () => {
    expectRoundTrip(HOISTED_BASE_SPEC);
  });

  /**
   * The abstention that matters: `renderPath`'s fast path is `if (!dynamic && prefix === "")`, so
   * a query tool's non-empty prefix forces the template branch whatever `staticPathStyle` says.
   *
   * Both directions, because there are two plausible wrong votes and each is INVISIBLE against
   * one of the two static styles. A recognizer reporting the shape of the PREFIXED template votes
   * "template" (a literal base plus a static path is a zero-expression template literal), which
   * only disagrees with a `quoted` connector; a recognizer reporting the shape of the STRIPPED
   * path votes "quoted" (`/v1/items` carries no placeholder), which only disagrees with a
   * `template` one. Each was confirmed to fail exactly one of the two tests below, by forcing
   * that vote in `recognizeOneCall` and running them.
   *
   * The `expectRoundTrip` in each case carries the "not blocked" half — a `deriveSpec` reporting
   * `style:mixed-static-path` throws there.
   */
  function expectQueryToolAbstains(spec: unknown, expected: string | undefined): void {
    const derivation = derive(emit(spec));
    if (!derivation.ok) throw new Error(derivation.blockers.map((b) => b.kind).join(", "));
    const fetchHelper = derivation.spec.fetchHelper as Record<string, unknown>;
    expect(fetchHelper.staticPathStyle).toBe(expected);
    expectRoundTrip(spec);
  }

  it("does not let a query tool vote `template` against a quoted static path", () => {
    // Omitted, not "quoted": deriveRestKitSpec drops the value that reproduces the schema default.
    expectQueryToolAbstains(MIXED_QUOTED_SPEC, undefined);
  });

  it("does not let a query tool vote `quoted` against a template static path", () => {
    expectQueryToolAbstains(MIXED_TEMPLATE_SPEC, "template");
  });

  function expectBasePrefixMismatch(files: Map<string, string>, server: string): void {
    const derivation = derive(files, server);
    expect(derivation.ok).toBe(false);
    if (derivation.ok) return;
    expect(derivation.blockers.map((b) => b.kind)).toContain("query:base-prefix-mismatch");
  }

  it("blocks a hoisted prefix naming a const other than the fetch helper's baseConst", () => {
    const files = emit(HOISTED_BASE_SPEC);
    expectBasePrefixMismatch(
      files,
      corrupt(files.get("src/server.ts")!, "${ZZ_BASE}/v1/items", "${OTHER}/v1/items"),
    );
  });

  it("blocks a literal prefix that is not the fetch helper's base", () => {
    const files = emit(SPEC);
    expectBasePrefixMismatch(
      files,
      corrupt(
        files.get("src/server.ts")!,
        "new URL(`https://api.zzqueryunit.test/v1/items`)",
        "new URL(`https://other.test/v1/items`)",
      ),
    );
  });

  // The other half of that guard: a LITERAL prefix in a module whose fetch helper hoists its
  // base is a combination `baseExpr` cannot write — it returns one form or the other for the
  // whole connector — so it is refused rather than accepted on the strength of the text alone.
  it("blocks a literal prefix in a module whose fetch helper hoists its base", () => {
    const files = emit(HOISTED_BASE_SPEC);
    expectBasePrefixMismatch(
      files,
      corrupt(
        files.get("src/server.ts")!,
        "new URL(`${ZZ_BASE}/v1/items`)",
        "new URL(`https://api.zzqueryunit.test/v1/items`)",
      ),
    );
  });
});
