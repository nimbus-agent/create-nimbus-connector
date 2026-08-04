import { beforeAll, describe, expect, it } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { deriveSpec } from "../../scripts/_lib/derive/index.ts";
import { generate } from "../../src/emit/index.ts";
import { formatAll, initFormatter } from "../../src/format.ts";
import { parseSpec } from "../../src/spec.ts";
import { displayPath } from "../../src/types.ts";

/**
 * Fixtures whose emitted src/server.ts + nimbus.extension.json this plan's recognizers derive,
 * and which then re-emit byte-identical output for every file the fixture produces. Confirmed
 * by running the full parseSpec -> generate -> deriveSpec -> parseSpec -> generate pipeline
 * against every fixture in fixtures/ (see task-11-report.md for the full sweep): 6 of 20
 * fixtures derive, and all 6 round-trip 6/6 files. newrelic/datadog/grafana/sentry are the
 * byte-locked corpus fixtures (all "hand-rolled" style); zzscratch and zzstandalonehand are
 * synthetic "hand-rolled" fixtures that exercise the same frame from the opposite direction.
 */
const ROUND_TRIP = ["newrelic", "datadog", "grafana", "sentry", "zzscratch", "zzstandalonehand"];

/**
 * Fixtures that must derive as BLOCKED, each with the construct that stops it. Listed so the
 * gap is on screen on every run rather than implied by absence — the same reason
 * fixtures/expectations.json omits a file instead of hiding it.
 *
 * "read-only-kit frame" and "rest-kit frame" are `style: "read-only-kit"` / `style: "rest-kit"`
 * fixtures: recognizeFrame's hand-rolled shape either does not match at all (read-only-kit,
 * reported as the `no-frame` blocker) or matches only the frame while leaving every
 * kit-specific statement (the shared-kit import, the kit-factory const-call, each per-tool
 * registrar call) unclaimed (rest-kit). Both are a different emitted shape this plan's
 * recognizers do not model, not a bug in a single recognizer.
 *
 * "client-credentials auth" (zzwrite) and "write body" (zzwriteonly) are documented exclusions
 * inside the recognizers themselves: server/env.ts's `recognizeOne` docstring says the
 * `auth: "client-credentials"` function shape "is left unclaimed", and no recognizer in this
 * plan claims a write-effect fetch helper (zzwriteonly's `zzGetSend`) — write bodies are plan
 * 2's territory.
 */
const BLOCKED: Record<string, string> = {
  bitrise: "read-only-kit frame",
  dependencytrack: "read-only-kit frame",
  discord: "rest-kit frame",
  "google-meet": "rest-kit frame",
  mercury: "read-only-kit frame",
  netlify: "read-only-kit frame",
  zendesk: "read-only-kit frame",
  zzextract: "read-only-kit frame",
  zzsearch: "read-only-kit frame",
  zzsearchstub: "read-only-kit frame",
  zzstandalone: "rest-kit frame",
  zzwrite: "client-credentials auth",
  zzwriteonly: "write body",
  zzwriterest: "rest-kit frame",
};

function emitted(name: string): { server: string; manifest: string } {
  const specPath = join(import.meta.dir, "..", "..", "fixtures", `${name}.spec.json`);
  const spec = parseSpec(JSON.parse(readFileSync(specPath, "utf8")));
  const files = formatAll(generate(spec));
  const read = (path: string): string => {
    const file = files.find((f) => displayPath(f.path) === path);
    if (file === undefined) throw new Error(`${name} emitted no ${path}`);
    return file.content;
  };
  return { server: read("src/server.ts"), manifest: read("nimbus.extension.json") };
}

/** Every path this fixture's own spec emits, keyed to its content — the full file set, not just server.ts. */
function emittedFiles(name: string): Map<string, string> {
  const specPath = join(import.meta.dir, "..", "..", "fixtures", `${name}.spec.json`);
  const spec = parseSpec(JSON.parse(readFileSync(specPath, "utf8")));
  const files = formatAll(generate(spec));
  return new Map(files.map((f) => [displayPath(f.path), f.content]));
}

beforeAll(async () => {
  await initFormatter();
});

describe("deriveSpec round-trips this repository's own output", () => {
  // Every fixture in fixtures/ must appear in exactly one of ROUND_TRIP / BLOCKED — an
  // unlisted fixture is a gap nobody can see. Fail loudly rather than silently skipping one
  // added later.
  it("accounts for every fixture in fixtures/", () => {
    const names = readdirSync(join(import.meta.dir, "..", "..", "fixtures"))
      .filter((f) => f.endsWith(".spec.json"))
      .map((f) => f.replace(".spec.json", ""))
      .sort();
    const listed = new Set([...ROUND_TRIP, ...Object.keys(BLOCKED)]);
    expect(names.filter((n) => !listed.has(n))).toEqual([]);
    expect([...listed].filter((n) => !names.includes(n))).toEqual([]);
  });

  for (const name of ROUND_TRIP) {
    it(`re-emits byte-identical output for every file ${name} emits`, () => {
      const files = emittedFiles(name);
      const server = files.get("src/server.ts");
      const manifest = files.get("nimbus.extension.json");
      if (server === undefined || manifest === undefined) {
        throw new Error(`${name} emitted no src/server.ts or nimbus.extension.json`);
      }

      const derivation = deriveSpec({ server, manifest });
      if (!derivation.ok) {
        throw new Error(
          `${name} did not derive: ${derivation.blockers.map((b) => b.kind).join(", ")}`,
        );
      }

      const reFiles = new Map(
        formatAll(generate(parseSpec(derivation.spec))).map((f) => [
          displayPath(f.path),
          f.content,
        ]),
      );

      for (const [path, content] of files) {
        expect(reFiles.get(path)).toBe(content);
      }
    });
  }

  for (const [name, reason] of Object.entries(BLOCKED)) {
    it(`blocks ${name} (${reason}) rather than deriving something wrong`, () => {
      const derivation = deriveSpec(emitted(name));
      expect(derivation.ok).toBe(false);
    });
  }
});
