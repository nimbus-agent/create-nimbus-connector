import { beforeAll, describe, expect, it } from "bun:test";
import { type AstNode, initParser, parseModule } from "../../src/derive/ast.ts";
import { createClaimSet } from "../../src/derive/claims.ts";
import { deriveSpec } from "../../src/derive/index.ts";
import { arrowFn, blockBody, callArgs, expressionOf } from "../../src/derive/read.ts";
import { type ArgFields, recognizeArgs } from "../../src/derive/server/args.ts";
import { type HoistSection, splitHoists } from "../../src/derive/server/hoists.ts";
import { recognizeQueryBlock, recognizeQueryLines } from "../../src/derive/server/query.ts";
import { recognizeTools } from "../../src/derive/server/tools-hand.ts";
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

/**
 * The HAND-ROLLED counterpart, whose `renderTool` (src/emit/server/tools-hand.ts) ends the same
 * query block with `` const path = `${u}`; `` and a `return jsonResult(await zzGet(path));` — the
 * `"binds-path"` tail — instead of returning the URL. Its query tool reuses `SPEC`'s verbatim, so
 * the two styles are compared on the one thing that actually differs between them.
 *
 * `zzqueryhand_ping` is fully static and therefore QUOTED, the pairing that makes the
 * staticPathStyle abstention below decisive rather than merely unobserved.
 */
const HAND_SPEC = {
  name: "zzqueryhand",
  displayName: "ZZ Query Hand",
  description: "Fixture for the hand-rolled query branch.",
  serviceLabel: "ZZ Query Hand",
  style: "hand-rolled",
  network: ["api.zzqueryhand.test"],
  syncInterval: 600,
  minNimbusVersion: "0.2.0",
  env: [{ vars: ["ZZQUERYHAND_TOKEN"], local: "headers", auth: "bearer" }],
  fetchHelper: { local: "zzGet", base: "https://api.zzqueryhand.test", headers: "headers" },
  tools: [
    { ...SPEC.tools[0]!, name: "zzqueryhand_list" },
    { name: "zzqueryhand_ping", description: "Ping.", path: "/v1/ping" },
  ],
};

/** The mirror of `MIXED_TEMPLATE_SPEC` for the hand-rolled style — see that constant. */
const HAND_TEMPLATE_SPEC = {
  ...HAND_SPEC,
  fetchHelper: { ...HAND_SPEC.fetchHelper, staticPathStyle: "template" },
};

/**
 * `${env.X}` inside `fetchHelper.base` is legal for a hand-rolled connector — ConnectorSpecSchema
 * scopes that prohibition to rest-kit — and `baseExpr` resolves it, so the base reaches `new URL`
 * as an ACCESSOR CALL rather than text. Deriving it is refused deliberately, in the two places the
 * two forms reach: an accessor with nothing ahead of it produces an empty leading quasi, which
 * `prefixedPath` refuses (it is not the hoisted-const form it looks like); one with text ahead of
 * it takes the literal branch and is refused by `rebaseQueryTools`, since `base` still spells the
 * accessor `${env.apiRoot}` and no rendered quasi can contain those characters.
 */
const ENV_BASE_SPEC = {
  ...HAND_SPEC,
  env: [
    { vars: ["ZZQUERYHAND_URL"], local: "apiRoot", default: "https://api.zzqueryhand.test" },
    { vars: ["ZZQUERYHAND_TOKEN"], local: "headers", auth: "bearer" },
  ],
  fetchHelper: { local: "zzGet", base: "${env.apiRoot}", headers: "headers" },
};

const ENV_PREFIXED_BASE_SPEC = {
  ...ENV_BASE_SPEC,
  fetchHelper: { ...ENV_BASE_SPEC.fetchHelper, base: "https://${env.apiRoot}/api" },
};

/**
 * A query tool with NO hoisted arg, beside a concise one. `renderTool`'s query branch returns its
 * block form BEFORE the `used.size === 0 && spec.handlerStyle === "concise"` test is reached, so
 * this block is one a "concise" connector emits — and counting it as `handlerStyle` evidence would
 * make `recognizeTools` refuse the pair outright (block-without-hoists beside concise).
 */
const HOISTLESS_QUERY_SPEC = {
  ...HAND_SPEC,
  tools: [
    {
      name: "zzqueryhand_list",
      description: "List items.",
      path: "/v1/items",
      args: { q: { type: "string" }, after: { type: "string", optional: true } },
      query: [
        { name: "q", arg: "q" },
        { name: "after", arg: "after", omitWhen: "absent" },
      ],
    },
    { name: "zzqueryhand_ping", description: "Ping.", path: "/v1/ping" },
  ],
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
let HAND: string;

beforeAll(async () => {
  await initFormatter();
  await initParser();
  PRISTINE = emittedServer(SPEC);
  HOISTED_BASE = emittedServer(HOISTED_BASE_SPEC);
  HAND = emittedServer(HAND_SPEC);
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

/** Mutations of PRISTINE that recognizeQueryBlock must refuse: name, the text to replace, its replacement. */
const REFUSED_BLOCKS: ReadonlyArray<readonly [string, string, string]> = [
  [
    "String(...) around a string-typed arg — a shape wrapsInString cannot write",
    'set("q", parsed.q)',
    'set("q", String(parsed.q))',
  ],
  [
    "a bare number-typed arg — wrapsInString always wraps one",
    'set("limit", String(limit))',
    'set("limit", limit)',
  ],
  [
    "the corpus's `u.toString()` tail — renderTool writes the template form",
    "return `${u}`;",
    "return u.toString();",
  ],
  [
    "the corpus's `${u.pathname}${u.search}` tail",
    "return `${u}`;",
    "return `${u.pathname}${u.search}`;",
  ],
];

describe("recognizeQueryBlock", () => {
  it("keeps a literal base on the recovered path, and hands back the whole leading quasi", () => {
    const { body, args } = queryCall(PRISTINE);
    const block = recognizeQueryBlock(body, args, "returns-url");
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
    const block = recognizeQueryBlock(body, args, "returns-url");
    expect(block?.path).toBe("/v1/items");
    expect(block?.basePrefix).toEqual({ kind: "const", name: "ZZ_BASE" });
  });

  it("recovers the hoist's own Gap A / Gap B metadata", () => {
    const { body, args } = queryCall(PRISTINE);
    expect(recognizeQueryBlock(body, args, "returns-url")?.hoistMeta.get("limit")).toEqual({
      local: "limit",
      default: 50,
    });
  });

  // One assertion over a table of mutations, in the shape the other refusal suites here use
  // (REFUSED_STUBS in tools-rest.test.ts, REFUSED_BODIES in body.test.ts). Each row still names
  // what it refuses and why, which is the part worth keeping; the three-line body is not.
  it.each(REFUSED_BLOCKS)("refuses %s", (_name, from, to) => {
    const { body, args } = queryCall(corrupt(PRISTINE, from, to));
    expect(recognizeQueryBlock(body, args, "returns-url")).toBeUndefined();
  });

  it("has rows to refuse", () => {
    // `it.each` over an empty table runs no test and reports no failure, so deleting rows from
    // REFUSED_BLOCKS quietly shrinks what this suite covers. The same guard test/gate-lists.test.ts
    // puts on `MATCHER_CASES`, for the same reason.
    expect(REFUSED_BLOCKS.length).toBeGreaterThan(3);
  });

  it("refuses a URL const under any name but `u`", () => {
    const renamed = corrupt(PRISTINE, "const u = new URL(", "const v = new URL(")
      .replaceAll("u.searchParams", "v.searchParams")
      .replace("return `${u}`;", "return `${v}`;");
    const { body, args } = queryCall(renamed);
    expect(recognizeQueryBlock(body, args, "returns-url")).toBeUndefined();
  });

  it("refuses a block with no query lines — renderTool would not have written the trio", () => {
    const source = corrupt(
      PRISTINE,
      /(const u = new URL\(`[^`]*`\);\n)[\s\S]*?(\s*return `\$\{u\}`;)/,
      "$1$2",
    );
    const { body, args } = queryCall(source);
    expect(recognizeQueryBlock(body, args, "returns-url")).toBeUndefined();
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

// ---------------------------------------------------------------------------
// The hand-rolled half: the same query block under the `"binds-path"` tail, plus the read
// helper's passthrough line, which `renderFetchHelper` emits IFF some tool declares a query
// array. Neither half is any use without the other — without the fetch-helper half the tools
// would recognize and the module would still block on its own read helper.
// ---------------------------------------------------------------------------

describe("recognizeQueryBlock, hand-rolled tail", () => {
  it("recovers the same entries the rest-kit tail does, plus the return it hands back unread", () => {
    const { body, args } = queryCall(HAND);
    const block = recognizeQueryBlock(body, args, "binds-path");
    expect(block?.path).toBe("https://api.zzqueryhand.test/v1/items");
    expect(block?.basePrefix).toEqual({
      kind: "literal",
      leadingQuasi: "https://api.zzqueryhand.test/v1/items",
    });
    expect(block?.query).toEqual([
      { name: "q", arg: "q" },
      { name: "after", arg: "after", omitWhen: "absent" },
      { name: "filter", arg: "filter", omitWhen: "empty" },
      { name: "page", arg: "page", omitWhen: "absent" },
      { name: "limit", arg: "limit" },
    ]);
    // Left unread here on purpose — only tools-hand.ts knows the fetch helper's local name to
    // check the call against. See QueryBlock.returned.
    expect(block?.returned).toBeDefined();
  });

  it("refuses each style's tail under the other style's reader", () => {
    // The two are selected by the caller, never tried in turn: a hand-rolled handler that merely
    // returns the URL returns a string where the registrar expects an MCP result, and a rest-kit
    // pathFn that binds `path` and returns a fetch call is not a shape renderTool writes for it.
    const hand = queryCall(HAND);
    expect(recognizeQueryBlock(hand.body, hand.args, "returns-url")).toBeUndefined();
    const rest = queryCall(PRISTINE);
    expect(recognizeQueryBlock(rest.body, rest.args, "binds-path")).toBeUndefined();
  });

  it("refuses a tail binding the URL to any name but `path`", () => {
    const source = corrupt(HAND, "const path = `${u}`;", "const target = `${u}`;").replace(
      "zzGet(path)",
      "zzGet(target)",
    );
    const { body, args } = queryCall(source);
    expect(recognizeQueryBlock(body, args, "binds-path")).toBeUndefined();
  });

  it("refuses the corpus's `${u.pathname}${u.search}` tail under this reader too", () => {
    const source = corrupt(
      HAND,
      "const path = `${u}`;",
      "const path = `${u.pathname}${u.search}`;",
    );
    const { body, args } = queryCall(source);
    expect(recognizeQueryBlock(body, args, "binds-path")).toBeUndefined();
  });
});

describe("the hand-rolled query branch inside deriveSpec", () => {
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

  function expectBlockers(files: Map<string, string>, server: string, kind: string): void {
    const derivation = derive(files, server);
    expect(derivation.ok).toBe(false);
    if (derivation.ok) return;
    expect(derivation.blockers.map((b) => b.kind)).toContain(kind);
  }

  it("round-trips a hand-rolled query connector", () => {
    expectRoundTrip(HAND_SPEC);
  });

  it("recovers a non-GET query tool's method through the same reader a plain tool uses", () => {
    // Not a full deriveSpec round trip — but no longer because it COULDN'T be one. This used to
    // say the emitted `zzGetSend` was "a write helper no recognizer in this plan claims", so the
    // module blocked on that statement. `recognizeWriteHelper` has since landed, and this exact
    // module now derives and re-emits byte-identically (verified directly; `zzwriteonly` is the
    // fixture that holds the same path in the round-trip suite).
    //
    // recognizeTools is still run directly, because the assertion is narrow on purpose: that the
    // query branch recovers `method` through the same reader a plain tool uses. Reading it off
    // recognizeTools' own result names that reader; a whole-spec comparison would prove the same
    // byte equality every round-trip fixture already proves, and would go green even if `method`
    // arrived by some other route.
    const source = emittedServer({
      ...HAND_SPEC,
      tools: [{ ...HAND_SPEC.tools[0]!, method: "POST" }],
    });
    const result = recognizeTools(parseModule(source), createClaimSet(), "zzGet");
    expect(result?.tools.map((t) => (t as { method?: string }).method)).toEqual(["POST"]);
  });

  /**
   * The abstention, in both directions, exactly as the rest-kit half tests it — `renderPath`'s
   * `!dynamic && prefix === ""` fast path is shared by the two styles, so a hand-rolled query
   * tool carries no `staticPathStyle` evidence either. Each `expectRoundTrip` carries the "not
   * blocked" half: a deriveSpec reporting `style:mixed-static-path` throws there.
   */
  function expectQueryToolAbstains(spec: unknown, expected: string | undefined): void {
    const derivation = derive(emit(spec));
    if (!derivation.ok) throw new Error(derivation.blockers.map((b) => b.kind).join(", "));
    const fetchHelper = derivation.spec.fetchHelper as Record<string, unknown>;
    expect(fetchHelper.staticPathStyle).toBe(expected);
    expectRoundTrip(spec);
  }

  it("does not let a hand-rolled query tool vote `template` against a quoted static path", () => {
    // Omitted, not "quoted": deriveSharedStyleSpec drops the value reproducing the schema default.
    expectQueryToolAbstains(HAND_SPEC, undefined);
  });

  it("does not let a hand-rolled query tool vote `quoted` against a template static path", () => {
    expectQueryToolAbstains(HAND_TEMPLATE_SPEC, "template");
  });

  it("does not let a hoistless query tool vote `block` against a concise tool", () => {
    // Without the abstention this pair is refused outright by recognizeTools (a block with no
    // hoists beside a concise handler matches neither connector-wide handlerStyle), so a passing
    // round trip is the assertion.
    expectRoundTrip(HOISTLESS_QUERY_SPEC);
  });

  it("blocks a literal prefix that is not the hand-rolled fetch helper's base", () => {
    const files = emit(HAND_SPEC);
    expectBlockers(
      files,
      corrupt(
        files.get("src/server.ts")!,
        "new URL(`https://api.zzqueryhand.test/v1/items`)",
        "new URL(`https://other.test/v1/items`)",
      ),
      "query:base-prefix-mismatch",
    );
  });

  // The env-ref base, refused in both of the places its two forms reach — see ENV_BASE_SPEC.
  // Neither is a mis-derivation: an `${env.X}` base is decided per request, so no static split of
  // the `new URL(...)` template can separate it from the path.

  it("refuses an ${env.X} base with nothing ahead of it, at the new URL template", () => {
    const derivation = derive(emit(ENV_BASE_SPEC));
    expect(derivation.ok).toBe(false);
    // prefixedPath refuses, so no tool recognizes and every reg() statement stays unclaimed —
    // reported by the totality rule rather than by a named cross-check.
    if (!derivation.ok) expect(derivation.blockers.map((b) => b.kind)).toContain("call:reg");
  });

  it("refuses an ${env.X} base with text ahead of it, at the base cross-check", () => {
    const derivation = derive(emit(ENV_PREFIXED_BASE_SPEC));
    expect(derivation.ok).toBe(false);
    if (!derivation.ok) {
      expect(derivation.blockers.map((b) => b.kind)).toContain("query:base-prefix-mismatch");
    }
  });

  // The passthrough cross-check, both directions. `hasQueryTool` decides the read helper's line
  // from the SET of tools, so neither recognizer can see the other's evidence on its own.

  const PASSTHROUGH_LINE =
    '  const url = path.startsWith("http") ? path : `https://api.zzqueryhand.test${path}`;\n' +
    "  const res = await fetch(url, { headers: headers() });";
  const PLAIN_FETCH_LINE =
    "  const res = await fetch(`https://api.zzqueryhand.test${path}`, { headers: headers() });";

  it("blocks a read helper carrying the passthrough line with no query tool behind it", () => {
    const files = emit({ ...HAND_SPEC, tools: [HAND_SPEC.tools[1]!] });
    expectBlockers(
      files,
      corrupt(files.get("src/server.ts")!, PLAIN_FETCH_LINE, PASSTHROUGH_LINE),
      "fetch-helper:query-passthrough-mismatch",
    );
  });

  it("blocks a query tool whose read helper lacks the passthrough line", () => {
    const files = emit(HAND_SPEC);
    expectBlockers(
      files,
      corrupt(files.get("src/server.ts")!, PASSTHROUGH_LINE, PLAIN_FETCH_LINE),
      "fetch-helper:query-passthrough-mismatch",
    );
  });
});
