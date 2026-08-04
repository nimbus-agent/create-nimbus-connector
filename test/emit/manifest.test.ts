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

  it("orders write before delete, matching all 23 manifests that declare both (zero declare delete first)", () => {
    expect(
      hitl([
        { name: "a", description: "A.", path: "/a", method: "POST", effect: "write" },
        { name: "b", description: "B.", path: "/b", method: "DELETE", effect: "delete" },
      ]),
    ).toEqual(["write", "delete"]);
  });

  it("uses the fixed capability order regardless of declaration order — a delete tool declared first still emits write first", () => {
    expect(
      hitl([
        { name: "a", description: "A.", path: "/a", method: "DELETE", effect: "delete" },
        { name: "b", description: "B.", path: "/b", method: "POST", effect: "write" },
      ]),
    ).toEqual(["write", "delete"]);
  });

  it("collects delete alone", () => {
    expect(
      hitl([{ name: "a", description: "A.", path: "/a", method: "DELETE", effect: "delete" }]),
    ).toEqual(["delete"]);
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

describe("emitManifest, permissions.filesystem", () => {
  const withFs = (filesystem: unknown) =>
    parseSpec({
      ...JSON.parse(JSON.stringify(spec)),
      filesystem,
    });

  it("omits the key entirely when the spec does not declare it", () => {
    expect(emitManifest(spec).content).not.toContain("filesystem");
    expect(JSON.parse(emitManifest(spec).content).permissions).toEqual({
      network: ["api.newrelic.com", "api.eu.newrelic.com"],
    });
  });

  it("writes a declared filesystem block on one line, after network", () => {
    const out = emitManifest(withFs({ read: [], write: [] })).content;
    expect(out).toContain('"filesystem": {"read":[],"write":[]}');
    expect(out.indexOf('"network"')).toBeLessThan(out.indexOf('"filesystem"'));
  });

  it("keeps the collapsed form parseable, with the paths intact", () => {
    const out = emitManifest(withFs({ read: ["~/.cache/x"], write: ["/tmp/x"] })).content;
    expect(JSON.parse(out).permissions.filesystem).toEqual({
      read: ["~/.cache/x"],
      write: ["/tmp/x"],
    });
  });

  // String.prototype.replace expands $&, $`, $', $$ and $n inside a replacement STRING, and
  // the replacement is built from these paths. Before the replacer function, "$&BAD" spliced
  // the entire matched block back into the middle of the array and the emitted manifest was
  // not parseable at all; "A$$B" was silently corrupted to "A$B". Both directions are pinned
  // here — a throw and a wrong-but-parseable value are different failures.
  it("does not let a $-bearing path corrupt the emitted JSON", () => {
    const filesystem = { read: ["$&BAD", "A$$B", "$`x", "$'y", "$1z"], write: ["ok"] };
    const out = emitManifest(withFs(filesystem)).content;
    expect(() => JSON.parse(out)).not.toThrow();
    expect(JSON.parse(out).permissions.filesystem).toEqual(filesystem);
  });
});
