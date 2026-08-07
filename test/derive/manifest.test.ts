import { describe, expect, it } from "bun:test";
import { deriveSpec } from "../../src/derive/index.ts";
import { deriveManifest, MissingManifestKey } from "../../src/derive/manifest.ts";

/** deriveSpec reads the manifest before ever touching src/server.ts, so its content is
 *  irrelevant to every test in this file — none of them reach parseModule. */
const MINIMAL_SERVER = "";

/** The shape `iac`'s real nimbus.extension.json has: well-formed, parses, and simply predates
 *  `syncInterval` — every other required key is present. Hand-synthesized (not iac's actual
 *  strings — see CLAUDE.md's licensing carve-out, which is bounded to fixtures/, not test/). */
const MANIFEST_WITHOUT_SYNC_INTERVAL = JSON.stringify({
  id: "zziac",
  displayName: "ZZ Iac",
  version: "0.1.0",
  description: "Fixture: a well-formed manifest missing syncInterval.",
  author: "Nimbus",
  entrypoint: "dist/server.js",
  runtime: "bun",
  permissions: { network: [] },
  hitlRequired: ["write", "delete"],
  minNimbusVersion: "0.2.0",
});

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
      hitlRequired: [],
      syncInterval: 300,
      minNimbusVersion: "0.2.0",
    });
  });

  it("recovers hitlRequired as the observed set, unattributed to any tool", () => {
    const withHitl = JSON.stringify({ ...JSON.parse(MANIFEST), hitlRequired: ["write", "delete"] });
    expect(deriveManifest(withHitl).hitlRequired).toEqual(["write", "delete"]);
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

  it("throws MissingManifestKey naming the missing key, not a generic Error — a well-formed manifest lacking one field is a different failure from a file that is not a manifest at all", () => {
    expect.assertions(2);
    try {
      deriveManifest(MANIFEST_WITHOUT_SYNC_INTERVAL);
    } catch (err) {
      expect(err).toBeInstanceOf(MissingManifestKey);
      expect((err as MissingManifestKey).key).toBe("syncInterval");
    }
  });
});

describe("deriveSpec, manifest blocker labels", () => {
  it("names the missing key rather than claiming there is no manifest — a well-formed manifest without one field is a different failure from a file that is not a manifest at all (iac is the live instance: it has a manifest and no syncInterval)", () => {
    const result = deriveSpec({ server: MINIMAL_SERVER, manifest: MANIFEST_WITHOUT_SYNC_INTERVAL });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.blockers[0]?.kind).toBe("manifest:missing-syncInterval");
  });

  it("still reports no-manifest for input that is not JSON at all", () => {
    const result = deriveSpec({ server: MINIMAL_SERVER, manifest: "not json" });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.blockers[0]?.kind).toBe("no-manifest");
  });
});
