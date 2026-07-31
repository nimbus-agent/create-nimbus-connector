import { describe, expect, it } from "bun:test";
import { parseSpec } from "../src/spec.ts";
import { validateSpec } from "../src/validate.ts";

function specWith(over: Record<string, unknown>) {
  return parseSpec({
    name: "sentry",
    displayName: "Sentry",
    description: "Sentry connector.",
    serviceLabel: "Sentry",
    style: "hand-rolled",
    env: [{ vars: ["SENTRY_ORG_SLUG"], local: "org", bindings: ["o"], required: true }],
    fetchHelper: { local: "sentryGet", base: "${env.org}", headers: "headers" },
    tools: [],
    ...over,
  });
}

function restKitSpecWith(over: Record<string, unknown>) {
  return parseSpec({
    name: "discord",
    title: "Discord",
    displayName: "Discord",
    description: "Discord connector.",
    serviceLabel: "Discord",
    style: "rest-kit",
    env: [
      // Not "token": that is now a reserved emitter identifier — the client-credentials
      // branch emits `token()` at module scope.
      {
        vars: ["DISCORD_TOKEN"],
        local: "tokenHeaders",
        bindings: ["t"],
        required: true,
        auth: "bearer",
      },
    ],
    fetchHelper: { local: "discordGet", base: "https://discord.com/api/v10" },
    tools: [],
    ...over,
  });
}

describe("validateSpec", () => {
  it("accepts a spec with no collisions", () => {
    expect(() => validateSpec(specWith({}))).not.toThrow();
  });

  it("rejects a hoisted arg local that shadows an env accessor", () => {
    const s = specWith({
      tools: [
        {
          name: "sentry_issue_list",
          description: "List issues.",
          args: { limit: { type: "number", optional: true, default: 20, local: "org" } },
          path: "/projects/${env.org}/issues/",
        },
      ],
    });
    expect(() => validateSpec(s)).toThrow(/org/);
  });

  it("rejects two env accessors with the same local", () => {
    const s = specWith({
      env: [
        { vars: ["A"], local: "dup", bindings: ["a"], required: true },
        { vars: ["B"], local: "dup", bindings: ["b"], required: true },
      ],
    });
    expect(() => validateSpec(s)).toThrow(/dup/);
  });

  it("rejects an env local colliding with a reserved emitter name", () => {
    const s = specWith({ env: [{ vars: ["A"], local: "reg", bindings: ["a"], required: true }] });
    expect(() => validateSpec(s)).toThrow(/reg/);
  });

  it("rejects a fetchHelper local colliding with an env local", () => {
    const s = specWith({ fetchHelper: { local: "org", base: "https://x", headers: "headers" } });
    expect(() => validateSpec(s)).toThrow(/org/);
  });

  it("rejects duplicate tool names", () => {
    const t = { name: "dup_tool", description: "d.", path: "/a" };
    expect(() => validateSpec(specWith({ tools: [t, t] }))).toThrow(/dup_tool/);
  });

  it("rejects a rest-kit spec whose env local collides with the registrar name", () => {
    const s = restKitSpecWith({
      title: "Foo",
      env: [{ vars: ["A"], local: "registerFooTool", bindings: ["a"], auth: "bearer" }],
    });
    expect(() => validateSpec(s)).toThrow(/registerFooTool/);
  });

  it("accepts a hand-rolled spec whose env local matches what rest-kit would claim", () => {
    const s = specWith({
      title: "Foo",
      style: "hand-rolled",
      env: [{ vars: ["A"], local: "registerFooTool", bindings: ["a"], required: true }],
    });
    expect(() => validateSpec(s)).not.toThrow();
  });

  // F2: tool path placeholders must resolve against the spec that declared them.
  it("rejects a rest-kit tool path referencing ${env.X} — rest-kit emits no env accessors", () => {
    const s = restKitSpecWith({
      tools: [
        {
          name: "discord_guild_list",
          description: "d.",
          path: "/guilds/${env.anything}",
        },
      ],
    });
    expect(() => validateSpec(s)).toThrow(/env accessors/);
  });

  it("rejects a hand-rolled tool path referencing an env local the spec never declares", () => {
    const s = specWith({
      tools: [
        {
          name: "sentry_issue_list",
          description: "d.",
          path: "/projects/${env.nosuch}/issues/",
        },
      ],
    });
    expect(() => validateSpec(s)).toThrow(/nosuch/);
  });

  it("rejects a tool path referencing an arg the tool never declares", () => {
    const s = specWith({
      tools: [
        {
          name: "sentry_issue_list",
          description: "d.",
          path: "/projects/${env.org}/${arg.typo}/issues/",
        },
      ],
    });
    expect(() => validateSpec(s)).toThrow(/typo/);
  });

  it("accepts a hand-rolled tool path whose env and arg references both resolve", () => {
    const s = specWith({
      tools: [
        {
          name: "sentry_issue_list",
          description: "d.",
          args: { projectSlug: { type: "string" } },
          path: "/projects/${env.org}/${arg.projectSlug}/issues/",
        },
      ],
    });
    expect(() => validateSpec(s)).not.toThrow();
  });

  it("accepts a rest-kit tool path whose arg references resolve and has no env reference", () => {
    const s = restKitSpecWith({
      tools: [
        {
          name: "discord_channel_list",
          description: "d.",
          args: { guildId: { type: "string" } },
          path: "/guilds/${arg.guildId|enc}/channels",
        },
      ],
    });
    expect(() => validateSpec(s)).not.toThrow();
  });

  // F7: |bool is restricted to boolean-typed args.
  it("rejects a |bool placeholder applied to a non-boolean arg", () => {
    const s = specWith({
      tools: [
        {
          name: "sentry_issue_list",
          description: "d.",
          args: { projectSlug: { type: "string" } },
          path: "/projects/${env.org}/issues/?flag=${arg.projectSlug|bool}",
        },
      ],
    });
    expect(() => validateSpec(s)).toThrow(/"projectSlug".*boolean/s);
  });

  it("accepts a |bool placeholder applied to a boolean arg", () => {
    const s = specWith({
      tools: [
        {
          name: "sentry_issue_list",
          description: "d.",
          args: { onlyOpen: { type: "boolean", optional: true } },
          path: "/projects/${env.org}/issues/?open=${arg.onlyOpen|bool}",
        },
      ],
    });
    expect(() => validateSpec(s)).not.toThrow();
  });

  it("rejects an env local colliding with the reserved global `fetch` (F6)", () => {
    const s = specWith({ env: [{ vars: ["A"], local: "fetch", bindings: ["a"], required: true }] });
    expect(() => validateSpec(s)).toThrow(/fetch/);
  });

  /**
   * Final fix wave, MINOR 1. Stage C introduced three module-scope names — `token`,
   * `cachedToken` and `<fetchHelper.local>Send` — and registered none of them, so a spec
   * could name an env accessor after one and emit two declarations of it.
   */
  describe("Stage C's emitted module-scope names are reserved", () => {
    for (const name of ["token", "cachedToken", "encodeBasicAuthHeader", "URLSearchParams"]) {
      it(`rejects an env local named "${name}"`, () => {
        const s = specWith({
          env: [{ vars: ["A"], local: name, bindings: ["a"], required: true }],
        });
        expect(() => validateSpec(s)).toThrow(new RegExp(`"${name}"`));
      });
    }

    it("rejects an env local colliding with the write helper's derived name", () => {
      // The write helper is `<fetchHelper.local>Send`, so "sentryGetSend" is taken by
      // fetchHelper.local "sentryGet" even though no spec field spells it out.
      const s = specWith({
        env: [{ vars: ["A"], local: "sentryGetSend", bindings: ["a"], required: true }],
      });
      expect(() => validateSpec(s)).toThrow(/sentryGetSend/);
    });

    it("rejects a hoisted arg local colliding with the write helper's derived name", () => {
      const s = specWith({
        tools: [
          {
            name: "sentry_issue_list",
            description: "d.",
            args: {
              limit: { type: "number", optional: true, default: 20, local: "sentryGetSend" },
            },
            path: "/issues/?limit=${arg.limit|num}",
          },
        ],
      });
      expect(() => validateSpec(s)).toThrow(/sentryGetSend/);
    });
  });

  it("correctly strips non-alphanumerics from title in registrar name", () => {
    const s = restKitSpecWith({
      title: "Google Meet",
      env: [{ vars: ["A"], local: "registerGoogleMeetTool", bindings: ["a"], auth: "bearer" }],
    });
    expect(() => validateSpec(s)).toThrow(/registerGoogleMeetTool/);
  });
});
