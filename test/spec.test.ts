import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { PARTIAL_MARKER } from "../src/derive/from-connector.ts";
import { baseExpr } from "../src/emit/server/fetch-helper.ts";
import { type ConnectorSpec, parseSpec } from "../src/spec.ts";

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

  it("rejects --from-connector --partial's draft marker specifically, not a missing field", () => {
    // MINIMAL alone already parses (see "applies derived defaults" above), so every OTHER
    // required field is present here too — a throw can only be the strict-object rejection of
    // PARTIAL_MARKER itself, not some unrelated missing field masking it. That distinction is
    // the whole point of the marker being the mechanism: see src/derive/from-connector.ts.
    // toThrow(string) is substring containment, not a pattern — so the marker is matched
    // literally and needs no regex escaping. The escaped-RegExp form this replaced used
    // `.replace("$", "\\$")`, which escapes only the FIRST "$"; correct for today's one-dollar
    // marker and silently wrong the day it gains a second. CodeQL flagged it (js/incomplete-
    // sanitization) on PR #62.
    const draft = { ...MINIMAL, [PARTIAL_MARKER]: { note: "x", blockers: ["stub"] } };
    expect(() => parseSpec(draft)).toThrow(PARTIAL_MARKER);
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
    expect(() => parseSpec(bad)).toThrow(/env\[0\]\.local.*valid JS identifier/s);
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

  it("points at the JSON path with bracketed indices, so an array position is distinguishable from a key", () => {
    const bad = {
      ...MINIMAL,
      tools: [{ ...MINIMAL.tools[0], args: { limit: { type: "number", max: "ten" } } }],
    };
    // ANCHORED, and the anchor is half the assertion. `/tools\[0\]\.args\.limit/` on its own
    // matches ".tools[0].args.limit" just as happily — which is what formatIssuePath emits with
    // its first-segment branch removed, and why that mutation left the whole suite green.
    // `^ {2}` pins the two-space indent the line genuinely starts with, so a leading dot fails.
    expect(() => parseSpec(bad)).toThrow(/^ {2}tools\[0\]\.args\.limit\.max: /m);
  });

  it("reports every issue, not just the first", () => {
    // Two independent bad values in unrelated subtrees — an invalid env local and an invalid
    // arg bound — so this can only pass if parseSpec keeps collecting after the first failure.
    const bad = {
      ...MINIMAL,
      env: [{ vars: ["X"], local: "probe-fetch", bindings: ["x"], required: true }],
      tools: [{ ...MINIMAL.tools[0], args: { limit: { type: "number", max: "ten" } } }],
    };
    let message = "";
    try {
      parseSpec(bad);
      expect(true).toBe(false); // Should not reach here
    } catch (e) {
      message = (e as Error).message;
    }
    // Anchored for the same reason as the test above: an unanchored match cannot tell
    // "env[0].local" from ".env[0].local".
    expect(message).toMatch(/^ {2}env\[0\]\.local: /m);
    expect(message).toMatch(/^ {2}tools\[0\]\.args\.limit\.max: /m);
  });

  it("names the root for a top-level issue rather than printing an empty path", () => {
    // ConnectorSpecSchema's own .refine (not a per-field one) fires here — the schema's
    // "exactly one env entry" rule on a rest-kit spec with zero env entries — so its issue has
    // no path segments at all, not merely a short one.
    const bad = {
      ...MINIMAL,
      style: "rest-kit",
      env: [],
      fetchHelper: { local: "discordFetch", base: "https://discord.com/api/v10" },
    };
    expect(() => parseSpec(bad)).toThrow(/\(root\)/);
  });

  it("includes the received value, so a reader sees what was rejected and not only where", () => {
    const bad = {
      ...MINIMAL,
      tools: [{ ...MINIMAL.tools[0], args: { limit: { type: "number", max: "ten" } } }],
    };
    expect(() => parseSpec(bad)).toThrow(/\(received "ten"\)/);
  });

  it("says so in words when nothing is at the path, rather than printing a bare `undefined`", () => {
    // A missing required key is the commonest failure in a hand-written spec, and it is the one
    // value JSON.stringify cannot render: it returns `undefined` (the value, not the string), so
    // the line used to end `(received undefined)` — a bare token where every other value appears
    // as a JSON literal (`"ten"`, `null`, `42`).
    const { description: _dropped, ...bad } = MINIMAL;
    let message = "";
    try {
      parseSpec(bad);
      expect(true).toBe(false); // Should not reach here
    } catch (e) {
      message = (e as Error).message;
    }
    expect(message).toMatch(
      /^ {2}description: .*\(no JSON value there — usually a missing key\)$/m,
    );
    expect(message).not.toContain("(received undefined)");
  });

  it("caps the received value, so a root-level issue does not print the whole spec back", () => {
    // A root-level issue's path is EMPTY, so the value at it is the entire spec. An unrecognized
    // top-level key — `$schema`, the one an author reaches for first — dumped all ~500 characters
    // of this spec onto one line, and a real spec is larger still
    // (fixtures/dependencytrack.spec.json is 3,169 characters once compacted).
    const bad = { ...MINIMAL, $schema: "https://example.test/connector-spec.schema.json" };
    let message = "";
    try {
      parseSpec(bad);
      expect(true).toBe(false); // Should not reach here
    } catch (e) {
      message = (e as Error).message;
    }
    expect(message).toMatch(/^ {2}\(root\): Unrecognized key: "\$schema" \(received \{/m);

    const received = /\(received (.*)\)$/m.exec(message)?.[1];
    // Exactly the cap plus one ellipsis. Asserting the LENGTH, not just the presence of the
    // ellipsis, is what makes a change to the cap fail in EITHER direction: lower it and this is
    // shorter, raise it past the ~500-character dump and nothing is truncated at all.
    expect(received).toHaveLength(121);
    expect(received?.endsWith("…")).toBe(true);
    // And the cap is conditional, not a blanket slice — the short-value test above still sees
    // `(received "ten")` whole.
  });

  it("keeps one line per issue, so a spec with several problems stays readable", () => {
    const bad = {
      ...MINIMAL,
      env: [{ vars: ["X"], local: "probe-fetch", bindings: ["x"], required: true }],
      tools: [
        {
          ...MINIMAL.tools[0],
          args: {
            limit: { type: "number", max: "ten" },
            limit2: { type: "number", max: "twenty" },
          },
        },
      ],
    };
    let message = "";
    try {
      parseSpec(bad);
      expect(true).toBe(false); // Should not reach here
    } catch (e) {
      message = (e as Error).message;
    }
    const lines = message.split("\n");
    // One header line ("Invalid connector spec:") plus exactly one line per issue — proves no
    // issue's own text wraps onto a second physical line, which is what "readable at ten
    // problems" actually requires.
    expect(lines).toHaveLength(4);
    // `toMatch` against a single line with `^` anchoring, not `toContain` — each of these is
    // the first segment of its path, so the leading-dot suppression is exactly what an
    // unanchored substring test cannot see.
    expect(lines[1]).toMatch(/^ {2}env\[0\]\.local: /);
    expect(lines[2]).toMatch(/^ {2}tools\[0\]\.args\.limit\.max: /);
    expect(lines[3]).toMatch(/^ {2}tools\[0\]\.args\.limit2\.max: /);
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
 * schema tidiness — `renderTokenFunction` (src/emit/server/env.ts) does both `e.credentialsIn!`
 * and `JSON.stringify(e.tokenUrl)`, so without them a spec omitting either emits
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

describe("ToolSchema query parameters", () => {
  const withQuery = (tool: Record<string, unknown>) =>
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
      tools: [{ name: "t", description: "T.", path: "/messages", ...tool }],
    });

  it("accepts an unconditional and a conditional parameter", () => {
    const spec = withQuery({
      args: { limit: { type: "number" }, after: { type: "string", optional: true } },
      query: [
        { name: "limit", arg: "limit" },
        { name: "after", arg: "after", omitWhen: "empty" },
      ],
    });
    expect(spec.tools[0]!.query).toEqual([
      { name: "limit", arg: "limit" },
      { name: "after", arg: "after", omitWhen: "empty" },
    ]);
  });

  it("accepts a query key that is not a JS identifier", () => {
    const spec = withQuery({
      args: { limit: { type: "number" } },
      query: [{ name: "page[size]", arg: "limit" }],
    });
    expect(spec.tools[0]!.query![0]!.name).toBe("page[size]");
  });

  it("accepts omitWhen: absent on a string arg with no default", () => {
    const spec = withQuery({
      args: { after: { type: "string", optional: true } },
      query: [{ name: "after", arg: "after", omitWhen: "absent" }],
    });
    expect(spec.tools[0]!.query).toEqual([{ name: "after", arg: "after", omitWhen: "absent" }]);
  });

  it("accepts omitWhen: absent on a numeric arg with no default — github's page", () => {
    const spec = withQuery({
      args: {
        perPage: { type: "number", optional: true, default: 30 },
        page: { type: "number", optional: true },
      },
      query: [
        { name: "per_page", arg: "perPage" },
        { name: "page", arg: "page", omitWhen: "absent" },
      ],
    });
    expect(spec.tools[0]!.query).toEqual([
      { name: "per_page", arg: "perPage" },
      { name: "page", arg: "page", omitWhen: "absent" },
    ]);
  });

  it("rejects an omitWhen value that is neither absent nor empty", () => {
    expect(() =>
      withQuery({
        args: { after: { type: "string", optional: true } },
        query: [{ name: "after", arg: "after", omitWhen: "bogus" }],
      }),
    ).toThrow(/omitWhen/);
  });

  it('rejects omitWhen: "empty" on a non-string arg', () => {
    expect(() =>
      withQuery({
        args: { page: { type: "number", optional: true } },
        query: [{ name: "page", arg: "page", omitWhen: "empty" }],
      }),
    ).toThrow(/"page"/);
  });

  it("rejects omitWhen combined with an arg declaring a default", () => {
    expect(() =>
      withQuery({
        args: { after: { type: "string", optional: true, default: "x" } },
        query: [{ name: "after", arg: "after", omitWhen: "absent" }],
      }),
    ).toThrow(/"after"/);
  });

  it("rejects omitWhen on an arg that is not optional", () => {
    expect(() =>
      withQuery({
        args: { after: { type: "string" } },
        query: [{ name: "after", arg: "after", omitWhen: "absent" }],
      }),
    ).toThrow(/"after"/);
  });

  it("rejects omitWhen on a boolean arg — isHoisted hoists every boolean regardless of default", () => {
    expect(() =>
      withQuery({
        args: { flag: { type: "boolean", optional: true } },
        query: [{ name: "flag", arg: "flag", omitWhen: "absent" }],
      }),
    ).toThrow(/"flag"/);
  });

  // The mirror of the omitWhen-forbidden checks above: an arg whose value CAN be undefined
  // (optional, no default, not boolean) and declares no omitWhen reaches searchParams.set
  // unconditionally — TS2345 in the generated package for a string arg (set(key, value)
  // rejects `string | undefined`), and a literal "?<name>=undefined" on the wire for a
  // numeric one (the non-string branch wraps in String(...), and String(undefined) ===
  // "undefined"). Both parsed clean before canOmitQueryValue's bidirectional check.
  it("rejects an optional string query arg with no omitWhen — would fail set()'s own typecheck", () => {
    expect(() =>
      withQuery({
        args: { after: { type: "string", optional: true } },
        query: [{ name: "after", arg: "after" }],
      }),
    ).toThrow(/"after"/);
  });

  it('rejects an optional numeric query arg with no omitWhen — would send a literal "undefined"', () => {
    expect(() =>
      withQuery({
        args: { page: { type: "number", optional: true } },
        query: [{ name: "page", arg: "page" }],
      }),
    ).toThrow(/"page"/);
  });

  it("still accepts a defaulted optional arg with no omitWhen — its value is never undefined", () => {
    const spec = withQuery({
      args: { limit: { type: "number", optional: true, default: 50 } },
      query: [{ name: "limit", arg: "limit" }],
    });
    expect(spec.tools[0]!.query).toEqual([{ name: "limit", arg: "limit" }]);
  });

  it("still accepts a required arg with no omitWhen — its value is never undefined", () => {
    const spec = withQuery({
      args: { id: { type: "string" } },
      query: [{ name: "id", arg: "id" }],
    });
    expect(spec.tools[0]!.query).toEqual([{ name: "id", arg: "id" }]);
  });

  it("rejects a query arg that is not declared", () => {
    expect(() => withQuery({ args: {}, query: [{ name: "after", arg: "after" }] })).toThrow(
      /"after"/,
    );
  });

  it("rejects a query arg named after an inherited Object property", () => {
    expect(() => withQuery({ args: {}, query: [{ name: "k", arg: "toString" }] })).toThrow(
      /"toString"/,
    );
  });

  it("rejects two entries writing the same query key", () => {
    expect(() =>
      withQuery({
        args: { a: { type: "string" }, b: { type: "string" } },
        query: [
          { name: "limit", arg: "a" },
          { name: "limit", arg: "b" },
        ],
      }),
    ).toThrow(/"limit"/);
  });

  it("rejects query on a stub tool", () => {
    expect(() =>
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
        tools: [
          {
            name: "t",
            description: "T.",
            impl: "stub",
            args: { after: { type: "string" } },
            query: [{ name: "after", arg: "after" }],
          },
        ],
      }),
    ).toThrow(/query/);
  });

  // A stub has no "path" by construction (the impl/path pairing refine), so the
  // path-must-begin-with-"/" check below evaluated an empty "path" against a stub and fired
  // a second, spurious issue alongside the correct one above. Guarded on t.path !== undefined
  // so only the stub rejection reports.
  it("rejects query on a stub tool with only the stub message, not the path message", () => {
    let message = "";
    try {
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
        tools: [
          {
            name: "t",
            description: "T.",
            impl: "stub",
            args: { after: { type: "string" } },
            query: [{ name: "after", arg: "after" }],
          },
        ],
      });
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toMatch(/"stub" tool issues no request, so "query" has nothing to describe/);
    expect(message).not.toMatch(/must begin with/);
  });

  // renderSearchTool (src/emit/server/tools-hand.ts) returns early for impl === "search" and
  // never reads t.query — accepted at parse time, silently discarded at emit time. The stub
  // rejection above closes the same hole for stubs; this closes it for search tools.
  it("rejects query on a search tool", () => {
    expect(() =>
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
        tools: [
          {
            name: "t",
            description: "T.",
            impl: "search",
            path: "/messages",
            filter: { export: "filterDiscordMessages", fields: ["id"] },
            args: { after: { type: "string" } },
            query: [{ name: "after", arg: "after" }],
          },
        ],
      }),
    ).toThrow(/query/);
  });

  it("rejects query when the path already carries a query string", () => {
    expect(() =>
      withQuery({
        path: "/messages?limit=50",
        args: { after: { type: "string" } },
        query: [{ name: "after", arg: "after" }],
      }),
    ).toThrow(/\?/);
  });

  it("rejects an empty query array", () => {
    expect(() => withQuery({ args: {}, query: [] })).toThrow();
  });

  // renderPath's query-branch prefix (the fetch helper's base) joins directly onto the path
  // template with no separator and none of renderFetchHelper's leading-slash normalization —
  // a slashless path fuses onto the base ("https://x.testitems" instead of
  // "https://x.test/items"). Rejected here rather than left to be discovered in a request.
  it('rejects query on a tool whose path does not begin with "/"', () => {
    expect(() =>
      withQuery({
        path: "messages",
        args: { after: { type: "string" } },
        query: [{ name: "after", arg: "after" }],
      }),
    ).toThrow(/"t".*"\/"/);
  });

  it('accepts query on a tool whose path begins with "/"', () => {
    const spec = withQuery({
      path: "/messages",
      args: { after: { type: "string" } },
      query: [{ name: "after", arg: "after" }],
    });
    expect(spec.tools[0]!.path).toBe("/messages");
  });

  it("leaves a tool with no query untouched", () => {
    const spec = withQuery({ args: {} });
    expect(spec.tools[0]!.query).toBeUndefined();
  });
});

describe("strings the emitter splices raw into generated source", () => {
  // The payload that reproduced the hole: it closes renderFetchHelper's URL template literal,
  // runs a call, and reopens the literal so `${path}` still lands inside one. The emitted file
  // is valid TypeScript, Biome reformats it happily and `tsc --noEmit --strict` passes it —
  // test/emit/server/fetch-helper.ts's "splices `base` raw" test holds that half.
  const CLOSES_TEMPLATE = "https://api.zz.test/v1` + String(Date.now()) + `";
  // A serviceLabel reaches a block comment in src/emit/wiring.ts, where these two characters
  // are the ones that end the construct rather than a backtick.
  const CLOSES_COMMENT = "Zz */ export const pwned = 1; /*";

  const withBase = (base: string) => ({
    ...MINIMAL,
    fetchHelper: { ...MINIMAL.fetchHelper, base },
  });

  it("rejects a backtick in fetchHelper.base, naming the field", () => {
    expect(() => parseSpec(withBase(CLOSES_TEMPLATE))).toThrow(/fetchHelper\.base.*backtick/s);
  });

  it("rejects a backtick in serviceLabel, naming the field", () => {
    expect(() => parseSpec({ ...MINIMAL, serviceLabel: "New `Relic`" })).toThrow(
      /serviceLabel.*backtick/s,
    );
  });

  it("rejects a block-comment terminator in fetchHelper.base, naming the field", () => {
    expect(() => parseSpec(withBase("https://api.zz.test/*/v1*/"))).toThrow(
      /fetchHelper\.base.*block comment/s,
    );
  });

  it("rejects a block-comment terminator in serviceLabel, naming the field", () => {
    expect(() => parseSpec({ ...MINIMAL, serviceLabel: CLOSES_COMMENT })).toThrow(
      /serviceLabel.*block comment/s,
    );
  });

  /*
   * The `${` half of the same hole. This suite used to carry the opposite claim — that a `${`
   * needs no rejection because it "produces an UNDEFINED IDENTIFIER the generated package's own
   * tsc reports". That holds for a BARE IDENTIFIER and for nothing else: an interpolation whose
   * expression is self-contained names nothing outside itself, so there is no identifier left to
   * be undefined. Verified end to end on both fields before this suite was written — parseSpec
   * accepted it, generate() spliced it, Biome only reformatted it, `tsc --noEmit --strict` passed
   * it clean, and the IIFE was present in the emitted src/server.ts. In `serviceLabel` it lands in
   * the fetch helper's error template, where it runs on every non-2xx response.
   */
  const SELF_CONTAINED_IIFE = '${(() => { globalThis.__PWNED__ = "yes"; return ""; })()}';

  it("rejects a self-contained interpolation in fetchHelper.base, naming the field", () => {
    expect(() => parseSpec(withBase(`https://api.zz.test/v1${SELF_CONTAINED_IIFE}`))).toThrow(
      /fetchHelper\.base.*interpolation/s,
    );
  });

  it("rejects a self-contained interpolation in serviceLabel, naming the field", () => {
    expect(() => parseSpec({ ...MINIMAL, serviceLabel: `ZZ${SELF_CONTAINED_IIFE}` })).toThrow(
      /serviceLabel.*interpolation/s,
    );
  });

  // The two messages differ because the two FIELDS do, and an author who reads only the message
  // has to be told which of the two rules they hit. Asserted rather than left to coverage: both
  // arms execute either way, so nothing else fails if they are swapped.
  it("tells a base author which single interpolation the field does take", () => {
    expect(() => parseSpec(withBase("https://${host}/v1"))).toThrow(/\$\{env\.NAME\}/);
  });

  it("tells a serviceLabel author the field takes none at all", () => {
    expect(() => parseSpec({ ...MINIMAL, serviceLabel: "Zz ${host}" })).toThrow(
      /takes no interpolation at all/,
    );
  });

  // The bare-identifier form, refused HERE rather than left to the generated package's tsc.
  // Relying on a different tool, run at a different time, on a different package to report an
  // injection is what made the self-contained payload above reachable: the argument was about
  // one shape and the field admitted every shape.
  it("rejects a bare identifier interpolation in fetchHelper.base", () => {
    expect(() => parseSpec(withBase("https://${host}/v1"))).toThrow(
      /fetchHelper\.base.*interpolation/s,
    );
  });

  // serviceLabel resolves NOTHING: no emitter rewrites a reference in it, so the env form that
  // `base` documents is just another live interpolation here.
  it("rejects ${env.X} in serviceLabel, which no emitter resolves", () => {
    expect(() => parseSpec({ ...MINIMAL, serviceLabel: "Zz ${env.siteHost}" })).toThrow(
      /serviceLabel.*interpolation/s,
    );
  });

  // The pin, not a new behaviour: `${env.X}` in `base` is a documented feature — 7 of the 22
  // fixtures use it, three of them byte-locked — so the refinement above has to admit exactly
  // that shape and refuse the rest. A tightening that folded it into the rejection would break
  // the feature; it fails here, in milliseconds, instead of in diff:golden.
  const withEnvBase = (base: string) => ({
    ...MINIMAL,
    env: [{ vars: ["ZZ_SITE"], local: "siteHost", bindings: ["h"], required: true }],
    fetchHelper: { local: "nrGet", base, inlineHeaders: { Accept: "application/json" } },
  });

  it("still accepts ${env.X} in fetchHelper.base", () => {
    expect(parseSpec(withEnvBase("https://${env.siteHost}/api")).fetchHelper.base).toBe(
      "https://${env.siteHost}/api",
    );
  });

  // The shape the fixtures actually use is a reference EMBEDDED in surrounding text, not a value
  // that is one reference and nothing else — `${env.X}` alone is what `headerOption` matches with
  // its anchored test, and reusing that anchoring here would reject every fixture base there is.
  it("accepts ${env.X} embedded in surrounding text, and more than one of them", () => {
    const base = "https://${env.siteHost}.zz.test/${env.apiVersion}/api";
    expect(parseSpec(withEnvBase(base)).fetchHelper.base).toBe(base);
  });

  // A `${` that OPENS an env reference but never closes it as one. The removal pass leaves the
  // opener behind, which is the point of scanning the residue rather than testing whether an
  // env reference appears somewhere in the string.
  it("rejects an interpolation that only begins like an env reference", () => {
    expect(() => parseSpec(withBase("https://${env.siteHost${Date.now()}}/api"))).toThrow(
      /fetchHelper\.base.*interpolation/s,
    );
  });

  // diff:golden proves this too, but only against an AGPL checkout and only as part of a full
  // byte diff. This fails in milliseconds and names the fixture that stopped parsing.
  it.each(["newrelic", "datadog", "grafana", "sentry"])(
    "leaves the byte-locked %s fixture parseable",
    (name) => {
      const raw = readFileSync(
        join(import.meta.dir, "..", "fixtures", `${name}.spec.json`),
        "utf8",
      );
      expect(() => parseSpec(JSON.parse(raw))).not.toThrow();
    },
  );

  /*
   * What makes the `base` predicate a MIRROR of the emitter rather than a second opinion about
   * which characters look dangerous. `resolveEnvRefs` (src/emit/server/fetch-helper.ts) is the
   * authority on which references stop being interpolation; `baseExpr` is the exported function
   * that runs it, so the two rules are held against each other through real emitter output here
   * instead of by two copies of one regex agreeing with themselves.
   *
   * The stripper below is the emitter's OUTPUT shape — `${NAME()}`, what `resolveEnvRefs` writes
   * for a reference it resolved — deliberately not the schema's input pattern. Removing it leaves
   * exactly the interpolations the emitter did NOT resolve, which is the set the schema must
   * refuse; so a `resolveEnvRefs` that stops resolving `${env.X}`, or starts resolving something
   * else, fails this test rather than silently disagreeing with `src/spec.ts`.
   *
   * The one base it cannot judge is one that already reads `${NAME()}` before the emitter sees it
   * — a live call the stripper cannot tell from a resolved reference. The schema refuses it (it is
   * not an `env.` reference), which is the safe verdict; it is left out of the table below rather
   * than asserted, because this test's model genuinely cannot see it.
   */
  const RESOLVED_CALL = /\$\{\w+\(\)\}/g;
  const emitterLeavesLiveInterpolation = (base: string) =>
    baseExpr({ fetchHelper: { base } } as unknown as ConnectorSpec)
      .replaceAll(RESOLVED_CALL, "")
      .includes("${");

  it.each([
    "https://api.zz.test/v1",
    "https://${env.siteHost}/api",
    "https://${env.siteHost}.zz.test/${env.apiVersion}/api",
    `https://api.zz.test/v1${SELF_CONTAINED_IIFE}`,
    "https://${host}/v1",
    // A reference in the same DOTTED shape naming something other than `env` — the difference
    // between mirroring `resolveEnvRefs` and merely resembling it.
    "https://${cfg.host}/api",
    "https://${env.}/api",
    // The reference NEVER CLOSES as one: a rule that asked whether an env reference appears
    // anywhere in the string, or that matched its name loosely, would accept this.
    "https://${env.siteHost${Date.now()}}/api",
  ])("accepts %j exactly when the emitter resolves every interpolation in it", (base) => {
    let accepted = true;
    try {
      parseSpec(withEnvBase(base));
    } catch {
      accepted = false;
    }
    expect(accepted).toBe(!emitterLeavesLiveInterpolation(base));
  });
});

/**
 * The rest of the raw-splice carrier set, guarded field by field with a message that names the
 * field. `test/raw-splice.test.ts` is what says this set is COMPLETE — it derives the carriers
 * from the emitters — and these are what say each rejection reads usefully when it fires.
 */
describe("the raw-splice carriers the first version of the guard missed", () => {
  const withEnv = (over: Record<string, unknown>) => ({
    ...MINIMAL,
    env: [
      { vars: ["NEW_RELIC_API_KEY"], local: "apiKey", bindings: ["k"], required: true, ...over },
    ],
  });
  const withTool = (over: Record<string, unknown>) => ({
    ...MINIMAL,
    tools: [{ ...MINIMAL.tools[0], ...over }],
  });

  // The CRITICAL. `wrapped()` splices prefix into a template literal, and renderBasic splices
  // that template into the username ARGUMENT of encodeBasicAuthHeader — an expression position.
  const IIFE = '${(() => { globalThis.__PWNED__ = "yes"; return ""; })()}';

  it("rejects a self-contained interpolation in env[].prefix, naming the field", () => {
    expect(() => parseSpec(withEnv({ prefix: IIFE }))).toThrow(/env\[\]\.prefix.*interpolation/s);
  });

  it("rejects a self-contained interpolation in env[].suffix, naming the field", () => {
    expect(() => parseSpec(withEnv({ suffix: IIFE }))).toThrow(/env\[\]\.suffix.*interpolation/s);
  });

  it("rejects a backtick in env[].prefix, which has no `return` in front of it in renderBasic", () => {
    expect(() => parseSpec(withEnv({ prefix: "a` + evil() + `" }))).toThrow(
      /env\[\]\.prefix.*backtick/s,
    );
  });

  it("still accepts the affixes the byte-locked fixtures declare", () => {
    // datadog writes prefix "api.", sentry suffix "/api/0", zendesk suffix "/token". Guarding
    // these two fields is measured at zero cost, and this is where that is pinned.
    expect(parseSpec(withEnv({ prefix: "api." })).env[0]!.prefix).toBe("api.");
    expect(parseSpec(withEnv({ suffix: "/api/0" })).env[0]!.suffix).toBe("/api/0");
  });

  it("accepts an EMPTY affix, which is what --from-connector records for the unused side", () => {
    // classifyPlainReturn (src/derive/server/env.ts) reads both from the template's cooked
    // quasis unconditionally. A .min(1) here would reject a spec this repo's own deriver writes.
    expect(parseSpec(withEnv({ prefix: "", suffix: "/token" })).env[0]!.prefix).toBe("");
  });

  it("rejects a block-comment terminator in tools[].name, which closes the wiring docstring", () => {
    expect(() => parseSpec(withTool({ name: 'a*/;(globalThis as never).x="t";/*b_list' }))).toThrow(
      /tools\[\]\.name.*block comment/s,
    );
  });

  it("rejects a block-comment terminator in tools[].path", () => {
    expect(() => parseSpec(withTool({ path: "/v2/*/applications.json*/" }))).toThrow(
      /tools\[\]\.path.*block comment/s,
    );
  });

  it("leaves tools[].path's OWN ${…} to parsePathTemplate, which names the modes", () => {
    // The path DSL is the one carrier whose interpolation is a documented feature, so the
    // raw-splice guard supplies only the terminator half here — and the arg reference below
    // still parses rather than being caught by a second, vaguer rule.
    expect(
      parseSpec(withTool({ path: "/v2/${arg.id|enc}", args: { id: { type: "string" } } })).tools[0]!
        .path,
    ).toBe("/v2/${arg.id|enc}");
  });

  // I1: not a terminator but an ESCAPE, and the only sequence in the set that changes the
  // meaning of what comes AFTER it rather than ending what came before.
  it("rejects a trailing backslash in fetchHelper.base, which un-interpolates ${path}", () => {
    // Reproduced: `https://api.zz.test/v1\` emitted `` `https://api.zz.test/v1\${path}` ``,
    // whose VALUE is the literal text "https://api.zz.test/v1${path}" — verified by evaluating
    // the emitted template. The connector then requests that URL verbatim.
    expect(() =>
      parseSpec({
        ...MINIMAL,
        fetchHelper: { ...MINIMAL.fetchHelper, base: "https://a.test/v1\\" },
      }),
    ).toThrow(/fetchHelper\.base.*backslash/s);
  });

  it("rejects a backslash in serviceLabel too, per the field-not-site rule", () => {
    expect(() => parseSpec({ ...MINIMAL, serviceLabel: String.raw`New\Relic` })).toThrow(
      /serviceLabel.*backslash/s,
    );
  });

  it("rejects a non-identifier env binding, which is emitted as a const NAME", () => {
    expect(() => parseSpec(withEnv({ bindings: ["k = evil(); const j"] }))).toThrow(/identifier/);
  });

  it("rejects a non-identifier fetchHelper.headers, which is emitted as a CALL", () => {
    expect(() =>
      parseSpec({
        ...MINIMAL,
        fetchHelper: {
          local: "nrGet",
          base: "https://api.newrelic.com",
          headers: "((): Record<string, string> => { globalThis.x = 1; return h(); })",
        },
      }),
    ).toThrow(/identifier/);
  });

  it("rejects a non-identifier rows, which is emitted as a const NAME three times", () => {
    expect(() =>
      parseSpec({
        ...MINIMAL,
        style: "read-only-kit",
        fetchHelper: { local: "nrGet", base: "https://api.newrelic.com", headers: "apiKey" },
        tools: [
          {
            name: "nr_search",
            description: "S.",
            impl: "search",
            path: "/v2/x",
            rows: "data-items",
            filter: { export: "nrFilter", fields: ["id"] },
          },
        ],
      }),
    ).toThrow(/identifier/);
  });
});

/**
 * I6, the ledger's own deferred follow-up: an inline header value that MEANS to reference the
 * credential and is emitted as literal characters instead.
 */
describe("an inline header value that mixes text with an env reference", () => {
  const withHeaders = (inlineHeaders: Record<string, string>) => ({
    ...MINIMAL,
    fetchHelper: { local: "nrGet", base: "https://api.newrelic.com", inlineHeaders },
  });

  it("rejects it, naming the header and quoting the value", () => {
    // Emitted `Authorization: "Bearer ${env.apiKey}"` before this rule: the literal characters
    // went on the wire and the credential was never read. It compiled, linted and typechecked.
    expect(() => parseSpec(withHeaders({ Authorization: "Bearer ${env.apiKey}" }))).toThrow(
      /Authorization.*Bearer/s,
    );
  });

  it("keeps the anchored form, which is what the only fixture using inlineHeaders writes", () => {
    // fixtures/newrelic.spec.json — byte-locked at 6/6 — writes exactly this.
    const spec = parseSpec(
      withHeaders({ "X-Api-Key": "${env.apiKey}", Accept: "application/json" }),
    );
    expect(spec.fetchHelper.inlineHeaders).toEqual({
      "X-Api-Key": "${env.apiKey}",
      Accept: "application/json",
    });
  });

  it("leaves a plain header with no interpolation alone", () => {
    expect(
      parseSpec(withHeaders({ Accept: "application/json" })).fetchHelper.inlineHeaders,
    ).toEqual({ Accept: "application/json" });
  });

  it("rejects an interpolation that is not an env reference at all", () => {
    expect(() => parseSpec(withHeaders({ "X-Api-Key": "${apiKey()}" }))).toThrow(/X-Api-Key/);
  });
});
