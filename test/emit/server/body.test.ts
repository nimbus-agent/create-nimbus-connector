import { describe, expect, it } from "bun:test";
import { hoistedLocals } from "../../../src/emit/server/args.ts";
import { renderBodyExpr } from "../../../src/emit/server/body.ts";
import type { RenderContext } from "../../../src/emit/server/path-template.ts";
import { parseSpec, type ToolSpec } from "../../../src/spec.ts";

const toolOf = (o: Record<string, unknown>) =>
  parseSpec({
    name: "zz",
    title: "Zz",
    displayName: "Zz",
    description: "d.",
    serviceLabel: "Zz",
    style: "hand-rolled",
    network: ["api.zz.test"],
    syncInterval: 300,
    minNimbusVersion: "0.2.0",
    env: [{ vars: ["ZZ_TOKEN"], local: "headers", bindings: ["t"], auth: "bearer" }],
    fetchHelper: { local: "zzGet", base: "https://api.zz.test", headers: "headers" },
    tools: [{ name: "zz_a", description: "A.", ...o }],
  }).tools[0]!;

/** Nothing hoisted is in scope — the rest-kit init callback's situation. */
const noScope = (param: string): RenderContext => ({ param, hoisted: new Map() });

/** Every hoistable arg is in scope — the hand-rolled handler block's situation. */
const inScope = (t: ToolSpec, param: string): RenderContext => ({
  param,
  hoisted: hoistedLocals(t.args),
});

/** The rendered expression only, for the cases where hoist usage is not at issue. */
const expr = (t: ToolSpec, param: string) => renderBodyExpr(t, noScope(param))?.expr;

describe("renderBodyExpr", () => {
  it("returns undefined for a GET", () => {
    expect(renderBodyExpr(toolOf({ path: "/a" }), noScope("p"))).toBeUndefined();
  });

  it("returns undefined for a non-GET with no args — a DELETE sends no body", () => {
    expect(
      renderBodyExpr(toolOf({ path: "/a", method: "DELETE", effect: "delete" }), noScope("p")),
    ).toBeUndefined();
  });

  it("uses the args object, preserving declared types", () => {
    const t = toolOf({
      path: "/a",
      method: "POST",
      effect: "write",
      args: { title: { type: "string" }, count: { type: "number" } },
    });
    expect(expr(t, "p")).toBe("JSON.stringify({ title: p.title, count: p.count })");
  });

  it("excludes an arg referenced in the path from the default body — a PATCH must not send its id twice", () => {
    const t = toolOf({
      path: "/items/${arg.id}",
      method: "PATCH",
      effect: "write",
      args: { id: { type: "string" }, title: { type: "string" } },
    });
    expect(expr(t, "p")).toBe("JSON.stringify({ title: p.title })");
  });

  it("returns undefined when every default-body arg is a path arg — a DELETE with only its id arg sends no body", () => {
    const t = toolOf({
      path: "/items/${arg.id}",
      method: "DELETE",
      effect: "delete",
      args: { id: { type: "string" } },
    });
    expect(renderBodyExpr(t, noScope("p"))).toBeUndefined();
  });

  // Important 3 (Task 4, round 1 review): pathArgs used to be the complete model of "what
  // the URL carries" — true only while the URL was exactly the path. "query" makes the URL
  // carry more, and the exclusion has to grow with it, or a non-GET query tool sends the
  // same arg twice (once in the query string, once in the JSON body).
  it("excludes an arg referenced in query from the default body — a write must not send it twice", () => {
    const t = toolOf({
      path: "/items",
      method: "POST",
      effect: "write",
      args: { filter: { type: "string" }, title: { type: "string" } },
      query: [{ name: "filter", arg: "filter" }],
    });
    expect(expr(t, "p")).toBe("JSON.stringify({ title: p.title })");
  });

  it("returns undefined when every default-body arg is a query arg — mirrors the path-only case", () => {
    const t = toolOf({
      path: "/items",
      method: "POST",
      effect: "write",
      args: { filter: { type: "string" } },
      query: [{ name: "filter", arg: "filter" }],
    });
    expect(renderBodyExpr(t, noScope("p"))).toBeUndefined();
  });

  it("excludes both a path arg and a query arg from the default body together", () => {
    const t = toolOf({
      path: "/items/${arg.id}",
      method: "PATCH",
      effect: "write",
      args: { id: { type: "string" }, filter: { type: "string" }, title: { type: "string" } },
      query: [{ name: "filter", arg: "filter" }],
    });
    expect(expr(t, "p")).toBe("JSON.stringify({ title: p.title })");
  });

  it("keeps a query arg when the mapping names it explicitly — the default excludes it, an explicit request does not", () => {
    const t = toolOf({
      path: "/items",
      method: "POST",
      effect: "write",
      args: { filter: { type: "string" } },
      query: [{ name: "filter", arg: "filter" }],
      body: { filter: "q" },
    });
    expect(expr(t, "p")).toBe("JSON.stringify({ q: p.filter })");
  });

  it("renames keys under an explicit mapping", () => {
    const t = toolOf({
      path: "/a",
      method: "POST",
      effect: "write",
      args: { title: { type: "string" } },
      body: { title: "issue_title" },
    });
    expect(expr(t, "p")).toBe("JSON.stringify({ issue_title: p.title })");
  });

  it("quotes an API field name that is not a JS identifier", () => {
    const t = toolOf({
      path: "/a",
      method: "POST",
      effect: "write",
      args: { title: { type: "string" } },
      body: { title: "issue-title" },
    });
    expect(expr(t, "p")).toBe('JSON.stringify({ "issue-title": p.title })');
  });

  it("keeps a path arg when the mapping names it explicitly — the default excludes it, an explicit request does not", () => {
    const t = toolOf({
      path: "/a/${arg.id|enc}",
      method: "PATCH",
      effect: "write",
      args: { id: { type: "string" }, title: { type: "string" } },
      body: { id: "item_id", title: "t" },
    });
    expect(expr(t, "p")).toBe("JSON.stringify({ item_id: p.id, t: p.title })");
  });

  it("omits args that the mapping does not name", () => {
    const t = toolOf({
      path: "/a",
      method: "POST",
      effect: "write",
      args: { title: { type: "string" }, id: { type: "string" } },
      body: { title: "t" },
    });
    expect(expr(t, "p")).toBe("JSON.stringify({ t: p.title })");
  });
});

/**
 * Final fix wave, IMPORTANT 2. The body used to emit `${param}.${arg}` unconditionally,
 * ignoring the hoisted-locals map both call sites already compute. Two defects fell out of
 * that, and they need opposite treatment, which is why they are tested side by side.
 */
describe("renderBodyExpr and hoisted args", () => {
  const defaultedInBoth = () =>
    toolOf({
      path: "/items?scope=${arg.scope}",
      method: "POST",
      effect: "write",
      args: {
        title: { type: "string" },
        scope: { type: "string", optional: true, default: "all" },
      },
      body: { title: "title", scope: "scope" },
    });

  it("references the hoisted const when it is in scope — the path and the body must not disagree about one argument's value", () => {
    const t = defaultedInBoth();
    const out = renderBodyExpr(t, inScope(t, "p"));
    // The path renders `${scope}` (the hoisted const). Emitting `p.scope` here would send
    // the default in the URL and `undefined` in the body, on the same call.
    // Shorthand, because the hoisted const is named after the field it fills — the corpus's
    // own `JSON.stringify({ issueId, status })` shape.
    expect(out?.expr).toBe("JSON.stringify({ title: p.title, scope })");
    expect([...(out?.hoistsUsed ?? [])]).toEqual(["scope"]);
  });

  it("inlines the same default when no hoist is in scope — the rest-kit init callback cannot see the path callback's consts", () => {
    const t = defaultedInBoth();
    const out = renderBodyExpr(t, noScope("parsed"));
    expect(out?.expr).toBe('JSON.stringify({ title: parsed.title, scope: parsed.scope ?? "all" })');
    // Nothing was referenced, so nothing must be kept alive on the hoist side.
    expect([...(out?.hoistsUsed ?? [])]).toEqual([]);
  });

  it("uses a defaulted arg's hoist even when the path never mentions it", () => {
    const t = toolOf({
      path: "/items",
      method: "POST",
      effect: "write",
      args: { limit: { type: "number", optional: true, default: 20, local: "lim" } },
    });
    const out = renderBodyExpr(t, inScope(t, "p"));
    expect(out?.expr).toBe("JSON.stringify({ limit: lim })");
    expect([...(out?.hoistsUsed ?? [])]).toEqual(["limit"]);
  });

  it("sends a boolean as a real JSON boolean, never the hoisted string — the hoist is a URL device", () => {
    const t = toolOf({
      path: "/items",
      method: "POST",
      effect: "write",
      args: { draft: { type: "boolean", optional: true } },
    });
    const out = renderBodyExpr(t, inScope(t, "p"));
    // `const draft = p.draft === true ? "true" : "false"` is right in a path segment and
    // wrong in a JSON body: the API would receive the string "true".
    expect(out?.expr).toBe("JSON.stringify({ draft: p.draft })");
    expect(out?.expr).not.toContain('"true"');
    // Reporting no usage is what lets the caller drop an otherwise-unread hoist.
    expect([...(out?.hoistsUsed ?? [])]).toEqual([]);
  });

  it("renders a boolean twice over, differently, when it is in both the path and the body", () => {
    const t = toolOf({
      path: "/items?draft=${arg.draft|bool}",
      method: "POST",
      effect: "write",
      args: { title: { type: "string" }, draft: { type: "boolean", optional: true } },
      body: { title: "title", draft: "draft" },
    });
    const out = renderBodyExpr(t, inScope(t, "p"));
    // The URL gets the string form via the hoist; the body gets the real boolean. Two
    // serialisations of one value, which is correct, not a disagreement about it.
    expect(out?.expr).toBe("JSON.stringify({ title: p.title, draft: p.draft })");
    expect([...(out?.hoistsUsed ?? [])]).toEqual([]);
  });

  it("inlines a numeric default without quoting it", () => {
    const t = toolOf({
      path: "/items",
      method: "POST",
      effect: "write",
      args: { limit: { type: "number", optional: true, default: 20 } },
    });
    expect(expr(t, "parsed")).toBe("JSON.stringify({ limit: parsed.limit ?? 20 })");
  });
});

/**
 * The URL and the JSON body render an unset optional boolean differently, on purpose.
 *
 * Reachable only when the spec gives an explicit `body` mapping that re-includes an arg the
 * path already references. With the default body, a path-referenced arg is excluded outright
 * (D5), so there is nothing for the two halves to disagree about — the divergence exists
 * only where the author deliberately asked for the value in both places.
 *
 * Pinned side by side, because it looks like a bug until you know where each half's rule
 * comes from, and a future "make these consistent" change would silently break one of them.
 *
 * URL — `false`. Not our choice: newrelic is one of the four byte-locked golden fixtures,
 * and the real hand-written connector emits
 *   `const only = p.only_open === true ? "true" : "false";`
 * A query string carries text, and the corpus decided what that text is. Changing it drops
 * newrelic below 6/6 and the generator stops reproducing the corpus.
 *
 * Body — omitted. A JSON body carries types, and every API distinguishes a `false` the
 * caller asserted from a key the caller never sent. Emitting `false` for an unset optional
 * would fabricate an assertion the user did not make, and would be wrong in exactly the
 * cases where the server's own default is `true`.
 *
 * So they differ because the media differ, and one of the two is externally fixed. Neither
 * is the other's bug.
 */
describe("an unset optional boolean: URL says false, body says nothing", () => {
  const tool = toolOf({
    path: "/x?flag=${arg.flag|bool}",
    method: "POST",
    effect: "write",
    args: { flag: { type: "boolean", optional: true } },
    // An explicit mapping is required to reach this case at all: with the default body, a
    // path-referenced arg is excluded outright (D5), so there is nothing to disagree with.
    body: { flag: "flag" },
  });

  it("omits it from the body rather than sending false", () => {
    // p.flag is undefined when unset, and JSON.stringify drops undefined values — so the
    // key is absent from the wire payload, not present-and-false.
    expect(expr(tool, "p")).toBe("JSON.stringify({ flag: p.flag })");
    expect(JSON.stringify({ flag: undefined })).toBe("{}");
  });

  it('does not reach for the hoisted string, which would send "false" as JSON text', () => {
    // The hoist exists for the URL and yields the *string* "false". Referencing it here
    // would put `"false"` in the body — a truthy string — which is the worst of the three
    // possible answers.
    expect(expr(tool, "p")).not.toContain('"false"');
    expect(expr(tool, "p")).not.toMatch(/=== true \?/);
  });
});
