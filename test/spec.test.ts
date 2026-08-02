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
    // `x` IS declared, so the undeclared-arg rule cannot fire — the GET+body rule is the
    // only one left that can reject this. The previous version (`body: { x: "x" }` with no
    // declared args, asserting the bare word "body") passed for the wrong reason: the
    // undeclared-arg rule fired instead and its message merely contains "body" too. Mutation
    // testing (deleting the GET+body refine) proved the old test could not fail.
    expect(() =>
      parseSpec(stageCTool({ path: "/a", args: { x: { type: "string" } }, body: { x: "api_x" } })),
    ).toThrow(/non-GET/);
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

/**
 * Final fix wave, IMPORTANT 4. These five refines had zero coverage: replacing any of them
 * with `.refine((_e) => true)` left 374 tests passing. Two of them are load-bearing beyond
 * schema tidiness — `env.ts:87` does `e.credentialsIn!` and `env.ts:121` does
 * `JSON.stringify(e.tokenUrl)`, so without them a spec omitting either emits
 * `const res = await fetch(undefined, {...})`. One test per refine, each written so that
 * only its own refine can produce the asserted message.
 */
const ccEnvSpec = (mutate: (e: Record<string, unknown>) => void) => {
  const e: Record<string, unknown> = {
    vars: ["ZZ_CLIENT_ID", "ZZ_CLIENT_SECRET"],
    local: "headers",
    bindings: ["id", "secret"],
    auth: "client-credentials",
    tokenUrl: "https://api.zz.test/oauth/token",
    credentialsIn: "basic",
  };
  mutate(e);
  return { ...stageCBase, env: [e], tools: [{ name: "zz_a", description: "A.", path: "/a" }] };
};

/** Reduce the entry to a plain single-var bearer, leaving only the field under test behind. */
const asBearer = (e: Record<string, unknown>) => {
  e.auth = "bearer";
  e.vars = ["ZZ_TOKEN"];
  e.bindings = ["t"];
};

describe("client-credentials env validation", () => {
  it("accepts a complete client-credentials entry", () => {
    expect(() => parseSpec(ccEnvSpec(() => {}))).not.toThrow();
  });

  it('requires "tokenUrl" — without it the emitted token exchange is fetch(undefined, ...)', () => {
    expect(() =>
      parseSpec(
        ccEnvSpec((e) => {
          delete e.tokenUrl;
        }),
      ),
    ).toThrow(/"tokenUrl" is required/);
  });

  it('requires "credentialsIn" — env.ts dereferences it with a non-null assertion', () => {
    expect(() =>
      parseSpec(
        ccEnvSpec((e) => {
          delete e.credentialsIn;
        }),
      ),
    ).toThrow(/"credentialsIn" is required/);
  });

  it('rejects "tokenUrl" on a non-client-credentials entry', () => {
    expect(() =>
      parseSpec(
        ccEnvSpec((e) => {
          asBearer(e);
          delete e.credentialsIn;
        }),
      ),
    ).toThrow(/"tokenUrl" is only valid/);
  });

  it('rejects "scope" on a non-client-credentials entry', () => {
    expect(() =>
      parseSpec(
        ccEnvSpec((e) => {
          asBearer(e);
          delete e.tokenUrl;
          delete e.credentialsIn;
          e.scope = "items:read";
        }),
      ),
    ).toThrow(/"scope" is only valid/);
  });

  it('rejects "credentialsIn" on a non-client-credentials entry', () => {
    expect(() =>
      parseSpec(
        ccEnvSpec((e) => {
          asBearer(e);
          delete e.tokenUrl;
        }),
      ),
    ).toThrow(/"credentialsIn" is only valid/);
  });
});

describe("at most one client-credentials env entry", () => {
  const twoCc = {
    ...stageCBase,
    env: [
      {
        vars: ["ZZ_A_ID", "ZZ_A_SECRET"],
        local: "headers",
        bindings: ["aId", "aSecret"],
        auth: "client-credentials",
        tokenUrl: "https://api.zz.test/oauth/a",
        credentialsIn: "basic",
      },
      {
        vars: ["ZZ_B_ID", "ZZ_B_SECRET"],
        local: "otherHeaders",
        bindings: ["bId", "bSecret"],
        auth: "client-credentials",
        tokenUrl: "https://api.zz.test/oauth/b",
        credentialsIn: "body",
      },
    ],
    tools: [{ name: "zz_a", description: "A.", path: "/a" }],
  };

  it("rejects a second entry — both would emit `token` and `cachedToken` at module scope", () => {
    expect(() => parseSpec(twoCc)).toThrow(/at most one env entry with auth: "client-credentials"/);
  });

  it("accepts one client-credentials entry alongside other auth kinds", () => {
    expect(() =>
      parseSpec({
        ...twoCc,
        env: [
          twoCc.env[0]!,
          { vars: ["ZZ_SITE"], local: "siteHost", bindings: ["s"], default: "zz.test" },
        ],
      }),
    ).not.toThrow();
  });
});

/**
 * Final fix wave, MINOR 3. `preflightOutOfScope` runs before Zod so a known-future key gets
 * a targeted message rather than Zod's generic "unrecognized key". Task 1 rewrote its only
 * test into an accept-test for `effect`, leaving the sole remaining key with zero coverage —
 * and with a message that had gone stale ("a later Stage C task", written on the Stage C
 * branch, which did not add it).
 */
describe("preflightOutOfScope", () => {
  it('rejects a tool declaring "hitl" and points at "effect" instead', () => {
    const bad = stageCTool({ path: "/a", hitl: true });
    expect(() => parseSpec(bad)).toThrow(/"hitl" is not a supported tool field/);
    expect(() => parseSpec(bad)).toThrow(/"effect"/);
    // The stale promise is gone: Stage C shipped and did not add per-tool HITL.
    expect(() => parseSpec(bad)).not.toThrow(/Stage [ABC]/);
  });

  it("fires before Zod, so the message is the targeted one and not 'unrecognized key'", () => {
    // Two problems at once: an out-of-scope key AND a genuinely invalid field. The preflight
    // message is what surfaces, which is the whole reason it runs first.
    expect(() => parseSpec(stageCTool({ path: "/a", hitl: true, method: "TRACE" }))).toThrow(
      /"hitl" is not a supported tool field/,
    );
  });

  it("ignores a non-array tools value rather than throwing on it — Zod reports that", () => {
    expect(() => parseSpec({ ...stageCBase, tools: "nope" })).toThrow(/Invalid connector spec/);
  });
});

describe("style: read-only-kit", () => {
  it("is accepted and inherits the hand-rolled fetchHelper rule", () => {
    const spec = parseSpec({
      name: "mercury",
      displayName: "Mercury",
      description: "d.",
      serviceLabel: "Mercury",
      style: "read-only-kit",
      fetchHelper: {
        local: "mercuryGet",
        base: "https://api.mercury.com",
        inlineHeaders: { Accept: "application/json" },
      },
      tools: [],
    });
    expect(spec.style).toBe("read-only-kit");
  });

  it("rejects a read-only-kit spec declaring neither headers nor inlineHeaders", () => {
    expect(() =>
      parseSpec({
        name: "mercury",
        displayName: "Mercury",
        description: "d.",
        serviceLabel: "Mercury",
        style: "read-only-kit",
        fetchHelper: { local: "mercuryGet", base: "https://api.mercury.com" },
        tools: [],
      }),
    ).toThrow(/exactly one of fetchHelper.headers or fetchHelper.inlineHeaders/);
  });
});

describe("impl: search", () => {
  function tool(extra: Record<string, unknown> = {}) {
    return {
      name: "mercury_search",
      description: "Search accounts.",
      impl: "search",
      path: "/api/v1/accounts",
      filter: { export: "filterMercuryAccounts", fields: ["id", "name"] },
      ...extra,
    };
  }
  function make(t: unknown, style = "read-only-kit") {
    return parseSpec({
      name: "mercury",
      displayName: "Mercury",
      description: "d.",
      serviceLabel: "Mercury",
      style,
      fetchHelper: {
        local: "mercuryGet",
        base: "https://api.mercury.com",
        inlineHeaders: { Accept: "application/json" },
      },
      tools: [t],
    });
  }

  it("defaults maxLimit to 100 and tags to false", () => {
    const t = make(tool()).tools[0]!;
    expect(t.maxLimit).toBe(100);
    expect(t.filter?.tags).toBe(false);
  });

  it("accepts rows and a custom maxLimit", () => {
    const t = make(tool({ rows: "accounts", maxLimit: 2000 })).tools[0]!;
    expect(t.rows).toBe("accounts");
    expect(t.maxLimit).toBe(2000);
  });

  it("requires a filter", () => {
    expect(() => make({ ...tool(), filter: undefined })).toThrow(/"filter" is required/);
  });

  it("rejects an empty fields list", () => {
    expect(() => make(tool({ filter: { export: "f", fields: [] } }))).toThrow(/at least one field/);
  });

  it("rejects method and body", () => {
    expect(() => make(tool({ method: "POST" }))).toThrow(/issues a GET/);
    expect(() => make(tool({ body: { a: "b" } }))).toThrow(/issues a GET/);
  });

  it("rejects a non-read effect", () => {
    expect(() => make(tool({ effect: "write" }))).toThrow(/cannot mutate/);
  });

  it("rejects a non-identifier filter.export", () => {
    expect(() => make(tool({ filter: { export: "not a name", fields: ["id"] } }))).toThrow(
      /must be a valid JS identifier/,
    );
  });

  it("accepts an ordinary GET tool that never mentions maxLimit", () => {
    const t = make({
      name: "mercury_get_account",
      description: "Get an account.",
      impl: "rest",
      path: "/api/v1/accounts/:id",
    }).tools[0]!;
    expect(t.maxLimit).toBe(100);
    expect(t.rows).toBeUndefined();
  });

  it("rejects rows/maxLimit on a non-search tool", () => {
    expect(() =>
      make({
        name: "mercury_get_account",
        description: "Get an account.",
        impl: "rest",
        path: "/api/v1/accounts/:id",
        maxLimit: 50,
      }),
    ).toThrow(/"rows" and "maxLimit" are only valid on a tool with "impl": "search"/);
  });
});

describe("search and style interaction", () => {
  const searchTool = {
    name: "s_search",
    description: "Search.",
    impl: "search",
    path: "/items",
    filter: { export: "filterItems", fields: ["id"] },
  };

  it("rejects a search tool on style rest-kit", () => {
    expect(() =>
      parseSpec({
        name: "s",
        displayName: "S",
        description: "d.",
        serviceLabel: "S",
        style: "rest-kit",
        env: [{ vars: ["S_TOKEN"], local: "token", auth: "bearer" }],
        fetchHelper: { local: "sGet", base: "https://api.s.com" },
        tools: [searchTool],
      }),
    ).toThrow(/no seam/);
  });

  it("rejects two tools sharing one filter.export", () => {
    expect(() =>
      parseSpec({
        name: "s",
        displayName: "S",
        description: "d.",
        serviceLabel: "S",
        style: "read-only-kit",
        fetchHelper: {
          local: "sGet",
          base: "https://api.s.com",
          inlineHeaders: { Accept: "application/json" },
        },
        tools: [searchTool, { ...searchTool, name: "s_search_two", path: "/others" }],
      }),
    ).toThrow(/filterItems/);
  });
});

describe("SearchFilterSchema field entries", () => {
  const withFilter = (filter: unknown) =>
    parseSpec({
      name: "mercury",
      title: "Mercury",
      displayName: "Mercury",
      description: "d.",
      serviceLabel: "Mercury",
      style: "read-only-kit",
      fetchHelper: {
        local: "mercuryGet",
        base: "https://api.mercury.com",
        inlineHeaders: { Accept: "application/json" },
      },
      tools: [{ name: "s", description: "S.", impl: "search", path: "/v1/x", filter }],
    });

  it("accepts a plain key, a path entry and a tag entry together", () => {
    const spec = withFilter({
      export: "filterX",
      fields: ["name", { path: ["spec", "source", "repoURL"] }, { tags: "objects" }],
    });
    expect(spec.tools[0]!.filter!.fields).toEqual([
      "name",
      { path: ["spec", "source", "repoURL"] },
      { tags: "objects" },
    ]);
  });

  it("rejects a single-segment path and names the plain-string spelling", () => {
    expect(() => withFilter({ export: "filterX", fields: [{ path: ["name"] }] })).toThrow(/"name"/);
  });

  it("rejects an empty path segment", () => {
    expect(() => withFilter({ export: "filterX", fields: [{ path: ["spec", ""] }] })).toThrow();
  });

  it("accepts a whitespace-only path segment, which is a legal JSON key", () => {
    const spec = withFilter({ export: "filterX", fields: [{ path: ["spec", " "] }] });
    expect(spec.tools[0]!.filter!.fields).toEqual([{ path: ["spec", " "] }]);
  });

  it("rejects an unknown key inside an entry object", () => {
    expect(() =>
      withFilter({ export: "filterX", fields: [{ path: ["a", "b"], tag: "objects" }] }),
    ).toThrow();
  });

  it("rejects an unknown tag format", () => {
    expect(() => withFilter({ export: "filterX", fields: [{ tags: "nope" }] })).toThrow();
  });

  it("rejects legacy tags:true alongside a tag entry, naming both", () => {
    expect(() =>
      withFilter({ export: "filterX", fields: ["name", { tags: "text" }], tags: true }),
    ).toThrow(/tags/);
  });

  it('reports a malformed entry with the three legal shapes, not "Invalid input"', () => {
    // Verified against zod 4.4.2: an untagged union reports ONE issue, not one per branch,
    // and its default message is the useless "Invalid input". The custom error is what makes
    // the failure actionable.
    expect(() => withFilter({ export: "filterX", fields: [{ pat: ["a", "b"] }] })).toThrow(
      /a field entry must be a key string/,
    );
  });

  it("still accepts the flat 0.4.0 shape unchanged", () => {
    const spec = withFilter({ export: "filterX", fields: ["id", "name"], tags: true });
    expect(spec.tools[0]!.filter!.fields).toEqual(["id", "name"]);
    expect(spec.tools[0]!.filter!.tags).toBe(true);
  });

  /**
   * Fix round 1, CRITICAL 2: extractorFilter reads only "fields" and never consults "tags", so
   * legacy "tags": true silently vanishes when a filter's entries force the extractor branch —
   * the connector compiles and passes every gate while silently failing to match on tags.
   * Rejected here rather than appended silently, symmetric with the existing
   * tags-alongside-a-tags-entry rejection above.
   */
  it('rejects legacy "tags": true on a filter forced onto the extractor branch by a path entry', () => {
    expect(() =>
      withFilter({
        export: "filterX",
        fields: ["id", { path: ["spec", "source", "repoURL"] }],
        tags: true,
      }),
    ).toThrow(/"tags": true.*extractor|extractor.*"tags"/s);
  });

  it("names the replacement spelling in the rejection message", () => {
    expect(() =>
      withFilter({
        export: "filterX",
        fields: ["id", { path: ["spec", "source", "repoURL"] }],
        tags: true,
      }),
    ).toThrow(/\{ "tags": "text" \}/);
  });

  it('accepts a trailing { "tags": "text" } entry with no legacy "tags": true — the converging form', () => {
    expect(() =>
      withFilter({
        export: "filterX",
        fields: ["id", { path: ["spec", "source", "repoURL"] }, { tags: "text" }],
      }),
    ).not.toThrow();
  });

  it('accepts legacy "tags": true on a filter that stays on the keyed branch', () => {
    expect(() =>
      withFilter({ export: "filterX", fields: ["id", "name"], tags: true }),
    ).not.toThrow();
  });
});
