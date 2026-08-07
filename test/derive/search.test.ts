import { beforeAll, describe, expect, it } from "bun:test";
import { type AstNode, initParser, parseModule } from "../../src/derive/ast.ts";
import { createClaimSet } from "../../src/derive/claims.ts";
import { callArgs, calleeOf, expressionOf, isIdent, stringLit } from "../../src/derive/read.ts";
import { recognizeFrame } from "../../src/derive/server/index.ts";
import { recognizeSearchTool } from "../../src/derive/server/search.ts";
import { generate } from "../../src/emit/index.ts";
import { formatAll, initFormatter } from "../../src/format.ts";
import { parseSpec } from "../../src/spec.ts";
import { displayPath } from "../../src/types.ts";

beforeAll(async () => {
  await initFormatter();
  await initParser();
});

/** The emitted src/server.ts for a spec, so the test input is bytes this repo produced. */
function emittedServer(spec: unknown): string {
  const files = formatAll(generate(parseSpec(spec)));
  const f = files.find((x) => displayPath(x.path) === "src/server.ts");
  if (f === undefined) throw new Error("no src/server.ts emitted");
  return f.content;
}

/**
 * The `reg(...)` CallExpression named `toolName`, out of a spec's own emitted src/server.ts —
 * found through `recognizeFrame` (real production code) rather than a bespoke walker, so the
 * statement this hands back is exactly what `deriveSpec` itself would scan.
 */
function regCallFor(spec: unknown, toolName: string): AstNode {
  const statements = parseModule(emittedServer(spec));
  const frame = recognizeFrame(statements, createClaimSet());
  if (frame === undefined) throw new Error("no frame recognized");
  for (const stmt of frame.toolStatements) {
    const call = expressionOf(stmt);
    if (call === undefined || !isIdent(calleeOf(call), "reg")) continue;
    const args = callArgs(call);
    if (args !== undefined && stringLit(args[0]) === toolName) return call;
  }
  throw new Error(`no reg() call named ${toolName} in emitted source`);
}

const BASE_SPEC = {
  name: "zzsearchunit",
  displayName: "ZZ Search Unit",
  description: "Fixture for the search recognizer.",
  serviceLabel: "ZZ Search Unit",
  style: "read-only-kit",
  network: ["api.zzsearchunit.test"],
  syncInterval: 600,
  minNimbusVersion: "0.2.0",
  env: [{ vars: ["ZZSEARCHUNIT_TOKEN"], local: "headers", auth: "bearer", required: true }],
  fetchHelper: { local: "zzGet", base: "https://api.zzsearchunit.test", headers: "headers" },
  tools: [
    {
      name: "zzsearchunit_rows",
      description: "Search with a rows envelope.",
      impl: "search",
      path: "/v1/items",
      rows: "items",
      maxLimit: 100,
      filter: { export: "filterZzsearchunitItems", fields: ["name", "status"] },
    },
    {
      name: "zzsearchunit_norows",
      description: "Search with its own arg and no rows envelope.",
      impl: "search",
      args: { scope: { type: "string", optional: true } },
      path: "/v1/builds",
      maxLimit: 200,
      filter: { export: "filterZzsearchunitBuilds", fields: ["branch"] },
    },
  ],
};

/**
 * Merged `z.object(...)` schemas a search `reg()` call may not carry: what is wrong with the
 * schema, and the schema line that is wrong. Everything else about the call is held fixed.
 */
const REFUSED_MERGED_SCHEMAS: ReadonlyArray<readonly [string, string]> = [
  [
    "whose trailing fields are not exactly query/limit",
    "  z.object({ scope: z.string(), other: z.string() }),",
  ],
  [
    "whose limit field does not match the fixed shape",
    "  z.object({ scope: z.string(), query: z.string().min(1), limit: z.number().optional() }),",
  ],
  [
    "recovering zero own args — the emitter would write searchToolInputSchema(N) instead",
    "  z.object({ query: z.string().min(1), limit: z.number().int().min(1).max(100).optional() }),",
  ],
];

describe("recognizeSearchTool", () => {
  it("recovers rows, maxLimit and filter.export from the rows-envelope form", () => {
    const call = regCallFor(BASE_SPEC, "zzsearchunit_rows");
    const result = recognizeSearchTool(call, "zzGet");
    expect(result).toEqual({
      fields: {
        name: "zzsearchunit_rows",
        description: "Search with a rows envelope.",
        args: {},
        path: "/v1/items",
        impl: "search",
        rows: "items",
        maxLimit: 100,
        filter: { export: "filterZzsearchunitItems" },
      },
      staticStyle: "quoted",
      schemaShape: { propertyCount: 0, oneLine: false },
    });
  });

  it("recovers the same minus rows, plus its own arg, from the merged-schema form", () => {
    const call = regCallFor(BASE_SPEC, "zzsearchunit_norows");
    const result = recognizeSearchTool(call, "zzGet");
    expect(result?.fields).toEqual({
      name: "zzsearchunit_norows",
      description: "Search with its own arg and no rows envelope.",
      args: { scope: { type: "string", optional: true } },
      path: "/v1/builds",
      impl: "search",
      maxLimit: 200,
      filter: { export: "filterZzsearchunitBuilds" },
    });
    expect(result?.fields).not.toHaveProperty("rows");
    // The merged z.object(scope, query, limit) carries genuine inline/expanded evidence, unlike
    // the zero-arg searchToolInputSchema(N) form above, which must abstain (propertyCount: 0).
    expect(result?.schemaShape.propertyCount).toBeGreaterThan(0);
  });

  it("refuses a handler whose fetch callee is not the recognized helper", () => {
    // The cross-check trap: reading args[0] without checking WHICH function produced it would
    // derive a search tool whose fetch call this connector's own recognized helper never made.
    const call = regCallFor(BASE_SPEC, "zzsearchunit_rows");
    expect(recognizeSearchTool(call, "someOtherHelper")).toBeUndefined();
  });

  // Every source below is a shape renderSearchTool cannot have written, hand-constructed rather
  // than emitted — see this suite's own module docstring precedent (fetch-helper.test.ts's
  // REFUSED_HELPERS): a wrong-shape input is by definition not something parseSpec -> generate
  // can produce, so it cannot come from this repo's own emitter.
  const NO_ROWS_HEAD = [
    "reg(",
    '  "t",',
    '  "d",',
    "  searchToolInputSchema(100),",
    "  async (p) => {",
  ];
  const TAIL = ["  },", ");"].join("\n");

  function refused(bodyLines: string[]): void {
    const source = [...NO_ROWS_HEAD, ...bodyLines, TAIL].join("\n");
    const call = expressionOf(parseModule(source)[0]);
    expect(call).toBeDefined();
    expect(recognizeSearchTool(call as AstNode, "zzGet")).toBeUndefined();
  }

  it("refuses matchesResult's third argument not being the handler's own parameter", () => {
    // The other cross-check trap: matchesResult's third argument must be the SAME identifier
    // the handler's arrow declared, not merely some identifier.
    refused(['    return matchesResult(await zzGet("/v1/items"), filterX, somethingElse);']);
  });

  it("refuses a concise (non-block) handler — renderSearchTool always writes a block", () => {
    const source = [
      'reg("t", "d", searchToolInputSchema(100), async (p) =>',
      '  matchesResult(await zzGet("/v1/items"), filterX, p),',
      ");",
    ].join("\n");
    const call = expressionOf(parseModule(source)[0]);
    expect(recognizeSearchTool(call as AstNode, "zzGet")).toBeUndefined();
  });

  it("refuses a non-async handler", () => {
    // isAsync is checked before the body is even inspected, so the body need not be valid
    // async-only syntax here — a non-async arrow with `await` inside is a parse error, not the
    // shape this test means to construct.
    const source = [
      'reg("t", "d", searchToolInputSchema(100), (p) => {',
      '  return matchesResult(zzGet("/v1/items"), filterX, p);',
      "});",
    ].join("\n");
    const call = expressionOf(parseModule(source)[0]);
    expect(recognizeSearchTool(call as AstNode, "zzGet")).toBeUndefined();
  });

  it("refuses a reg() call with the wrong arity", () => {
    const source = 'reg("t", "d", searchToolInputSchema(100));';
    const call = expressionOf(parseModule(source)[0]);
    expect(recognizeSearchTool(call as AstNode, "zzGet")).toBeUndefined();
  });

  it("refuses an unrecognized schema (neither searchToolInputSchema nor z.object)", () => {
    const source = [
      'reg("t", "d", someOtherSchema(), async (p) => {',
      '  return matchesResult(await zzGet("/v1/items"), filterX, p);',
      "});",
    ].join("\n");
    const call = expressionOf(parseModule(source)[0]);
    expect(recognizeSearchTool(call as AstNode, "zzGet")).toBeUndefined();
  });

  // One assertion over the table above: the three differ in the schema line and nothing else, and
  // the row's own name is the part that carries the reason.
  it.each(REFUSED_MERGED_SCHEMAS)("refuses a merged z.object schema %s", (_name, schemaLine) => {
    const source = [
      "reg(",
      '  "t",',
      '  "d",',
      schemaLine,
      "  async (p) => {",
      '    return matchesResult(await zzGet("/v1/items"), filterX, p);',
      "  },",
      ");",
    ].join("\n");
    const call = expressionOf(parseModule(source)[0]);
    expect(recognizeSearchTool(call as AstNode, "zzGet")).toBeUndefined();
  });

  it("refuses a body with an unrecognized statement count (neither 1 nor 3)", () => {
    refused([
      '    const root = await zzGet("/v1/items");',
      "    return matchesResult(root, filterX, p);",
    ]);
  });

  it("refuses the rows form when the rows-narrowing const's name does not match the property it reads", () => {
    const source = [
      'reg("t", "d", searchToolInputSchema(100), async (p) => {',
      '  const root = await zzGet("/v1/items");',
      "  const items = (root as { other?: unknown[] } | null)?.other;",
      "  return matchesResult(items, filterX, p);",
      "});",
    ].join("\n");
    const call = expressionOf(parseModule(source)[0]);
    expect(recognizeSearchTool(call as AstNode, "zzGet")).toBeUndefined();
  });

  it("refuses the rows form when the narrowing type is not `readonly` (checked via a differently-shaped union)", () => {
    const source = [
      'reg("t", "d", searchToolInputSchema(100), async (p) => {',
      '  const root = await zzGet("/v1/items");',
      "  const items = (root as { items?: unknown[] } | undefined)?.items;",
      "  return matchesResult(items, filterX, p);",
      "});",
    ].join("\n");
    const call = expressionOf(parseModule(source)[0]);
    expect(recognizeSearchTool(call as AstNode, "zzGet")).toBeUndefined();
  });

  it("refuses matchesResult with the wrong arity", () => {
    refused(['    return matchesResult(await zzGet("/v1/items"), filterX);']);
  });

  it("refuses a fetch call with more than one argument", () => {
    refused(['    return matchesResult(await zzGet("/v1/items", "extra"), filterX, p);']);
  });
});
