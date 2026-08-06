import { beforeAll, describe, expect, it } from "bun:test";
import { type AstNode, initParser, parseModule } from "../../src/derive/ast.ts";
import { deriveSpec } from "../../src/derive/index.ts";
import { constDecl } from "../../src/derive/read.ts";
import { recognizeBodyExpr } from "../../src/derive/server/body.ts";
import { generate } from "../../src/emit/index.ts";
import { formatAll, initFormatter } from "../../src/format.ts";
import { parseSpec } from "../../src/spec.ts";
import { displayPath } from "../../src/types.ts";

beforeAll(async () => {
  await initParser();
  await initFormatter();
});

/** Every file a raw spec emits, keyed by path — this repository's own emitter, not Nimbus. */
function emit(raw: unknown): Map<string, string> {
  const files = formatAll(generate(parseSpec(raw)));
  return new Map(files.map((f) => [displayPath(f.path), f.content]));
}

function serverOf(raw: unknown): string {
  const server = emit(raw).get("src/server.ts");
  if (server === undefined) throw new Error("no src/server.ts emitted");
  return server;
}

function derive(raw: unknown, mutate: (server: string) => string = (s) => s) {
  const files = emit(raw);
  const server = mutate(files.get("src/server.ts")!);
  return deriveSpec({ server, manifest: files.get("nimbus.extension.json")! });
}

/**
 * One connector exercising every clause of `renderBodyExpr`'s default and every case of
 * `fieldValue`, so the recognizer is measured against a spec an author actually wrote rather than
 * against a reconstruction of one.
 *
 * Every tool is a write, which is deliberate twice over: it is `zzwriteonly`'s shape (no read
 * helper at all, so `<local>Send` is the only fetch helper in the module), and it keeps each
 * tool's `body` the only thing that varies between them.
 */
const ZZBODY_SPEC = {
  name: "zzbody",
  displayName: "ZZ Body",
  description: "Fixture connector exercising the JSON body recognizer.",
  serviceLabel: "ZZ Body",
  style: "hand-rolled",
  network: ["api.zzbody.test"],
  env: [{ vars: ["ZZBODY_TOKEN"], local: "headers", auth: "bearer" }],
  fetchHelper: { local: "zzGet", base: "https://api.zzbody.test", headers: "headers" },
  tools: [
    {
      // The DEFAULT body, and `fieldValue`'s boolean case: a boolean reaches the body as the raw
      // `p.draft`, never through the hoist, whose value is the STRING "true"/"false".
      name: "zzbody_item_create",
      description: "Create an item.",
      method: "POST",
      effect: "write",
      args: { title: { type: "string", min: 1 }, draft: { type: "boolean", optional: true } },
      path: "/v1/items",
    },
    {
      // An explicit mapping that RENAMES: the API field is `display_name`, the arg is `title`.
      name: "zzbody_item_rename",
      description: "Rename an item.",
      method: "PATCH",
      effect: "write",
      args: { itemId: { type: "string", min: 1 }, title: { type: "string", min: 1 } },
      body: { title: "display_name" },
      path: "/v1/items/${arg.itemId|enc}",
    },
    {
      // `fieldValue`'s defaulted case: `scope` is not in the path, so the DEFAULT body carries it,
      // and it arrives through the hoisted const — which renders as the shorthand `{ scope }`.
      name: "zzbody_item_tag",
      description: "Tag an item.",
      method: "POST",
      effect: "write",
      args: {
        itemId: { type: "string", min: 1 },
        scope: { type: "string", optional: true, default: "all" },
      },
      path: "/v1/items/${arg.itemId}/tags",
    },
    {
      // A defaulted arg that IS in the path, named by an explicit mapping so it reaches the body
      // too: the URL gets the hoisted const and so does the body, which is the whole point of
      // `fieldValue`'s second case (the two used to disagree — see its docstring). Its `local`
      // differs from its own name, which is both required (RESERVED/collision rules: two tools
      // cannot hoist one identifier) and the more demanding shape — the field is named after the
      // ARG and the value after the LOCAL, so the two cannot be confused for one another.
      name: "zzbody_item_move",
      description: "Move an item.",
      method: "PUT",
      effect: "write",
      args: {
        itemId: { type: "string", min: 1 },
        scope: { type: "string", optional: true, default: "all", local: "moveScope" },
        note: { type: "string", min: 1 },
      },
      body: { scope: "scope", note: "note" },
      path: "/v1/items/${arg.itemId}/move/${arg.scope}",
    },
    {
      // The DEFAULT's path exclusion, taken to its limit: every arg is carried by the URL, so
      // `renderBodyExpr` returns undefined and the call site writes a literal `undefined`.
      name: "zzbody_item_delete",
      description: "Delete an item.",
      method: "DELETE",
      effect: "delete",
      args: { itemId: { type: "string", min: 1 } },
      path: "/v1/items/${arg.itemId|enc}",
    },
    {
      // The DEFAULT's QUERY exclusion — the clause that joined `pathArgs` later, and the one an
      // exclusion set frozen at "the path" would get wrong. `q` rides in the URL, so only `note`
      // belongs in the body.
      name: "zzbody_item_flag",
      description: "Flag items matching a query.",
      method: "POST",
      effect: "write",
      args: { q: { type: "string", min: 1 }, note: { type: "string", min: 1 } },
      query: [{ name: "q", arg: "q" }],
      path: "/v1/items",
    },
  ],
};

/** The `body` each tool's own author wrote — what the derived spec must reproduce, key for key. */
const AUTHORED_BODY: Record<string, Record<string, string> | undefined> = {
  zzbody_item_create: undefined,
  zzbody_item_rename: { title: "display_name" },
  zzbody_item_tag: undefined,
  zzbody_item_move: { scope: "scope", note: "note" },
  zzbody_item_delete: undefined,
  zzbody_item_flag: undefined,
};

function derivedTools(raw: unknown): Record<string, Record<string, unknown>> {
  const derivation = derive(raw);
  if (!derivation.ok) {
    throw new Error(`did not derive: ${derivation.blockers.map((b) => b.kind).join(", ")}`);
  }
  const tools = derivation.spec["tools"] as Record<string, unknown>[];
  return Object.fromEntries(tools.map((t) => [t["name"] as string, t]));
}

describe("recognizeBodyExpr", () => {
  // The emitted shapes each case below is read back off, pinned here so a change in
  // renderBodyExpr fails on THIS assertion — naming what moved — rather than as an opaque
  // recognizer refusal further down.
  it("reads back the five expressions renderBodyExpr actually writes", () => {
    const server = serverOf(ZZBODY_SPEC);
    // The default, with a boolean reaching past its hoist to the raw arg.
    expect(server).toContain("JSON.stringify({ title: p.title, draft: p.draft })");
    // An explicit mapping that renames.
    expect(server).toContain("JSON.stringify({ display_name: p.title })");
    // A defaulted arg, through its hoisted const — and therefore as a shorthand property.
    expect(server).toContain("JSON.stringify({ scope })");
    // The same case with a renamed const, for an arg the URL also carries.
    expect(server).toContain("JSON.stringify({ scope: moveScope, note: p.note })");
    // No body at all: renderBodyExpr returned undefined, so the call site wrote the literal.
    expect(server).toContain(
      'zzGetSend(`/v1/items/${encodeURIComponent(p.itemId)}`, "DELETE", undefined)',
    );
  });

  // The load-bearing assertion of this file. Comparing against the AUTHOR's own `body` — rather
  // than against a reconstruction, or against the emitted bytes — is what distinguishes "the
  // default was reconstructed correctly" from "some mapping was recorded that happens to re-emit
  // the same bytes". An explicit `body` derived where the author wrote none re-emits IDENTICAL
  // output, so the round-trip test cannot see it and only this can.
  it.each(Object.keys(AUTHORED_BODY))(
    "recovers %s's body exactly as its author declared it",
    (name) => {
      const tool = derivedTools(ZZBODY_SPEC)[name];
      expect(tool).toBeDefined();
      expect(tool?.["body"]).toEqual(AUTHORED_BODY[name]);
    },
  );

  it("omits `body` when an explicit mapping merely restates the default", () => {
    // The minimality rule from the other side: an author who spells out exactly what the default
    // would have produced emits byte-identical output, so no evidence distinguishes the two specs
    // — and the derived one must be the one that says less.
    const explicit = {
      ...ZZBODY_SPEC,
      tools: ZZBODY_SPEC.tools.map((t) =>
        t.name === "zzbody_item_create" ? { ...t, body: { title: "title", draft: "draft" } } : t,
      ),
    };
    expect(serverOf(explicit)).toBe(serverOf(ZZBODY_SPEC));
    expect(derivedTools(explicit)["zzbody_item_create"]?.["body"]).toBeUndefined();
  });

  it("records the mapping when a field's ORDER differs from the default's", () => {
    // Same field names, same args, different order — `Object.entries(tool.body)` drives the
    // emitted order, so this is a real byte difference and an explicit mapping is the only spec
    // that reproduces it.
    const reordered = {
      ...ZZBODY_SPEC,
      tools: ZZBODY_SPEC.tools.map((t) =>
        t.name === "zzbody_item_create" ? { ...t, body: { draft: "draft", title: "title" } } : t,
      ),
    };
    expect(serverOf(reordered)).not.toBe(serverOf(ZZBODY_SPEC));
    expect(derivedTools(reordered)["zzbody_item_create"]?.["body"]).toEqual({
      draft: "draft",
      title: "title",
    });
  });

  it("re-emits every file byte-identically", () => {
    // The other half of the claim: recovering the right `body` is worth nothing if the spec built
    // around it does not regenerate the connector.
    const files = emit(ZZBODY_SPEC);
    const derivation = derive(ZZBODY_SPEC);
    expect(derivation.ok).toBe(true);
    if (!derivation.ok) return;
    const reEmitted = emit(derivation.spec);
    expect([...reEmitted.keys()].sort()).toEqual([...files.keys()].sort());
    for (const [path, content] of files) expect(reEmitted.get(path)).toBe(content);
  });
});

/**
 * Every body expression `recognizeBodyExpr` must refuse, as a mutation of the module the emitter
 * actually wrote — so each row is provably one edit away from a producible shape, and each asserts
 * it changed something before asserting the refusal.
 */
const REFUSED_BODIES: ReadonlyArray<readonly [string, string, string]> = [
  [
    "a quoted key that is a valid identifier — renderBodyExpr quotes a field only when IDENT rejects it",
    "JSON.stringify({ display_name: p.title })",
    'JSON.stringify({ "display_name": p.title })',
  ],
  [
    "a longhand `{ scope: scope }` where the emitter writes the shorthand `{ scope }`",
    "JSON.stringify({ scope })",
    "JSON.stringify({ scope: scope })",
  ],
  [
    "a field naming an arg the schema never declared",
    "JSON.stringify({ display_name: p.title })",
    "JSON.stringify({ display_name: p.nickname })",
  ],
  [
    "a defaulted arg read raw, where fieldValue would have referenced its hoisted const",
    "JSON.stringify({ scope: moveScope, note: p.note })",
    "JSON.stringify({ scope: p.scope, note: p.note })",
  ],
  [
    "a defaulted arg inlined as `?? <default>`, which only the rest-kit callback (no hoists in scope) writes",
    "JSON.stringify({ scope })",
    'JSON.stringify({ scope: p.scope ?? "all" })',
  ],
  [
    "a boolean reaching the body through a hoisted const rather than the raw arg",
    "JSON.stringify({ title: p.title, draft: p.draft })",
    "JSON.stringify({ title: p.title, draft: draft })",
  ],
  [
    "one arg filling two fields — `body` is keyed by arg, so no mapping regenerates it",
    "JSON.stringify({ display_name: p.title })",
    "JSON.stringify({ display_name: p.title, name: p.title })",
  ],
  [
    "an empty object literal, which renderBodyExpr never writes (it returns undefined instead)",
    "JSON.stringify({ display_name: p.title })",
    "JSON.stringify({})",
  ],
  [
    "a computed key, whose Identifier names the KEY VARIABLE rather than a field",
    "JSON.stringify({ display_name: p.title })",
    "JSON.stringify({ [display_name]: p.title })",
  ],
  [
    "a spread inside the body object",
    "JSON.stringify({ display_name: p.title })",
    "JSON.stringify({ ...extra, display_name: p.title })",
  ],
  [
    "something other than JSON.stringify around the fields",
    "JSON.stringify({ display_name: p.title })",
    "serialize({ display_name: p.title })",
  ],
];

describe("recognizeBodyExpr refuses what renderBodyExpr cannot write", () => {
  it.each(REFUSED_BODIES)("%s", (_name, from, to) => {
    const pristine = serverOf(ZZBODY_SPEC);
    const corrupted = pristine.replace(from, to);
    expect(corrupted).not.toBe(pristine);
    expect(derive(ZZBODY_SPEC, () => corrupted).ok).toBe(false);
  });

  it("refuses a literal `undefined` body where the default would have sent fields", () => {
    // The DELETE's own shape, moved onto a tool whose args are not all in the URL: the only spec
    // that reproduces it is an explicit EMPTY mapping, which is what gets recorded — forced by
    // the evidence rather than volunteered.
    const pristine = serverOf(ZZBODY_SPEC);
    const corrupted = pristine.replace("JSON.stringify({ display_name: p.title })", "undefined");
    expect(corrupted).not.toBe(pristine);
    const derivation = derive(ZZBODY_SPEC, () => corrupted);
    expect(derivation.ok).toBe(true);
    if (!derivation.ok) return;
    const tools = derivation.spec["tools"] as Record<string, unknown>[];
    const renamed = tools.find((t) => t["name"] === "zzbody_item_rename");
    expect(renamed?.["body"]).toEqual({});
    // And it regenerates that module, which is the claim the empty mapping makes. Compared
    // against the spec that DECLARES `body: {}` rather than against the mutated text itself: the
    // mutation is a string edit on already-formatted output, so its line wrapping is Biome's for
    // the longer expression it replaced, not for the shorter one it left behind.
    const declared = {
      ...ZZBODY_SPEC,
      tools: ZZBODY_SPEC.tools.map((t) =>
        t.name === "zzbody_item_rename" ? { ...t, body: {} } : t,
      ),
    };
    expect(serverOf(declared)).not.toBe(serverOf(ZZBODY_SPEC));
    expect(emit(derivation.spec).get("src/server.ts")).toBe(serverOf(declared));
  });
});

/** The expression of `const x = <expr>;` — a body argument, on its own. */
function expr(source: string): AstNode {
  const decl = constDecl(parseModule(`const x = ${source};`)[0]);
  if (decl?.init === undefined) throw new Error(`no expression in ${source}`);
  return decl.init;
}

/** `zzbody_item_tag`'s tool, as `recognizeOne` hands it over: merged args, no query. */
const TAG_TOOL = {
  args: {
    itemId: { type: "string" as const, min: 1 },
    scope: { type: "string" as const, optional: true as const, default: "all" },
  },
  path: "/v1/items/${arg.itemId}/tags",
  method: "POST",
};

/**
 * The two contracts only a direct call can state, both of them Task 6's — `recognizeOne`
 * (tools-hand.ts) always passes `hoistsInScope: true`, because `renderTool` builds the body in
 * the same block as the hoists, so nothing above can reach the rest-kit half of `fieldValue`'s
 * second case or the path guard.
 */
describe("recognizeBodyExpr's contract for the rest-kit caller", () => {
  it("requires the inlined `?? <default>` when no hoisted const is in scope, and refuses the const", () => {
    // rest-kit builds the body in the registrar's SECOND callback, where the pathFn's hoists are
    // not in scope, so `renderBodyExpr` inlines the same value instead. The two forms are not
    // interchangeable: accepting either would derive a spec that re-emits the other.
    expect(
      recognizeBodyExpr(expr('JSON.stringify({ scope: parsed.scope ?? "all" })'), TAG_TOOL, false),
    ).toEqual({});
    expect(recognizeBodyExpr(expr("JSON.stringify({ scope })"), TAG_TOOL, false)).toBeUndefined();
    // And the mirror, which is what tools-hand.ts relies on: with the hoists in scope the const
    // is the only accepted form and the inlined default is refused.
    expect(recognizeBodyExpr(expr("JSON.stringify({ scope })"), TAG_TOOL, true)).toEqual({});
    expect(
      recognizeBodyExpr(expr('JSON.stringify({ scope: p.scope ?? "all" })'), TAG_TOOL, true),
    ).toBeUndefined();
  });

  it("verifies the inlined default's VALUE against the arg rather than recovering it", () => {
    expect(
      recognizeBodyExpr(expr('JSON.stringify({ scope: parsed.scope ?? "none" })'), TAG_TOOL, false),
    ).toBeUndefined();
  });

  it("refuses rather than throws when the tool's path will not parse", () => {
    // `parsePathTemplate` throws for a spec a human wrote; here the path was recovered from
    // source and, for a query tool, still carries the fetch helper's base — so a base carrying an
    // OpenAPI-style `{id}` would abort the whole corpus sweep rather than block one connector.
    const foreign = { ...TAG_TOOL, path: "https://api.x.test/{tenant}/v1/items" };
    expect(recognizeBodyExpr(expr("JSON.stringify({ scope })"), foreign, true)).toBeUndefined();
  });

  it("returns undefined for a GET, mirroring renderBodyExpr's own first line", () => {
    const get = { ...TAG_TOOL, method: "GET" };
    expect(recognizeBodyExpr(expr("JSON.stringify({ scope })"), get, true)).toBeUndefined();
  });
});
