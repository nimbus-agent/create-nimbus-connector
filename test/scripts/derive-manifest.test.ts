import { describe, expect, it } from "bun:test";
import { deriveManifest } from "../../scripts/_lib/derive/manifest.ts";

const MANIFEST = JSON.stringify({
  id: "newrelic",
  displayName: "New Relic",
  version: "0.1.0",
  description: "Query New Relic.",
  author: "Nimbus",
  entrypoint: "dist/server.js",
  runtime: "bun",
  permissions: { network: ["api.newrelic.com"] },
  hitlRequired: [],
  syncInterval: 300,
  minNimbusVersion: "0.2.0",
});

describe("deriveManifest", () => {
  it("recovers the fields the emitter writes from the spec", () => {
    expect(deriveManifest(MANIFEST)).toEqual({
      id: "newrelic",
      displayName: "New Relic",
      description: "Query New Relic.",
      network: ["api.newrelic.com"],
      syncInterval: 300,
      minNimbusVersion: "0.2.0",
    });
  });

  it("recovers filesystem when present, since its absence is meaningful", () => {
    const withFs = JSON.stringify({
      ...JSON.parse(MANIFEST),
      permissions: { network: [], filesystem: { read: ["/tmp"], write: [] } },
    });
    expect(deriveManifest(withFs).filesystem).toEqual({ read: ["/tmp"], write: [] });
  });

  it("throws on a manifest missing a required key rather than inventing one", () => {
    expect(() => deriveManifest('{"displayName":"X"}')).toThrow(/description/);
  });

  it("throws on malformed JSON", () => {
    expect(() => deriveManifest("{not json")).toThrow();
  });

  it("omits id when it is not present in the manifest", () => {
    const noId = JSON.stringify({
      displayName: "New Relic",
      version: "0.1.0",
      description: "Query New Relic.",
      author: "Nimbus",
      entrypoint: "dist/server.js",
      runtime: "bun",
      permissions: { network: ["api.newrelic.com"] },
      hitlRequired: [],
      syncInterval: 300,
      minNimbusVersion: "0.2.0",
    });
    expect(deriveManifest(noId)).not.toHaveProperty("id");
  });
});
