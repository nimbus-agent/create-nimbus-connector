import { describe, expect, it } from "bun:test";
import { renderWriteHelper } from "../../../src/emit/server/fetch-helper.ts";
import { renderHandRolledTools } from "../../../src/emit/server/tools-hand.ts";
import { parseSpec } from "../../../src/spec.ts";

function make(tools: unknown[]) {
  return parseSpec({
    name: "nr",
    displayName: "NR",
    description: "d.",
    serviceLabel: "New Relic",
    style: "hand-rolled",
    fetchHelper: { local: "nrGet", base: "https://api.newrelic.com", inlineHeaders: {} },
    tools,
  });
}

describe("renderHandRolledTools", () => {
  it("renders a no-arg tool as a concise arrow with no parameter", () => {
    const out = renderHandRolledTools(
      make([
        {
          name: "nr_app_list",
          description: "List APM applications.",
          path: "/v2/applications.json",
        },
      ]),
    );
    expect(out).toBe(
      'reg("nr_app_list", "List APM applications.", z.object({}), async () =>\n' +
        '  jsonResult(await nrGet("/v2/applications.json")),\n);',
    );
  });

  it("renders an arg tool with no hoists as a concise arrow taking p", () => {
    const out = renderHandRolledTools(
      make([
        {
          name: "s_release_list",
          description: "List releases for a project.",
          args: { projectSlug: { type: "string", min: 1 } },
          path: "/projects/${arg.projectSlug}/releases/",
        },
      ]),
    );
    expect(out).toContain(
      "async (p) => jsonResult(await nrGet(`/projects/${p.projectSlug}/releases/`)),",
    );
  });

  it("renders a hoisting tool as a block body", () => {
    const out = renderHandRolledTools(
      make([
        {
          name: "nr_alert_violations",
          description: "List recent alert violations.",
          args: { only_open: { type: "boolean", optional: true, local: "only" } },
          path: "/v2/alerts_violations.json?only_open=${arg.only_open|bool}",
        },
      ]),
    );
    expect(out).toContain("async (p) => {");
    expect(out).toContain('const only = p.only_open === true ? "true" : "false";');
    expect(out).toContain(
      "return jsonResult(await nrGet(`/v2/alerts_violations.json?only_open=${only}`));",
    );
  });

  it("renders a stub tool that throws", () => {
    const out = renderHandRolledTools(
      make([{ name: "nr_write", description: "Write.", impl: "stub" }]),
    );
    expect(out).toContain('throw new Error("nr_write is not implemented");');
  });

  it("separates multiple tools with a blank line", () => {
    const out = renderHandRolledTools(
      make([
        { name: "a", description: "A.", path: "/a" },
        { name: "b", description: "B.", path: "/b" },
      ]),
    );
    expect(out.split("\n\n")).toHaveLength(2);
  });

  it("stub tool with args emits no parameter", () => {
    const out = renderHandRolledTools(
      make([
        {
          name: "nr_write",
          description: "Write data.",
          args: { data: { type: "string", min: 1 } },
          impl: "stub",
        },
      ]),
    );
    expect(out).toContain("async () => {");
    expect(out).toContain('throw new Error("nr_write is not implemented");');
  });

  it("get tool with unreferenced argument emits no parameter", () => {
    const out = renderHandRolledTools(
      make([
        {
          name: "nr_unused_arg",
          description: "Endpoint that ignores args.",
          args: { unused: { type: "string", min: 1 } },
          path: "/v2/data.json",
        },
      ]),
    );
    expect(out).toContain("async () =>");
    expect(out).toContain('jsonResult(await nrGet("/v2/data.json")),');
  });

  it("get tool with referenced argument emits parameter", () => {
    const out = renderHandRolledTools(
      make([
        {
          name: "nr_ref_arg",
          description: "Endpoint that uses args.",
          args: { id: { type: "string", min: 1 } },
          path: "/v2/resource/${arg.id}",
        },
      ]),
    );
    expect(out).toContain("async (p) => jsonResult(await nrGet(`/v2/resource/${p.id}`)),");
  });

  it("hoisted argument requires parameter for hoist line", () => {
    const out = renderHandRolledTools(
      make([
        {
          name: "nr_hoisted",
          description: "Endpoint with hoisted arg.",
          args: { enabled: { type: "boolean", optional: true } },
          path: "/v2/data?enabled=${arg.enabled|bool}",
        },
      ]),
    );
    expect(out).toContain("async (p) => {");
    expect(out).toContain('const enabled = p.enabled === true ? "true" : "false";');
  });

  it("literal p. in path with unreferenced arg emits no parameter", () => {
    const out = renderHandRolledTools(
      make([
        {
          name: "nr_literal_p",
          description: "File endpoint.",
          args: { unused: { type: "string", min: 1 } },
          path: "/files/p.json",
        },
      ]),
    );
    expect(out).toContain("async () =>");
    expect(out).toContain('jsonResult(await nrGet("/files/p.json")),');
  });
});

describe("hand-rolled write support", () => {
  const spec = (tools: unknown[]) =>
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
      tools,
    });

  it("emits NO write helper for a read-only spec — this is what keeps the 6/6 fixtures byte-identical", () => {
    expect(renderWriteHelper(spec([{ name: "a", description: "A.", path: "/a" }]))).toBeUndefined();
  });

  it("emits a write helper when any tool is non-GET", () => {
    const out = renderWriteHelper(
      spec([{ name: "a", description: "A.", path: "/a", method: "POST", effect: "write" }]),
    );
    expect(out).toContain("async function zzGetSend(");
    expect(out).toContain("method,");
    expect(out).toContain('"Content-Type": "application/json"');
  });

  it("routes a write tool through the write helper with method and body", () => {
    const out = renderHandRolledTools(
      spec([
        {
          name: "zz_create",
          description: "C.",
          path: "/i",
          method: "POST",
          effect: "write",
          args: { title: { type: "string" } },
        },
      ]),
    );
    // pathExpr follows the same renderPath contract as the read path: a fully static
    // path renders as a plain double-quoted string, not a template literal.
    expect(out).toContain('zzGetSend("/i", "POST", JSON.stringify({ title: p.title }))');
  });

  it("sends no body on a DELETE with no args", () => {
    const out = renderHandRolledTools(
      spec([{ name: "zz_rm", description: "R.", path: "/i", method: "DELETE", effect: "delete" }]),
    );
    expect(out).toContain('zzGetSend("/i", "DELETE", undefined)');
  });

  it("PATCH excludes its path id from the default body but still takes a parameter for the path", () => {
    const out = renderHandRolledTools(
      spec([
        {
          name: "zz_update",
          description: "U.",
          path: "/items/${arg.id}",
          method: "PATCH",
          effect: "write",
          args: { id: { type: "string" }, title: { type: "string" } },
        },
      ]),
    );
    expect(out).toContain("async (p) =>");
    expect(out).toContain(
      'zzGetSend(`/items/${p.id}`, "PATCH", JSON.stringify({ title: p.title }))',
    );
  });

  it("DELETE with only a path id sends no body but still takes a parameter for the path", () => {
    const out = renderHandRolledTools(
      spec([
        {
          name: "zz_delete",
          description: "D.",
          path: "/items/${arg.id}",
          method: "DELETE",
          effect: "delete",
          args: { id: { type: "string" } },
        },
      ]),
    );
    expect(out).toContain("async (p) =>");
    expect(out).toContain('zzGetSend(`/items/${p.id}`, "DELETE", undefined)');
  });
});
