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
});
