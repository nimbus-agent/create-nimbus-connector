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
 * against every fixture in fixtures/, and the "accounts for every fixture in fixtures/" test
 * below re-confirms it on every run rather than trusting a count recorded here that would go
 * stale silently as fixtures are added. newrelic/datadog/grafana/sentry are the byte-locked
 * corpus fixtures (all "hand-rolled" style); zzscratch and zzstandalonehand are synthetic
 * "hand-rolled" fixtures that exercise the same frame from the opposite direction; zzreadonly is
 * a synthetic "read-only-kit" fixture with no search tool, proving that frame end-to-end.
 */
const ROUND_TRIP = [
  "newrelic",
  "datadog",
  "grafana",
  "sentry",
  "zzreadonly",
  "zzscratch",
  "zzstandalonehand",
];

/**
 * Fixtures that must derive as BLOCKED, each with the construct that stops it. Listed so the
 * gap is on screen on every run rather than implied by absence — the same reason
 * fixtures/expectations.json omits a file instead of hiding it.
 *
 * "rest-kit frame" is every `style: "rest-kit"` fixture (`discord`, `google-meet`,
 * `zzstandalone`, `zzwriterest`). rest-kit still emits the same `McpServer`/registrar/transport/
 * connect prologue and epilogue hand-rolled writes, so recognizeFrame's HAND-ROLLED branch
 * matches it — not `no-frame` — and leaves the rest-kit-specific statements (the
 * `rest-tool-kit.ts` import, the fetch-helper function, the `makeRestToolRegistrar` const-call,
 * each per-tool `register<X>Tool` call) unclaimed instead. Measured at HEAD: `discord` and
 * `zzwriterest` report `import-from:../../shared/rest-tool-kit.ts`,
 * `const-call:makeRestToolRegistrar`, `call:register<X>Tool` — never `no-frame`. That is a
 * different emitted shape this plan's recognizers do not model, not a bug in a single
 * recognizer.
 *
 * "search tool" is every `style: "read-only-kit"` fixture that declares an `impl: "search"`
 * tool. recognizeFrame's read-only-kit branch now reads the frame itself — see
 * scripts/_lib/derive/server/index.ts's `recognizeReadOnlyFrame` — but the search recognizer it
 * hands off to does not exist yet, so these still block, just past the frame rather than at it.
 * The label names the blocker landing the search recognizer would newly reach, not necessarily
 * the ONLY one currently reported: `zzextract`, `zzsearch` and `zzsearchstub` block on search
 * alone, but `mercury` (also `statement:VariableDeclaration`, `function:authHeader`,
 * `function:mercuryGet`), `bitrise` (`statement:VariableDeclaration`, `function:bitriseGet`),
 * `netlify` (`function:authHeader`, `function:netlifyGet`), `zendesk`
 * (`function:trimTrailingSlash`, `function:authHeader`) and `dependencytrack`
 * (`function:trimTrailingSlash`) additionally block on a fetch-helper shape this plan's
 * recognizers do not model either — landing the search recognizer will not unblock those five.
 * zzreadonly, in ROUND_TRIP above, is the read-only-kit fixture that proves the frame end-to-end
 * without a search tool in the way.
 *
 * "client-credentials auth" (zzwrite) and "write body" (zzwriteonly) are documented exclusions
 * inside the recognizers themselves: server/env.ts's `recognizeOne` docstring says the
 * `auth: "client-credentials"` function shape "is left unclaimed", and no recognizer in this
 * plan claims a write-effect fetch helper (zzwriteonly's `zzGetSend`) — write bodies are plan
 * 2's territory.
 */
const BLOCKED: Record<string, string> = {
  bitrise: "search tool",
  dependencytrack: "search tool",
  discord: "rest-kit frame",
  "google-meet": "rest-kit frame",
  mercury: "search tool",
  netlify: "search tool",
  zendesk: "search tool",
  zzextract: "search tool",
  zzsearch: "search tool",
  zzsearchstub: "search tool",
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

      // Byte equality per file is not enough: a recognizer that caused an extra file to be
      // emitted (or dropped one) would still pass a loop that only checks paths present in
      // `files`. Assert the two path sets are equal in both directions first.
      const originalPaths = [...files.keys()].sort();
      const reEmittedPaths = [...reFiles.keys()].sort();
      expect(reEmittedPaths).toEqual(originalPaths);

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
