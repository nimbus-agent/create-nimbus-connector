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
    const { style, ...rest } = MINIMAL;
    expect(parseSpec(rest).style).toBe("rest-kit");
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
});
