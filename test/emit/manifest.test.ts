import { describe, expect, it } from "bun:test";
import { emitManifest } from "../../src/emit/manifest.ts";
import { parseSpec } from "../../src/spec.ts";

const spec = parseSpec({
  name: "newrelic",
  displayName: "New Relic",
  description: "New Relic connector. Read-focused.",
  serviceLabel: "New Relic",
  network: ["api.newrelic.com", "api.eu.newrelic.com"],
  fetchHelper: { local: "nrGet", base: "https://api.newrelic.com" },
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
