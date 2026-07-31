import { describe, expect, it } from "bun:test";
import { emitManifest } from "../../src/emit/manifest.ts";
import { parseSpec } from "../../src/spec.ts";

const spec = parseSpec({
  name: "newrelic",
  displayName: "New Relic",
  description: "New Relic connector. Read-focused.",
  serviceLabel: "New Relic",
  style: "hand-rolled",
  network: ["api.newrelic.com", "api.eu.newrelic.com"],
  env: [{ vars: ["NEW_RELIC_API_KEY"], local: "apiKey", bindings: ["k"], required: true }],
  fetchHelper: {
    local: "nrGet",
    base: "https://api.newrelic.com",
    inlineHeaders: { "X-Api-Key": "${env.apiKey}" },
  },
});

describe("emitManifest", () => {
  it("emits the required manifest fields", () => {
    const m = JSON.parse(emitManifest(spec).content);
    expect(m.id).toBe("com.nimbus.newrelic");
    expect(m.displayName).toBe("New Relic");
    expect(m.entrypoint).toBe("dist/server.js");
    expect(m.runtime).toBe("bun");
    expect(m.author).toBe("Nimbus");
    expect(m.version).toBe("0.1.0");
  });

  it("declares the network permission surface and an empty hitlRequired", () => {
    const m = JSON.parse(emitManifest(spec).content);
    expect(m.permissions).toEqual({ network: ["api.newrelic.com", "api.eu.newrelic.com"] });
    expect(m.hitlRequired).toEqual([]);
  });
});

const hitlSpec = (tools: unknown[]) =>
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

const hitl = (tools: unknown[]) =>
  JSON.parse(emitManifest(hitlSpec(tools)).content).hitlRequired as string[];

describe("hitlRequired", () => {
  it("is empty for a read-only connector", () => {
    expect(hitl([{ name: "a", description: "A.", path: "/a" }])).toEqual([]);
  });

  it("collects write", () => {
    expect(
      hitl([{ name: "a", description: "A.", path: "/a", method: "POST", effect: "write" }]),
    ).toEqual(["write"]);
  });

  it("sorts delete before write, matching all 37 manifests that declare them", () => {
    expect(
      hitl([
        { name: "a", description: "A.", path: "/a", method: "POST", effect: "write" },
        { name: "b", description: "B.", path: "/b", method: "DELETE", effect: "delete" },
      ]),
    ).toEqual(["delete", "write"]);
  });

  it("deduplicates", () => {
    expect(
      hitl([
        { name: "a", description: "A.", path: "/a", method: "POST", effect: "write" },
        { name: "b", description: "B.", path: "/b", method: "PUT", effect: "write" },
      ]),
    ).toEqual(["write"]);
  });

  it("counts a stub's declared effect — over-declaring asks for a needless approval, under-declaring lets a mutation past review", () => {
    expect(hitl([{ name: "a", description: "A.", impl: "stub", effect: "write" }])).toEqual([
      "write",
    ]);
  });
});
