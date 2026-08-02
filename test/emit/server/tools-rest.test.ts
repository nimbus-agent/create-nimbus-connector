import { describe, expect, it } from "bun:test";
import { renderRestKitTools } from "../../../src/emit/server/tools-rest.ts";
import { parseSpec } from "../../../src/spec.ts";

function restSpec(tools: unknown[]) {
  return parseSpec({
    name: "discord",
    title: "Discord",
    displayName: "Discord",
    description: "d.",
    serviceLabel: "Discord",
    style: "rest-kit",
    env: [{ vars: ["DISCORD_BOT_TOKEN"], local: "tokenHeaders", bindings: ["t"], auth: "bearer" }],
    fetchHelper: { local: "discordFetch", base: "https://discord.com/api/v10" },
    tools,
  });
}

const spec = parseSpec({
  name: "discord",
  title: "Discord",
  displayName: "Discord",
  description: "d.",
  serviceLabel: "Discord",
  style: "rest-kit",
  env: [{ vars: ["DISCORD_BOT_TOKEN"], local: "tokenHeaders", bindings: ["t"], auth: "bearer" }],
  fetchHelper: { local: "discordFetch", base: "https://discord.com/api/v10" },
  tools: [
    {
      name: "discord_guild_list",
      description: "List guilds the bot is a member of.",
      path: "/users/@me/guilds",
    },
    {
      name: "discord_channel_list",
      description: "List channels in a guild (id, type, name).",
      args: { guildId: { type: "string", min: 1 } },
      path: "/guilds/${arg.guildId|enc}/channels",
    },
  ],
});

const specWithUnusedArgs = parseSpec({
  name: "discord",
  title: "Discord",
  displayName: "Discord",
  description: "d.",
  serviceLabel: "Discord",
  style: "rest-kit",
  env: [{ vars: ["DISCORD_BOT_TOKEN"], local: "tokenHeaders", bindings: ["t"], auth: "bearer" }],
  fetchHelper: { local: "discordFetch", base: "https://discord.com/api/v10" },
  tools: [
    {
      name: "discord_unused_args",
      description: "Tool with unused args.",
      args: { unusedArg: { type: "string", min: 1 } },
      path: "/users/@me/guilds",
    },
  ],
});

const specWithStub = parseSpec({
  name: "discord",
  title: "Discord",
  displayName: "Discord",
  description: "d.",
  serviceLabel: "Discord",
  style: "rest-kit",
  env: [{ vars: ["DISCORD_BOT_TOKEN"], local: "tokenHeaders", bindings: ["t"], auth: "bearer" }],
  fetchHelper: { local: "discordFetch", base: "https://discord.com/api/v10" },
  tools: [
    {
      name: "discord_stub_tool",
      description: "A stub tool.",
      impl: "stub",
    },
  ],
});

describe("renderRestKitTools", () => {
  it("emits the registrar factory block", () => {
    const out = renderRestKitTools(spec);
    expect(out).toContain("const registerDiscordTool = makeRestToolRegistrar({");
    expect(out).toContain("  registrar: reg,");
    expect(out).toContain('  tokenEnv: "DISCORD_BOT_TOKEN",');
    expect(out).toContain('  serviceLabel: "Discord",');
    expect(out).toContain("  fetch: discordFetch,");
    expect(out).toContain("});");
  });

  it("emits a no-arg tool with an empty lambda", () => {
    expect(renderRestKitTools(spec)).toContain('  () => "/users/@me/guilds",');
  });

  it("emits an arg tool using the parsed parameter", () => {
    expect(renderRestKitTools(spec)).toContain(
      "  (parsed) => `/guilds/${encodeURIComponent(parsed.guildId)}/channels`,",
    );
  });

  it("emits a tool with unused args as a no-arg lambda", () => {
    const out = renderRestKitTools(specWithUnusedArgs);
    expect(out).toContain('  () => "/users/@me/guilds",');
  });

  it("emits a stub tool with an empty lambda", () => {
    const out = renderRestKitTools(specWithStub);
    expect(out).toContain("  () => {");
    expect(out).toContain('    throw new Error("discord_stub_tool is not implemented");');
  });
});

describe("rest-kit writes", () => {
  it("passes method and body as buildInit", () => {
    const out = renderRestKitTools(
      restSpec([
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
    expect(out).toContain('({ method: "POST", body: JSON.stringify({ title: parsed.title }) })');
  });

  it("emits no 5th argument for a GET — read-only rest-kit output must not change", () => {
    const out = renderRestKitTools(restSpec([{ name: "zz_a", description: "A.", path: "/a" }]));
    expect(out).not.toContain("method:");
  });

  // Regression test for a bug the brief's own Step 3 snippet contained: an unconditional
  // `(parsed) => ({ ... })` buildInit arrow declares an unused "parsed" whenever the tool's
  // body is undefined. A DELETE whose only arg is in the path is exactly that case —
  // renderBodyExpr excludes the path arg, leaving no body, so the buildInit arrow must take
  // no parameter at all or the generated package's noUnusedParameters tsconfig rejects it.
  it("emits a parameterless buildInit for a DELETE whose only arg is in the path", () => {
    const out = renderRestKitTools(
      restSpec([
        {
          name: "zz_delete",
          description: "D.",
          path: "/i/${arg.id|enc}",
          method: "DELETE",
          effect: "delete",
          args: { id: { type: "string" } },
        },
      ]),
    );
    expect(out).toContain('() => ({ method: "DELETE" })');
    expect(out).not.toContain("body:");
  });

  // Pins the ordering in the hoisted-args return path specifically: buildInit must be
  // appended after the multi-line buildPath arrow's closing "},", not folded inside it.
  //
  // This case used to be written with `flag` absent from the path, which produced the
  // multi-line form only because the boolean's hoist was emitted — unread, i.e. the very
  // TS6133 the final fix wave removed. The path now names the hoisted arg, so the hoist has
  // a genuine consumer and the multi-line form is reached honestly.
  it("appends buildInit after the hoisted buildPath closes", () => {
    const out = renderRestKitTools(
      restSpec([
        {
          name: "zz_hoisted_write",
          description: "H.",
          path: "/i/${arg.id|enc}?draft=${arg.flag|bool}",
          method: "PATCH",
          effect: "write",
          args: {
            id: { type: "string" },
            flag: { type: "boolean" },
            title: { type: "string" },
          },
        },
      ]),
    );
    expect(out).toContain('    const flag = parsed.flag === true ? "true" : "false";');
    expect(out).toContain(
      '  },\n  (parsed) => ({ method: "PATCH", body: JSON.stringify({ title: parsed.title }) }),',
    );
  });

  // Final fix wave, IMPORTANT 2 (the "loud" half), for rest-kit.
  it("emits no hoist for a boolean arg the path never names — the init callback uses the raw arg", () => {
    const out = renderRestKitTools(
      restSpec([
        {
          name: "zz_flag_write",
          description: "F.",
          path: "/i",
          method: "POST",
          effect: "write",
          args: { draft: { type: "boolean" } },
        },
      ]),
    );
    expect(out).not.toContain("const draft =");
    expect(out).toContain('  () => "/i",');
    expect(out).toContain('({ method: "POST", body: JSON.stringify({ draft: parsed.draft }) })');
  });

  // Final fix wave, IMPORTANT 2 (the "silent" half), for rest-kit. The hoisted const lives
  // in the buildPath callback and is out of scope in buildInit, so the default is inlined
  // there rather than referenced — same value, two expressions.
  it("applies a defaulted arg's default in the body too, not just in the path", () => {
    const out = renderRestKitTools(
      restSpec([
        {
          name: "zz_scoped_write",
          description: "S.",
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
    expect(out).toContain('    const scope = parsed.scope ?? "all";');
    expect(out).toContain(
      'body: JSON.stringify({ title: parsed.title, scope: parsed.scope ?? "all" })',
    );
  });
});

describe("rest-kit query parameters", () => {
  it("emits the URL block for a tool declaring query parameters", () => {
    const spec = parseSpec({
      name: "discord",
      title: "Discord",
      displayName: "Discord",
      description: "d.",
      serviceLabel: "Discord",
      style: "rest-kit",
      env: [{ vars: ["DISCORD_TOKEN"], local: "token", auth: "bearer" }],
      fetchHelper: {
        local: "discordFetch",
        base: "https://discord.com/api/v10",
        baseConst: "DISCORD_API",
      },
      tools: [
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
      ],
    });
    const out = renderRestKitTools(spec);
    expect(out).toContain("const lim = parsed.limit ?? 50;");
    expect(out).toContain(
      "const u = new URL(`${DISCORD_API}/channels/${encodeURIComponent(parsed.channelId)}/messages`);",
    );
    expect(out).toContain('u.searchParams.set("limit", String(lim));');
    expect(out).toContain('if (parsed.after !== undefined && parsed.after !== "") {');
    expect(out).toContain("return `${u.pathname}${u.search}`;");
  });

  it("leaves a tool with no query on the unchanged path branch", () => {
    const spec = parseSpec({
      name: "discord",
      title: "Discord",
      displayName: "Discord",
      description: "d.",
      serviceLabel: "Discord",
      style: "rest-kit",
      env: [{ vars: ["DISCORD_TOKEN"], local: "token", auth: "bearer" }],
      fetchHelper: { local: "discordFetch", base: "https://discord.com/api/v10" },
      tools: [{ name: "t", description: "T.", path: "/users/@me/guilds" }],
    });
    const out = renderRestKitTools(spec);
    expect(out).not.toContain("new URL(");
    expect(out).toContain('() => "/users/@me/guilds",');
  });

  // The bug this brief exists to prevent: a POST carrying query parameters must still route
  // through the write helper, not silently fall back to a read call because the query
  // branch's call expression was written separately from the method ternary.
  it("routes a non-GET query tool through buildInit with its method, not a bare read", () => {
    const spec = parseSpec({
      name: "discord",
      title: "Discord",
      displayName: "Discord",
      description: "d.",
      serviceLabel: "Discord",
      style: "rest-kit",
      env: [{ vars: ["DISCORD_TOKEN"], local: "token", auth: "bearer" }],
      fetchHelper: { local: "discordFetch", base: "https://discord.com/api/v10" },
      tools: [
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
      ],
    });
    const out = renderRestKitTools(spec);
    expect(out).toContain('({ method: "POST", body: JSON.stringify({ query: parsed.query }) })');
    expect(out).toContain("const u = new URL(");
  });
});
