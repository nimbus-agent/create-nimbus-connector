import { beforeAll, describe, expect, it } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { initParser, parseModule } from "../../src/derive/ast.ts";
import { deriveSpec, voteArgsSchemaStyle, voteStaticPathStyle } from "../../src/derive/index.ts";
import { recognizeArgs } from "../../src/derive/server/args.ts";
import { recognizePath } from "../../src/derive/server/path-template.ts";
import { generate } from "../../src/emit/index.ts";
import { formatAll, initFormatter } from "../../src/format.ts";
import { type ConnectorSpec, parseSpec, registrarName } from "../../src/spec.ts";

beforeAll(async () => {
  await initFormatter();
  await initParser();
});

/** The emitted src/server.ts and nimbus.extension.json for a raw spec object. */
function emitted(raw: unknown): { server: string; manifest: string } {
  const files = formatAll(generate(parseSpec(raw)));
  const pick = (p: string): string => {
    const f = files.find((x) => x.path.join("/") === p);
    if (f === undefined) throw new Error(`no ${p} emitted`);
    return f.content;
  };
  return { server: pick("src/server.ts"), manifest: pick("nimbus.extension.json") };
}

const BASE_SPEC = {
  name: "zzstyle",
  displayName: "ZZ Style",
  description: "Fixture for style recovery.",
  serviceLabel: "ZZ Style",
  style: "hand-rolled",
  env: [{ vars: ["ZZSTYLE_TOKEN"], local: "headers", auth: "bearer", required: true }],
  fetchHelper: { local: "zzGet", base: "https://api.zzstyle.test", headers: "headers" },
  tools: [
    {
      name: "zzstyle_item_get",
      description: "Get one item.",
      impl: "rest",
      path: "/v1/items/x",
      args: { itemId: { type: "string", min: 1 } },
    },
  ],
};

describe("style recovery", () => {
  it("recovers staticPathStyle: template", () => {
    const raw = {
      ...BASE_SPEC,
      fetchHelper: { ...BASE_SPEC.fetchHelper, staticPathStyle: "template" },
    };
    const d = deriveSpec(emitted(raw));
    expect(d.ok).toBe(true);
    if (d.ok) {
      expect((d.spec["fetchHelper"] as Record<string, unknown>)["staticPathStyle"]).toBe(
        "template",
      );
    }
  });

  it("OMITS staticPathStyle when the emitter used the quoted default", () => {
    // Omitted, not "quoted": the schema default already supplies it, and emitting it would make
    // every derived spec differ from the hand-written fixtures for no behavioural reason.
    const d = deriveSpec(emitted(BASE_SPEC));
    expect(d.ok).toBe(true);
    if (d.ok) expect(d.spec["fetchHelper"]).not.toHaveProperty("staticPathStyle");
  });

  it("recovers argsSchemaStyle: expanded", () => {
    const d = deriveSpec(emitted({ ...BASE_SPEC, argsSchemaStyle: "expanded" }));
    expect(d.ok).toBe(true);
    if (d.ok) expect(d.spec["argsSchemaStyle"]).toBe("expanded");
  });

  it("OMITS argsSchemaStyle when the emitter used the inline default", () => {
    const d = deriveSpec(emitted(BASE_SPEC));
    expect(d.ok).toBe(true);
    if (d.ok) expect(d.spec).not.toHaveProperty("argsSchemaStyle");
  });

  it("abstains on staticPathStyle when every path is dynamic", () => {
    // src/emit/server/path-template.ts: staticStyle "has no effect on a path with any dynamic
    // segment". A connector whose every path interpolates an arg therefore carries NO evidence,
    // and guessing would be a wrong claim. Omit and let the default apply.
    const dynamic = {
      ...BASE_SPEC,
      fetchHelper: { ...BASE_SPEC.fetchHelper, staticPathStyle: "template" },
      tools: [
        {
          name: "zzstyle_item_get",
          description: "Get one item.",
          impl: "rest",
          path: "/v1/items/${arg.itemId|enc}",
          args: { itemId: { type: "string", min: 1 } },
        },
      ],
    };
    const d = deriveSpec(emitted(dynamic));
    expect(d.ok).toBe(true);
    if (d.ok) expect(d.spec["fetchHelper"]).not.toHaveProperty("staticPathStyle");
  });

  it("blocks style:mixed-static-path when two static paths disagree — a shape the emitter itself can never write", () => {
    // No spec can ASK for this: FetchHelperSchema.staticPathStyle is one value per connector, so
    // the emitter always renders every static path the same way. Simulating it by mutating one
    // tool's emitted quoted literal into a backtick template is the only way to construct the
    // "the emitter cannot have produced this" module voteStaticPathStyle's own docstring
    // describes — and the point of the test: deriveSpec must refuse rather than pick a winner.
    const raw = {
      ...BASE_SPEC,
      tools: [
        BASE_SPEC.tools[0]!,
        {
          name: "zzstyle_item_other",
          description: "Get another item.",
          impl: "rest",
          path: "/v1/items/y",
          args: {},
        },
      ],
    };
    const { server, manifest } = emitted(raw);
    expect(server).toContain('"/v1/items/y"');
    const mutated = server.replace('"/v1/items/y"', "`/v1/items/y`");

    const d = deriveSpec({ server: mutated, manifest });
    expect(d.ok).toBe(false);
    if (!d.ok) expect(d.blockers[0]?.kind).toBe("style:mixed-static-path");
  });

  it("blocks style:mixed-static-path the same way for a rest-kit connector — deriveRestKitSpec has its own copy of the check", () => {
    const raw = {
      name: "zzstylerest",
      displayName: "ZZ Style Rest",
      description: "Fixture for style recovery (rest-kit).",
      serviceLabel: "ZZ Style Rest",
      style: "rest-kit",
      env: [{ vars: ["ZZSTYLEREST_TOKEN"], local: "restAuthToken", auth: "bearer" }],
      fetchHelper: { local: "zzFetch", base: "https://api.zzstylerest.test" },
      tools: [
        { name: "zzstylerest_item_get", description: "Get one item.", path: "/v1/items/a" },
        { name: "zzstylerest_item_other", description: "Get another item.", path: "/v1/items/b" },
      ],
    };
    const { server, manifest } = emitted(raw);
    expect(server).toContain('"/v1/items/b"');
    const mutated = server.replace('"/v1/items/b"', "`/v1/items/b`");

    const d = deriveSpec({ server: mutated, manifest });
    expect(d.ok).toBe(false);
    if (!d.ok) expect(d.blockers[0]?.kind).toBe("style:mixed-static-path");
  });
});

// ---------------------------------------------------------------------------
// Step 6b: prove the vote rule against every fixture's own emitted bytes, rather than trust the
// paragraph in the plan. Independent of whether deriveSpec succeeds end-to-end for a fixture — a
// fixture can declare a non-default style while its module blocks on a gap that has nothing to do
// with style recovery, so routing through deriveSpec is not a reliable path to this evidence.
// Scanning the emitted AST directly finds the same evidence recognizeArgs/recognizePath would
// find inside a fully-recognized frame, without depending on every other recognizer succeeding.
// ---------------------------------------------------------------------------

type RawNode = Record<string, unknown>;

/** A raw, untyped recursive walk over a parsed body — test-only, not src/derive/read.ts's guarded
 * accessors: this file is proving a HISTOGRAM of evidence across a whole module, not claiming
 * byte ranges, so the hazards read.ts's header warns about (a matcher claiming a shape it only
 * partly checked) do not apply the same way here. */
function walk(node: unknown, visit: (n: RawNode) => void): void {
  if (node === null || typeof node !== "object") return;
  if (Array.isArray(node)) {
    for (const n of node) walk(n, visit);
    return;
  }
  const record = node as RawNode;
  if (typeof record["type"] === "string") visit(record);
  for (const key in record) {
    if (key === "loc") continue;
    walk(record[key], visit);
  }
}

/**
 * Every `z.object(...)` call anywhere in the module, as the SchemaShape voteArgsSchemaStyle
 * consumes. `recognizeArgs` itself is the filter — it rejects any CallExpression that is not
 * exactly `z.object(<ObjectExpression>)`, so walking every node and trying it on each one finds
 * precisely the tool-arg schemas, with no risk of matching an unrelated call (nothing else in
 * emitted output is named `z.object`).
 */
function collectSchemaShapes(
  body: readonly unknown[],
): { propertyCount: number; oneLine: boolean }[] {
  const shapes: { propertyCount: number; oneLine: boolean }[] = [];
  walk(body, (node) => {
    // biome-ignore lint/suspicious/noExplicitAny: bridging the raw walk into the AstNode read.ts expects.
    const result = recognizeArgs(node as any);
    if (result !== undefined) {
      shapes.push({
        propertyCount: Object.keys(result.args).length,
        oneLine: result.schemaStyle === "inline",
      });
    }
  });
  return shapes;
}

/** An ArrowFunctionExpression's path expression: its expression body, or its block's final `return`'s argument. */
function pathExpressionOf(node: RawNode): RawNode | undefined {
  if (node["type"] !== "ArrowFunctionExpression") return undefined;
  const body = node["body"] as RawNode;
  if (body["type"] !== "BlockStatement") return body;
  const stmts = body["body"] as RawNode[];
  const last = stmts.at(-1);
  if (last?.["type"] !== "ReturnStatement") return undefined;
  return last["argument"] as RawNode | undefined;
}

/**
 * Every tool's static-path evidence, found by locating calls to the connector's own read
 * fetch-helper / write-send-helper (hand-rolled, read-only-kit — including search tools, which
 * call the read helper the same way) or its rest-kit registrar (whose 4th argument is the
 * path-returning arrow). A dynamic path — one whose expression a locals-free `recognizePath`
 * cannot resolve, e.g. a hoisted local or the query branch's `const u = new URL(...)` — comes
 * back `undefined`, which is the CORRECT outcome for this vote regardless of why resolution
 * failed: a path with any unresolved dynamic segment carries no staticStyle evidence either way.
 */
function collectStaticStyles(
  body: readonly unknown[],
  spec: ConnectorSpec,
): ("quoted" | "template" | undefined)[] {
  const styles: ("quoted" | "template" | undefined)[] = [];

  const record = (pathNode: RawNode | undefined): void => {
    if (pathNode === undefined) return;
    // biome-ignore lint/suspicious/noExplicitAny: bridging the raw walk into the AstNode read.ts expects.
    const recognized = recognizePath(pathNode as any, new Map());
    styles.push(recognized?.staticStyle);
  };

  if (spec.style === "rest-kit") {
    const registrar = registrarName(spec);
    walk(body, (node) => {
      if (node["type"] !== "CallExpression") return;
      const callee = node["callee"] as RawNode | undefined;
      if (callee?.["type"] !== "Identifier" || callee["name"] !== registrar) return;
      const args = node["arguments"] as RawNode[];
      record(pathExpressionOf(args[3]!));
    });
  } else {
    const local = spec.fetchHelper.local;
    const names = new Set([local, `${local}Send`]);
    walk(body, (node) => {
      if (node["type"] !== "CallExpression") return;
      const callee = node["callee"] as RawNode | undefined;
      if (callee?.["type"] !== "Identifier" || !names.has(callee["name"] as string)) return;
      const args = node["arguments"] as RawNode[];
      record(args[0]);
    });
  }

  return styles;
}

const FIXTURES_DIR = join(import.meta.dir, "..", "..", "fixtures");

function fixtureNames(): string[] {
  return readdirSync(FIXTURES_DIR)
    .filter((f) => f.endsWith(".spec.json"))
    .map((f) => f.replace(".spec.json", ""))
    .sort();
}

describe("Step 6b: the vote's forced value re-emits byte-identical output for every fixture", () => {
  for (const name of fixtureNames()) {
    it(`${name}: forcing argsSchemaStyle/staticPathStyle to the vote's value changes nothing`, async () => {
      const raw = JSON.parse(readFileSync(join(FIXTURES_DIR, `${name}.spec.json`), "utf8"));
      const spec = parseSpec(raw);
      const original = formatAll(generate(spec)).find((f) => f.path.join("/") === "src/server.ts");
      if (original === undefined) throw new Error(`${name} emitted no src/server.ts`);

      const body = parseModule(original.content);
      const schemaShapes = collectSchemaShapes(body);
      const staticStyles = collectStaticStyles(body, spec);

      const argsVote = voteArgsSchemaStyle(schemaShapes);
      const staticVote = voteStaticPathStyle(staticStyles);

      // voteArgsSchemaStyle never blocks (see its own docstring) — only staticPathStyle's
      // unanimity rule can. A disagreement here is exactly what Step 6b exists to surface.
      expect(staticVote.ok).toBe(true);
      if (!staticVote.ok) return;

      const forcedRaw: Record<string, unknown> = { ...raw };
      if (argsVote !== undefined) forcedRaw["argsSchemaStyle"] = argsVote;
      if (staticVote.value !== undefined) {
        forcedRaw["fetchHelper"] = {
          ...((raw as Record<string, unknown>)["fetchHelper"] as Record<string, unknown>),
          staticPathStyle: staticVote.value,
        };
      }

      const forced = formatAll(generate(parseSpec(forcedRaw))).find(
        (f) => f.path.join("/") === "src/server.ts",
      );
      if (forced === undefined) throw new Error(`${name} (forced) emitted no src/server.ts`);

      expect(forced.content).toBe(original.content);
    });
  }
});
