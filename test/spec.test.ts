import { describe, expect, it } from "bun:test";
import { parseSpec } from "../src/spec.ts";

const MINIMAL = {
  name: "newrelic",
  displayName: "New Relic",
  description: "New Relic connector.",
  serviceLabel: "New Relic",
  style: "hand-rolled",
  network: ["api.newrelic.com"],
  env: [{ vars: ["NEW_RELIC_API_KEY"], local: "apiKey", bindings: ["k"], required: true }],
  fetchHelper: {
    local: "nrGet",
    base: "https://api.newrelic.com",
    inlineHeaders: { "X-Api-Key": "${env.apiKey}", Accept: "application/json" },
  },
  tools: [
    {
      name: "newrelic_application_list",
      description: "List APM applications.",
      path: "/v2/applications.json",
    },
  ],
};

describe("parseSpec", () => {
  it("applies derived defaults", () => {
    const s = parseSpec(MINIMAL);
    expect(s.title).toBe("Newrelic");
    expect(s.id).toBe("com.nimbus.newrelic");
    expect(s.syncInterval).toBe(300);
    expect(s.minNimbusVersion).toBe("0.2.0");
    expect(s.tools[0]?.impl).toBe("get");
  });

  it("defaults style to rest-kit when omitted", () => {
    const { style, env, ...rest } = MINIMAL;
    const ok = {
      ...rest,
      env: [
        { vars: ["DISCORD_BOT_TOKEN"], local: "tokenHeaders", bindings: ["t"], auth: "bearer" },
      ],
      fetchHelper: { local: "discordFetch", base: "https://discord.com/api/v10" },
    };
    expect(parseSpec(ok).style).toBe("rest-kit");
  });

  it("rejects an unknown top-level key", () => {
    expect(() => parseSpec({ ...MINIMAL, oauth: true })).toThrow(/oauth/);
  });

  it("rejects a non-GET method on a tool as out of scope", () => {
    const bad = { ...MINIMAL, tools: [{ ...MINIMAL.tools[0], method: "POST" }] };
    expect(() => parseSpec(bad)).toThrow(/method.*Stage A/s);
  });

  it("rejects an env entry declaring both default and required", () => {
    const bad = {
      ...MINIMAL,
      env: [{ vars: ["X"], local: "x", bindings: ["x"], required: true, default: "d" }],
    };
    expect(() => parseSpec(bad)).toThrow(/both .*default.* and .*required/i);
  });

  it("accepts an env entry declaring default without required", () => {
    const ok = {
      ...MINIMAL,
      env: [{ vars: ["X"], local: "x", bindings: ["x"], default: "d" }],
    };
    expect(() => parseSpec(ok)).not.toThrow();
  });

  it("rejects bindings whose length does not match vars", () => {
    const bad = { ...MINIMAL, env: [{ vars: ["A", "B"], local: "h", bindings: ["a"] }] };
    expect(() => parseSpec(bad)).toThrow(/bindings/);
  });

  it("accepts headerNames matching vars length when auth is headers", () => {
    const ok = {
      ...MINIMAL,
      env: [
        {
          vars: ["DD_API_KEY", "DD_APP_KEY"],
          local: "dd",
          bindings: ["ak", "app"],
          auth: "headers",
          headerNames: ["DD-API-KEY", "DD-APPLICATION-KEY"],
        },
      ],
    };
    expect(() => parseSpec(ok)).not.toThrow();
  });

  it("rejects headerNames whose length does not match vars when auth is headers", () => {
    const bad = {
      ...MINIMAL,
      env: [
        {
          vars: ["DD_API_KEY", "DD_APP_KEY"],
          local: "dd",
          bindings: ["ak", "app"],
          auth: "headers",
          headerNames: ["DD-API-KEY"],
        },
      ],
    };
    expect(() => parseSpec(bad)).toThrow(/headerNames/);
  });

  it("rejects auth: headers with headerNames entirely absent", () => {
    const bad = {
      ...MINIMAL,
      env: [
        {
          vars: ["DD_API_KEY", "DD_APP_KEY"],
          local: "dd",
          bindings: ["ak", "app"],
          auth: "headers",
        },
      ],
    };
    expect(() => parseSpec(bad)).toThrow(/headerNames/);
  });

  it("rejects an argument name that is not a valid JS identifier (hyphenated)", () => {
    const bad = {
      ...MINIMAL,
      tools: [{ ...MINIMAL.tools[0], args: { "per-page": { type: "string" } } }],
    };
    expect(() => parseSpec(bad)).toThrow(/per-page/);
  });

  it("accepts valid argument names like camelCase and underscore prefixed", () => {
    const ok = {
      ...MINIMAL,
      tools: [
        { ...MINIMAL.tools[0], args: { perPage: { type: "string" }, _x: { type: "string" } } },
      ],
    };
    expect(() => parseSpec(ok)).not.toThrow();
  });

  it("rejects a boolean argument with a default value", () => {
    const bad = {
      ...MINIMAL,
      tools: [{ ...MINIMAL.tools[0], args: { flag: { type: "boolean", default: true } } }],
    };
    expect(() => parseSpec(bad)).toThrow(/default/);
  });

  it("accepts a boolean argument without a default (optional only)", () => {
    const ok = {
      ...MINIMAL,
      tools: [{ ...MINIMAL.tools[0], args: { only_open: { type: "boolean", optional: true } } }],
    };
    expect(() => parseSpec(ok)).not.toThrow();
  });

  it("rejects a boolean argument with min", () => {
    const bad = {
      ...MINIMAL,
      tools: [{ ...MINIMAL.tools[0], args: { flag: { type: "boolean", min: 1 } } }],
    };
    expect(() => parseSpec(bad)).toThrow(/"min"\/"max"/);
  });

  it("accepts string argument with min and max", () => {
    const ok = {
      ...MINIMAL,
      tools: [{ ...MINIMAL.tools[0], args: { name: { type: "string", min: 1, max: 10 } } }],
    };
    expect(() => parseSpec(ok)).not.toThrow();
  });

  it("rejects a string argument with int flag", () => {
    const bad = {
      ...MINIMAL,
      tools: [{ ...MINIMAL.tools[0], args: { name: { type: "string", int: true } } }],
    };
    expect(() => parseSpec(bad)).toThrow(/"int"/);
  });

  it("rejects a mixed args object and names the specific invalid key", () => {
    const bad = {
      ...MINIMAL,
      tools: [
        {
          ...MINIMAL.tools[0],
          args: {
            perPage: { type: "string" },
            _x: { type: "string" },
            "per-page": { type: "string" },
          },
        },
      ],
    };
    try {
      parseSpec(bad);
      expect(true).toBe(false); // Should not reach here
    } catch (e) {
      const msg = (e as Error).message;
      expect(msg).toContain("per-page");
    }
  });

  it("rejects auth: bearer with prefix", () => {
    const bad = {
      ...MINIMAL,
      env: [{ vars: ["X"], local: "tok", bindings: ["t"], auth: "bearer", prefix: "tok_" }],
    };
    expect(() => parseSpec(bad)).toThrow(/auth/);
  });

  it("rejects auth: bearer with transform", () => {
    const bad = {
      ...MINIMAL,
      env: [
        {
          vars: ["X"],
          local: "tok",
          bindings: ["t"],
          auth: "bearer",
          transform: "stripTrailingSlash",
        },
      ],
    };
    expect(() => parseSpec(bad)).toThrow(/auth/);
  });

  it("rejects auth: headers with suffix", () => {
    const bad = {
      ...MINIMAL,
      env: [
        {
          vars: ["X"],
          local: "h",
          bindings: ["x"],
          auth: "headers",
          headerNames: ["X-Header"],
          suffix: "/end",
        },
      ],
    };
    expect(() => parseSpec(bad)).toThrow(/auth/);
  });

  it("accepts auth: bearer with no transform/prefix/suffix", () => {
    const ok = {
      ...MINIMAL,
      env: [{ vars: ["SENTRY_AUTH_TOKEN"], local: "headers", bindings: ["t"], auth: "bearer" }],
    };
    expect(() => parseSpec(ok)).not.toThrow();
  });

  it("accepts two vars with auth: headers", () => {
    const ok = {
      ...MINIMAL,
      env: [
        {
          vars: ["DD_API_KEY", "DD_APP_KEY"],
          local: "headers",
          bindings: ["ak", "app"],
          auth: "headers",
          headerNames: ["DD-API-KEY", "DD-APPLICATION-KEY"],
        },
      ],
    };
    expect(() => parseSpec(ok)).not.toThrow();
  });

  it("rejects two vars with auth: bearer", () => {
    const bad = {
      ...MINIMAL,
      env: [{ vars: ["A", "B"], local: "foo", bindings: ["a", "b"], auth: "bearer" }],
    };
    expect(() => parseSpec(bad)).toThrow(/multiple/);
  });

  it("rejects two vars with no auth", () => {
    const bad = {
      ...MINIMAL,
      env: [{ vars: ["A", "B"], local: "foo", bindings: ["a", "b"], required: true }],
    };
    expect(() => parseSpec(bad)).toThrow(/multiple/);
  });

  it("rejects a hand-rolled spec whose fetchHelper declares both headers and inlineHeaders", () => {
    const bad = {
      ...MINIMAL,
      fetchHelper: {
        local: "nrGet",
        base: "https://api.newrelic.com",
        headers: "headers",
        inlineHeaders: { "X-Api-Key": "${env.apiKey}" },
      },
    };
    expect(() => parseSpec(bad)).toThrow(/exactly one of/);
  });

  it("rejects a hand-rolled spec whose fetchHelper declares neither headers nor inlineHeaders", () => {
    const bad = {
      ...MINIMAL,
      fetchHelper: { local: "nrGet", base: "https://api.newrelic.com" },
    };
    expect(() => parseSpec(bad)).toThrow(/exactly one of/);
  });

  it("accepts a hand-rolled spec whose fetchHelper declares only headers", () => {
    const ok = {
      ...MINIMAL,
      fetchHelper: { local: "sentryGet", base: "${env.apiRoot}", headers: "headers" },
    };
    expect(() => parseSpec(ok)).not.toThrow();
  });

  it("accepts a hand-rolled spec whose fetchHelper declares only inlineHeaders (newrelic shape)", () => {
    expect(() => parseSpec(MINIMAL)).not.toThrow();
  });

  it("accepts a rest-kit spec whose fetchHelper declares neither headers nor inlineHeaders", () => {
    const { style, env, ...rest } = MINIMAL;
    const ok = {
      ...rest,
      style: "rest-kit",
      env: [
        { vars: ["DISCORD_BOT_TOKEN"], local: "tokenHeaders", bindings: ["t"], auth: "bearer" },
      ],
      fetchHelper: { local: "discordFetch", base: "https://discord.com/api/v10" },
    };
    expect(() => parseSpec(ok)).not.toThrow();
  });

  it("rejects a rest-kit spec whose fetchHelper declares headers (hand-rolled-only field)", () => {
    const { style, env, ...rest } = MINIMAL;
    const bad = {
      ...rest,
      style: "rest-kit",
      env: [
        { vars: ["DISCORD_BOT_TOKEN"], local: "tokenHeaders", bindings: ["t"], auth: "bearer" },
      ],
      fetchHelper: { local: "discordFetch", base: "https://discord.com/api/v10", headers: "h" },
    };
    expect(() => parseSpec(bad)).toThrow(/hand-rolled/);
  });

  it("rejects a rest-kit spec whose fetchHelper sets normalizeLeadingSlash: true", () => {
    const { style, env, ...rest } = MINIMAL;
    const bad = {
      ...rest,
      style: "rest-kit",
      env: [
        { vars: ["DISCORD_BOT_TOKEN"], local: "tokenHeaders", bindings: ["t"], auth: "bearer" },
      ],
      fetchHelper: {
        local: "discordFetch",
        base: "https://discord.com/api/v10",
        normalizeLeadingSlash: true,
      },
    };
    expect(() => parseSpec(bad)).toThrow(/hand-rolled/);
  });

  it("rejects a rest-kit spec whose fetchHelper sets jsonFallbackRaw: true", () => {
    const { style, env, ...rest } = MINIMAL;
    const bad = {
      ...rest,
      style: "rest-kit",
      env: [
        { vars: ["DISCORD_BOT_TOKEN"], local: "tokenHeaders", bindings: ["t"], auth: "bearer" },
      ],
      fetchHelper: {
        local: "discordFetch",
        base: "https://discord.com/api/v10",
        jsonFallbackRaw: true,
      },
    };
    expect(() => parseSpec(bad)).toThrow(/hand-rolled/);
  });

  it("accepts a rest-kit spec whose fetchHelper declares only inlineHeaders", () => {
    const { style, env, ...rest } = MINIMAL;
    const ok = {
      ...rest,
      style: "rest-kit",
      env: [
        { vars: ["DISCORD_BOT_TOKEN"], local: "tokenHeaders", bindings: ["t"], auth: "bearer" },
      ],
      fetchHelper: {
        local: "discordFetch",
        base: "https://discord.com/api/v10",
        inlineHeaders: { "X-Extra": "yes" },
      },
    };
    expect(() => parseSpec(ok)).not.toThrow();
  });

  it("accepts a hand-rolled spec with normalizeLeadingSlash and jsonFallbackRaw both true (grafana shape)", () => {
    const ok = {
      ...MINIMAL,
      fetchHelper: {
        local: "grafanaGet",
        base: "${env.baseUrl}",
        headers: "authHeaders",
        normalizeLeadingSlash: true,
        jsonFallbackRaw: true,
      },
    };
    expect(() => parseSpec(ok)).not.toThrow();
  });

  it("accepts one var with transform and suffix and no auth", () => {
    const ok = {
      ...MINIMAL,
      env: [
        {
          vars: ["SENTRY_URL"],
          local: "apiRoot",
          bindings: ["u"],
          default: "https://sentry.io",
          transform: "stripTrailingSlash",
          suffix: "/api/0",
        },
      ],
    };
    expect(() => parseSpec(ok)).not.toThrow();
  });

  // rest-kit specific env validation
  it("accepts rest-kit with exactly one auth: bearer single-var entry (discord shape)", () => {
    const ok = {
      ...MINIMAL,
      style: "rest-kit",
      env: [
        { vars: ["DISCORD_BOT_TOKEN"], local: "tokenHeaders", bindings: ["t"], auth: "bearer" },
      ],
      fetchHelper: { local: "discordFetch", base: "https://discord.com/api/v10" },
    };
    expect(() => parseSpec(ok)).not.toThrow();
  });

  it("rejects rest-kit with two env entries, one auth bearer and one plain", () => {
    const bad = {
      ...MINIMAL,
      style: "rest-kit",
      env: [
        { vars: ["DISCORD_BOT_TOKEN"], local: "tokenHeaders", bindings: ["t"], auth: "bearer" },
        { vars: ["CONFIG_VAR"], local: "config", bindings: ["c"] },
      ],
      fetchHelper: { local: "discordFetch", base: "https://discord.com/api/v10" },
    };
    expect(() => parseSpec(bad)).toThrow(/exactly one env entry/);
  });

  it("rejects rest-kit with two env entries both declaring auth", () => {
    const bad = {
      ...MINIMAL,
      style: "rest-kit",
      env: [
        { vars: ["TOKEN_1"], local: "h1", bindings: ["t1"], auth: "bearer" },
        { vars: ["TOKEN_2"], local: "h2", bindings: ["t2"], auth: "bearer" },
      ],
      fetchHelper: { local: "discordFetch", base: "https://discord.com/api/v10" },
    };
    expect(() => parseSpec(bad)).toThrow(/exactly one env entry/);
  });

  it("rejects rest-kit with one auth: headers entry", () => {
    const bad = {
      ...MINIMAL,
      style: "rest-kit",
      env: [
        {
          vars: ["API_KEY"],
          local: "headers",
          bindings: ["k"],
          auth: "headers",
          headerNames: ["X-API-Key"],
        },
      ],
      fetchHelper: { local: "discordFetch", base: "https://discord.com/api/v10" },
    };
    expect(() => parseSpec(bad)).toThrow(/exactly one env entry/);
  });

  it("rejects rest-kit with one auth: bearer entry having two vars", () => {
    const bad = {
      ...MINIMAL,
      style: "rest-kit",
      env: [
        {
          vars: ["TOKEN_A", "TOKEN_B"],
          local: "tokens",
          bindings: ["a", "b"],
          auth: "bearer",
        },
      ],
      fetchHelper: { local: "discordFetch", base: "https://discord.com/api/v10" },
    };
    expect(() => parseSpec(bad)).toThrow(/exactly one env entry/);
  });

  it("rejects rest-kit with zero env entries", () => {
    const bad = {
      ...MINIMAL,
      style: "rest-kit",
      env: [],
      fetchHelper: { local: "discordFetch", base: "https://discord.com/api/v10" },
    };
    expect(() => parseSpec(bad)).toThrow(/exactly one env entry/);
  });

  it("accepts hand-rolled with three env entries, mixed auth and non-auth (sentry shape)", () => {
    const ok = {
      ...MINIMAL,
      env: [
        { vars: ["SENTRY_URL"], local: "apiRoot", bindings: ["u"], default: "https://sentry.io" },
        { vars: ["SENTRY_ORG"], local: "org", bindings: ["o"], required: true },
        {
          vars: ["SENTRY_AUTH_TOKEN"],
          local: "headers",
          bindings: ["t"],
          auth: "bearer",
        },
      ],
      fetchHelper: { local: "sentryGet", base: "${env.apiRoot}", headers: "headers" },
    };
    expect(() => parseSpec(ok)).not.toThrow();
  });
});
