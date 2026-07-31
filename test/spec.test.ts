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
    expect(s.tools[0]?.impl).toBe("rest");
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

  it("accepts a non-GET method on a tool now that method/effect are in scope", () => {
    // Superseded: "method" was out-of-scope in Stage A/B; Stage C makes it (and "effect") real
    // fields. See test/spec.test.ts's "Stage C tool fields" describe block for the dedicated coverage.
    const ok = {
      ...MINIMAL,
      tools: [{ ...MINIMAL.tools[0], method: "POST", effect: "read" }],
    };
    expect(() => parseSpec(ok)).not.toThrow();
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

  it("rejects impl: get with no path (F5)", () => {
    const bad = {
      ...MINIMAL,
      tools: [{ name: "x", description: "d.", impl: "get" }],
    };
    expect(() => parseSpec(bad)).toThrow(/"path".*"impl"|"impl".*"path"/s);
  });

  it("rejects impl: stub with a path (F5)", () => {
    const bad = {
      ...MINIMAL,
      tools: [{ name: "x", description: "d.", impl: "stub", path: "/x" }],
    };
    expect(() => parseSpec(bad)).toThrow(/"path".*"impl"|"impl".*"path"/s);
  });

  it("accepts impl: stub without a path (F5)", () => {
    const ok = {
      ...MINIMAL,
      tools: [{ name: "x", description: "d.", impl: "stub" }],
    };
    expect(() => parseSpec(ok)).not.toThrow();
  });

  it("accepts impl: get with a path (F5)", () => {
    const ok = {
      ...MINIMAL,
      tools: [{ name: "x", description: "d.", impl: "get", path: "/x" }],
    };
    expect(() => parseSpec(ok)).not.toThrow();
  });

  it("rejects a non-optional string argument declaring default (F12)", () => {
    const bad = {
      ...MINIMAL,
      tools: [{ ...MINIMAL.tools[0], args: { name: { type: "string", default: "hi" } } }],
    };
    expect(() => parseSpec(bad)).toThrow(/optional/);
  });

  it("accepts a string argument declaring default with optional: true (F12)", () => {
    const ok = {
      ...MINIMAL,
      tools: [
        { ...MINIMAL.tools[0], args: { name: { type: "string", optional: true, default: "hi" } } },
      ],
    };
    expect(() => parseSpec(ok)).not.toThrow();
  });

  it("rejects an env local that is not a valid JS identifier (F6)", () => {
    const bad = {
      ...MINIMAL,
      env: [{ vars: ["X"], local: "probe-fetch", bindings: ["x"], required: true }],
    };
    expect(() => parseSpec(bad)).toThrow(/env\.0\.local.*valid JS identifier/s);
  });

  it("rejects an arg local that is not a valid JS identifier (F6)", () => {
    const bad = {
      ...MINIMAL,
      tools: [{ ...MINIMAL.tools[0], args: { limit: { type: "string", local: "probe-fetch" } } }],
    };
    expect(() => parseSpec(bad)).toThrow(/local.*valid JS identifier/s);
  });

  it("rejects a fetchHelper local that is not a valid JS identifier (F6)", () => {
    const bad = {
      ...MINIMAL,
      fetchHelper: { local: "probe-fetch", base: "https://x", headers: "h" },
    };
    expect(() => parseSpec(bad)).toThrow(/fetchHelper\.local.*valid JS identifier/s);
  });

  it("accepts ordinary locals (F6)", () => {
    const ok = {
      ...MINIMAL,
      env: [{ vars: ["X"], local: "apiRoot2", bindings: ["x"], required: true }],
      fetchHelper: { local: "nrGet2", base: "https://api.newrelic.com", headers: "apiRoot2" },
    };
    expect(() => parseSpec(ok)).not.toThrow();
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

  it("rejects a rest-kit spec whose fetchHelper.base references ${env.X}", () => {
    const { style, env, ...rest } = MINIMAL;
    const bad = {
      ...rest,
      style: "rest-kit",
      env: [
        { vars: ["DISCORD_BOT_TOKEN"], local: "tokenHeaders", bindings: ["t"], auth: "bearer" },
      ],
      fetchHelper: { local: "discordFetch", base: "${env.x}" },
    };
    expect(() => parseSpec(bad)).toThrow(/env accessors/);
  });

  it("rejects a rest-kit spec whose fetchHelper.inlineHeaders references ${env.X}", () => {
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
        inlineHeaders: { "X-A": "${env.x}" },
      },
    };
    expect(() => parseSpec(bad)).toThrow(/env accessors/);
  });

  it("accepts a rest-kit spec with a literal base and literal inlineHeaders values", () => {
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

  it("accepts a hand-rolled spec referencing ${env.X} in base and inlineHeaders (sentry/newrelic shape)", () => {
    const ok = {
      ...MINIMAL,
      fetchHelper: {
        local: "nrGet",
        base: "${env.apiRoot}",
        inlineHeaders: { "X-Api-Key": "${env.apiKey}" },
      },
    };
    expect(() => parseSpec(ok)).not.toThrow();
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

const stageCBase = {
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
};
const stageCTool = (o: Record<string, unknown>) => ({
  ...stageCBase,
  tools: [{ name: "zz_a", description: "A.", ...o }],
});

describe("Stage C tool fields", () => {
  it("defaults method to GET and effect to read", () => {
    const s = parseSpec(stageCTool({ path: "/a" }));
    expect(s.tools[0]!.method).toBe("GET");
    expect(s.tools[0]!.effect).toBe("read");
  });

  it("accepts impl 'get' as a deprecated alias for 'rest'", () => {
    // 0.2.2 is published; specs already written must keep working.
    expect(parseSpec(stageCTool({ path: "/a", impl: "get" })).tools[0]!.impl).toBe("rest");
  });

  it("allows POST with effect read — a GraphQL query is not a write", () => {
    const s = parseSpec(stageCTool({ path: "/g", method: "POST", effect: "read" }));
    expect(s.tools[0]!.effect).toBe("read");
  });

  it("rejects a mutating GET", () => {
    expect(() => parseSpec(stageCTool({ path: "/a", effect: "write" }))).toThrow(/GET/);
  });

  it("rejects a body on GET", () => {
    expect(() => parseSpec(stageCTool({ path: "/a", body: { x: "x" } }))).toThrow(/body/i);
  });

  it("rejects method or body on a stub", () => {
    expect(() => parseSpec(stageCTool({ impl: "stub", method: "POST" }))).toThrow(/stub/i);
    expect(() => parseSpec(stageCTool({ impl: "stub", body: { x: "x" } }))).toThrow(/stub/i);
  });

  it("rejects a body key naming an undeclared arg", () => {
    // NOTE: the task brief's literal example here was `body: { api_title: "nope" }` —
    // that can never satisfy /nope/, because the schema's own docstring ("arg name ->
    // API field name") and the brief's own superRefine (which iterates Object.keys(body))
    // both check the KEY against declared args, not the value. "nope" only appears in the
    // error if it is the key. Swapped key/value here so the test matches the implementation
    // both the docstring and the superRefine agree on; see task-1-report.md for detail.
    expect(() =>
      parseSpec(
        stageCTool({
          path: "/a",
          method: "POST",
          args: { title: { type: "string" } },
          body: { nope: "api_title" },
        }),
      ),
    ).toThrow(/nope/);
  });

  it("allows DELETE with effect write", () => {
    // Deleting a webhook subscription is not destructive to user data.
    expect(
      parseSpec(stageCTool({ path: "/a", method: "DELETE", effect: "write" })).tools[0]!.effect,
    ).toBe("write");
  });
});
