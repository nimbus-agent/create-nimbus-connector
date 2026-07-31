import { describe, expect, it } from "bun:test";
import { renderBodyExpr } from "../../../src/emit/server/body.ts";
import { parseSpec } from "../../../src/spec.ts";

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

describe("renderBodyExpr", () => {
  it("returns undefined for a GET", () => {
    expect(renderBodyExpr(toolOf({ path: "/a" }), "p")).toBeUndefined();
  });

  it("returns undefined for a non-GET with no args — a DELETE sends no body", () => {
    expect(
      renderBodyExpr(toolOf({ path: "/a", method: "DELETE", effect: "delete" }), "p"),
    ).toBeUndefined();
  });

  it("uses the args object, preserving declared types", () => {
    const t = toolOf({
      path: "/a",
      method: "POST",
      effect: "write",
      args: { title: { type: "string" }, count: { type: "number" } },
    });
    expect(renderBodyExpr(t, "p")).toBe("JSON.stringify({ title: p.title, count: p.count })");
  });

  it("renames keys under an explicit mapping", () => {
    const t = toolOf({
      path: "/a",
      method: "POST",
      effect: "write",
      args: { title: { type: "string" } },
      body: { title: "issue_title" },
    });
    expect(renderBodyExpr(t, "p")).toBe("JSON.stringify({ issue_title: p.title })");
  });

  it("quotes an API field name that is not a JS identifier", () => {
    const t = toolOf({
      path: "/a",
      method: "POST",
      effect: "write",
      args: { title: { type: "string" } },
      body: { title: "issue-title" },
    });
    expect(renderBodyExpr(t, "p")).toBe('JSON.stringify({ "issue-title": p.title })');
  });

  it("omits args that the mapping does not name", () => {
    const t = toolOf({
      path: "/a",
      method: "POST",
      effect: "write",
      args: { title: { type: "string" }, id: { type: "string" } },
      body: { title: "t" },
    });
    expect(renderBodyExpr(t, "p")).toBe("JSON.stringify({ t: p.title })");
  });
});
