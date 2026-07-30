import { describe, expect, it } from "bun:test";
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
    expect(out.split("\n\n").length).toBe(2);
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
