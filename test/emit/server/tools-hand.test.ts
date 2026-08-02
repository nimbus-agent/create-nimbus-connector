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

  it("renders a static path as a template literal end-to-end when fetchHelper.staticPathStyle is 'template'", () => {
    const spec = parseSpec({
      name: "mercury",
      displayName: "Mercury",
      description: "d.",
      serviceLabel: "Mercury",
      style: "hand-rolled",
      fetchHelper: {
        local: "mercuryGet",
        base: "https://api.mercury.com",
        inlineHeaders: {},
        staticPathStyle: "template",
      },
      tools: [
        {
          name: "mercury_list",
          description: "List accounts.",
          path: "/api/v1/accounts",
        },
        {
          name: "mercury_get",
          description: "Get one account.",
          args: { id: { type: "string", min: 1 } },
          path: "/api/v1/account/${arg.id|enc}",
        },
      ],
    });
    const out = renderHandRolledTools(spec);
    // Static path: template style overrides renderPath's quoted default.
    expect(out).toContain("jsonResult(await mercuryGet(`/api/v1/accounts`))");
    expect(out).not.toContain('mercuryGet("/api/v1/accounts")');
    // Dynamic path: already a template literal under the default, unaffected either way.
    expect(out).toContain(
      "jsonResult(await mercuryGet(`/api/v1/account/${encodeURIComponent(p.id)}`))",
    );
  });
});

describe("hand-rolled query parameters", () => {
  const spec = (tools: unknown[]) =>
    parseSpec({
      name: "discord",
      title: "Discord",
      displayName: "Discord",
      description: "d.",
      serviceLabel: "Discord",
      style: "read-only-kit",
      fetchHelper: {
        local: "discordGet",
        base: "https://discord.com/api/v10",
        inlineHeaders: { Accept: "application/json" },
      },
      tools,
    });

  it("emits the URL block for a tool declaring query parameters", () => {
    const out = renderHandRolledTools(
      spec([
        {
          name: "discord_channel_messages",
          description: "List recent messages.",
          path: "/channels/${arg.channelId|enc}/messages",
          args: {
            channelId: { type: "string", min: 1 },
            limit: { type: "number", optional: true, default: 50, local: "lim" },
            after: { type: "string", optional: true },
          },
          query: [
            { name: "limit", arg: "limit" },
            { name: "after", arg: "after", omitWhen: "empty" },
          ],
        },
      ]),
    );
    expect(out).toContain("const lim = p.limit ?? 50;");
    expect(out).toContain(
      "const u = new URL(`https://discord.com/api/v10/channels/${encodeURIComponent(p.channelId)}/messages`);",
    );
    expect(out).toContain('u.searchParams.set("limit", String(lim));');
    expect(out).toContain('if (p.after !== undefined && p.after !== "") {');
    expect(out).toContain("const path = `${u.pathname}${u.search}`;");
    expect(out).toContain("return jsonResult(await discordGet(path));");
  });

  it("leaves a tool with no query on the unchanged path branch", () => {
    const out = renderHandRolledTools(
      spec([{ name: "discord_guilds", description: "List guilds.", path: "/users/@me/guilds" }]),
    );
    expect(out).not.toContain("new URL(");
    expect(out).toContain('jsonResult(await discordGet("/users/@me/guilds")),');
  });

  // The bug this brief exists to prevent: "query" is legal on a non-GET tool (rejected only
  // on a stub — see spec.ts), and this file builds its call with a GET/non-GET split. A
  // second, hand-duplicated call expression for the query branch would be free to disagree
  // with that split — exactly the kind of silent divergence a substring test on the GET case
  // alone would never catch.
  it("routes a non-GET query tool through discordSend with its method, not the read helper", () => {
    const out = renderHandRolledTools(
      spec([
        {
          name: "discord_channel_messages_search",
          description: "Search messages.",
          path: "/channels/${arg.channelId|enc}/messages/search",
          method: "POST",
          effect: "write",
          args: {
            channelId: { type: "string", min: 1 },
            query: { type: "string" },
          },
          query: [{ name: "q", arg: "query" }],
        },
      ]),
    );
    expect(out).toContain(
      'return jsonResult(await discordGetSend(path, "POST", JSON.stringify({ query: p.query })));',
    );
    expect(out).not.toContain("discordGet(path)");
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

  /**
   * Final fix wave, IMPORTANT 2. The body used to emit `p.<arg>` unconditionally, ignoring
   * the hoisted-locals map this call site already computes.
   */
  describe("hoisted args in a write body", () => {
    it("references the hoisted const, so the URL and the body carry the same value (silent case)", () => {
      const out = renderHandRolledTools(
        spec([
          {
            name: "zz_create",
            description: "C.",
            path: "/i?scope=${arg.scope}",
            method: "POST",
            effect: "write",
            args: {
              title: { type: "string" },
              scope: { type: "string", optional: true, default: "all" },
            },
            body: { title: "title", scope: "scope" },
          },
        ]),
      );
      expect(out).toContain('const scope = p.scope ?? "all";');
      expect(out).toContain(
        'zzGetSend(`/i?scope=${scope}`, "POST", JSON.stringify({ title: p.title, scope }))',
      );
      // The defect: `scope: p.scope` sent undefined in the body while the URL carried "all".
      expect(out).not.toContain("scope: p.scope");
    });

    it("emits no unread hoist for a defaulted arg the path never names (loud case)", () => {
      const out = renderHandRolledTools(
        spec([
          {
            name: "zz_create",
            description: "C.",
            path: "/i",
            method: "POST",
            effect: "write",
            args: { limit: { type: "number", optional: true, default: 20, local: "lim" } },
          },
        ]),
      );
      // The hoist IS emitted here, because the body consumes it.
      expect(out).toContain("const lim = p.limit ?? 20;");
      expect(out).toContain('zzGetSend("/i", "POST", JSON.stringify({ limit: lim }))');
    });

    it("drops the hoist entirely for a boolean arg nothing reads — a plain POST with one boolean arg (loud case)", () => {
      const out = renderHandRolledTools(
        spec([
          {
            name: "zz_create",
            description: "C.",
            path: "/i",
            method: "POST",
            effect: "write",
            args: { draft: { type: "boolean" } },
          },
        ]),
      );
      // `const draft = p.draft === true ? "true" : "false";` had no consumer: the body used
      // p.draft, so the const was a TS6133 and a biome noUnusedVariables error.
      expect(out).not.toContain("const draft =");
      // And the body sends a real JSON boolean, not the hoist's string.
      expect(out).toContain('zzGetSend("/i", "POST", JSON.stringify({ draft: p.draft }))');
    });

    it("keeps a boolean's hoist for the URL while the body still sends a real boolean", () => {
      const out = renderHandRolledTools(
        spec([
          {
            name: "zz_create",
            description: "C.",
            path: "/i?draft=${arg.draft|bool}",
            method: "POST",
            effect: "write",
            args: { title: { type: "string" }, draft: { type: "boolean" } },
            body: { title: "title", draft: "draft" },
          },
        ]),
      );
      expect(out).toContain('const draft = p.draft === true ? "true" : "false";');
      expect(out).toContain(
        'zzGetSend(`/i?draft=${draft}`, "POST", JSON.stringify({ title: p.title, draft: p.draft }))',
      );
    });

    it("emits no unread hoist on a GET whose defaulted arg the path never names", () => {
      const out = renderHandRolledTools(
        spec([
          {
            name: "zz_list",
            description: "L.",
            path: "/i",
            args: { limit: { type: "number", optional: true, default: 20, local: "lim" } },
          },
        ]),
      );
      expect(out).not.toContain("const lim =");
      expect(out).toContain('jsonResult(await zzGet("/i"))');
    });
  });
});

describe('renderHandRolledTools, handlerStyle "block"', () => {
  function blockSpec(tools: unknown[]) {
    return parseSpec({
      name: "mercury",
      displayName: "Mercury",
      description: "d.",
      serviceLabel: "Mercury",
      style: "read-only-kit",
      handlerStyle: "block",
      argsSchemaStyle: "expanded",
      fetchHelper: {
        local: "mercuryGet",
        base: "https://api.mercury.com",
        inlineHeaders: {},
        staticPathStyle: "template",
      },
      tools,
    });
  }

  it("gives a no-arg tool a statement body and no parameter", () => {
    const out = renderHandRolledTools(
      blockSpec([
        { name: "mercury_list", description: "List accounts.", path: "/api/v1/accounts" },
      ]),
    );
    expect(out).toBe(
      'reg(\n  "mercury_list",\n  "List accounts.",\n  z.object({}),\n  async () => {\n' +
        "    return jsonResult(await mercuryGet(`/api/v1/accounts`));\n  },\n);",
    );
  });

  it("gives an arg tool a statement body taking p, with the schema expanded", () => {
    const out = renderHandRolledTools(
      blockSpec([
        {
          name: "mercury_get",
          description: "Fetch one account.",
          args: { id: { type: "string", min: 1 } },
          path: "/api/v1/account/${arg.id|enc}",
        },
      ]),
    );
    expect(out).toBe(
      'reg(\n  "mercury_get",\n  "Fetch one account.",\n  z.object({\n  id: z.string().min(1),\n}),\n' +
        "  async (p) => {\n" +
        "    return jsonResult(await mercuryGet(`/api/v1/account/${encodeURIComponent(p.id)}`));\n" +
        "  },\n);",
    );
  });
});
