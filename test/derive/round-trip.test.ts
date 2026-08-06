import { beforeAll, describe, expect, it } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { initParser } from "../../src/derive/ast.ts";
import { deriveSpec } from "../../src/derive/index.ts";
import { generate } from "../../src/emit/index.ts";
import { formatAll, initFormatter } from "../../src/format.ts";
import { parseSpec } from "../../src/spec.ts";
import { displayPath } from "../../src/types.ts";

/**
 * Fixtures whose emitted src/server.ts + nimbus.extension.json (+ src/search-filter.ts, for the
 * search fixtures) this plan's recognizers derive, and which then re-emit byte-identical output
 * for every file the fixture produces. Confirmed by running the full parseSpec -> generate ->
 * deriveSpec -> parseSpec -> generate pipeline against every fixture in fixtures/, and the
 * "accounts for every fixture in fixtures/" test below re-confirms it on every run rather than
 * trusting a count recorded here that would go stale silently as fixtures are added.
 * newrelic/datadog/grafana/sentry are the byte-locked corpus fixtures (all "hand-rolled" style);
 * zzscratch and zzstandalonehand are synthetic "hand-rolled" fixtures that exercise the same
 * frame from the opposite direction; zzreadonly is a synthetic "read-only-kit" fixture with no
 * search tool, proving that frame end-to-end. zzstandalone is the "rest-kit" analogue: two GET
 * tools, a literal (non-baseConst) fetch-helper base, and no inline headers — recognizeRestTools
 * and recognizeRestFetchHelper's simplest in-scope shape, proving the rest-kit frame end-to-end
 * the same way zzreadonly does for read-only-kit.
 *
 * zzextract/zzsearch/zzsearchstub are the three synthetic search fixtures Task 3 unblocks —
 * search.ts's/search-filter.ts's own docstrings name the shapes each proves: zzsearch a search
 * tool with `rows` (item), one without (build, which also declares its own arg and takes the
 * inlined merged `z.object` schema form) and the keyed filter's `{ tags: true }` option;
 * zzsearchstub the same `rows` shape plus the throwing-stub filter and its extra
 * `type SearchFilter` import; zzextract one bespoke-extractor filter (all four shared
 * primitives) alongside one keyed filter in the same file, proving the import list is computed
 * per FILE, not per filter.
 *
 * mercury/netlify/zendesk/dependencytrack are Task 4's env-recognizer fixtures, unblocked by
 * server/env.ts's split-bearer pair (mercury, netlify — `recognizeEnv` now detects the
 * reader+wrapper pair as a unit, before the plain-accessor branch ever reaches the reader alone)
 * and its `trimTrailingSlashFn`/`auth: "basic"` accessors (zendesk, dependencytrack). Of these
 * four, only mercury and zendesk also move the `reach` headline (server-identical against the
 * REAL corpus) — netlify and dependencytrack were already excluded from `src/server.ts` in
 * fixtures/expectations.json for reasons unrelated to env (their real corpus source diverges
 * elsewhere), so this local round trip (this repo's own spec -> emit -> derive -> re-emit) is a
 * weaker, and different, claim than corpus byte-identity.
 */
const ROUND_TRIP = [
  "newrelic",
  "datadog",
  "grafana",
  "sentry",
  "zzreadonly",
  "zzscratch",
  "zzstandalone",
  "zzstandalonehand",
  "zzextract",
  "zzsearch",
  "zzsearchstub",
  "mercury",
  "netlify",
  "zendesk",
  "dependencytrack",
];

/**
 * Fixtures that must derive as BLOCKED, each with the construct that stops it. Listed so the
 * gap is on screen on every run rather than implied by absence — the same reason
 * fixtures/expectations.json omits a file instead of hiding it. Every reason below was checked
 * by actually running `deriveSpec` against the fixture's emitted output, not inferred from the
 * spec or the emitter — an earlier version of this docstring claimed rest-kit's frame never
 * matched (`"rest-kit frame"`), which stopped being true the moment
 * src/derive/server/index.ts grew its rest-kit branch, and a later version claimed the
 * factory const stayed unclaimed alongside a fixture's failing calls, which stopped being true
 * the moment tools-rest.ts split into `recognizeRestRegistrar` (claims the factory
 * unconditionally, as wiring — see its module docstring) and `recognizeRestTools` (all-or-nothing
 * over the calls only).
 *
 * "query parameters" (`discord`, `google-meet`) used to be TWO independent gaps; it is down to
 * ONE. Both fixtures set `fetchHelper.baseConst` (`DISCORD_API`/`MEET_BASE`), so their
 * fetch-helper function's URL template is `` `${baseConst}${path}` `` — `matchRestUrlConst`
 * (server/fetch-helper.ts) now resolves that shape against the module-scope const and claims
 * both the function and the const's own statement, closing what used to be the second gap here.
 * What remains: each tool's pathFn is the query branch — a block whose body contains
 * `const u = new URL(...)` — which `recognizeOneCall` (tools-rest.ts) still refuses outright,
 * plan 2's territory. Re-measured against HEAD (after that fetch-helper fix landed):
 * `deriveSpec` run against each fixture's own emitted output reports ONLY `register<X>Tool(...)`
 * calls unclaimed — `call:registerDiscordTool` for discord, `call:registerGoogleMeetTool` for
 * google-meet (`recognizeRestTools` claims none of them once even one fails) — never the
 * `baseConst` literal or the fetch-helper function anymore (both now claimed), never the factory
 * (`recognizeRestRegistrar` claims it independently), never a bare `no-frame` (the frame itself
 * matches fine, as `rest-kit`), and never `import-from:.../rest-tool-kit.ts` (claimed by the
 * frame too).
 *
 * "search tool" no longer names any fixture's blocker — Task 3 (`src/derive/server/search.ts`,
 * `src/derive/search-filter.ts`) landed the recognizer, and `zzextract`/`zzsearch`/
 * `zzsearchstub`, which blocked on search alone, are in ROUND_TRIP above. `bitrise` is the only
 * remaining `style: "read-only-kit"` fixture with a search tool that still blocks — on a
 * DIFFERENT construct, confirmed by running `deriveSpec` directly against its own search `reg()`
 * call in isolation (`recognizeSearchTool` recognizes it correctly, filter fields included)
 * before checking the whole connector, so the reason below is the ACTUAL remaining blocker, not
 * a guess at what search recognition left behind. `mercury`, `netlify`, `zendesk` and
 * `dependencytrack` — the other four fixtures that had a search tool alongside an env gap — moved
 * to ROUND_TRIP once Task 4 landed the split-bearer pair and the `trimTrailingSlashFn`/
 * `auth: "basic"` accessors (see ROUND_TRIP's own docstring above):
 *
 * - `bitrise` — "stub tool handler". Its other two tools are `impl: "stub"`
 *   (`async () => { throw ...; }`), a shape no recognizer in tools-hand.ts models (see
 *   `recognizeHoistedBlock`'s own docstring: a block whose last statement is not a `return` is
 *   refused). `recognizeTools` is all-or-nothing, so the one unrecognized stub call blocks the
 *   whole module — including its own search tool and both search-specific imports, which
 *   `deriveSpec` never even attempts to claim (`claimSearchImports` only runs once `toolsResult`
 *   itself succeeds). Reported: unclaimed `call:reg` statements plus both search imports.
 *
 * zzreadonly, in ROUND_TRIP above, is the read-only-kit fixture that proves the frame end-to-end
 * without a search tool in the way.
 *
 * "client-credentials auth" (zzwrite) is a documented exclusion inside the recognizer itself:
 * server/env.ts's `recognizeOne` docstring says the `auth: "client-credentials"` function shape
 * "is left unclaimed".
 *
 * "write body" names two DIFFERENT underlying gaps that share one description, not one gap in
 * two fixtures. `zzwriteonly` (hand-rolled/read-only-kit) has a write-effect fetch helper
 * (`zzGetSend`) no recognizer in this plan claims. `zzwriterest` (rest-kit) has an arity-5
 * `<registrar>(...)` call — a non-`GET` `initFn` argument `recognizeOneCall` refuses outright,
 * plan 2's territory the same way the query branch is. Its factory IS claimed (by
 * `recognizeRestRegistrar`, independently of the calls) and its fetch helper (a literal,
 * non-`baseConst` base) matches `recognizeRestFetchHelper` on its own; measured at HEAD, this
 * fixture reports exactly its two `call:registerZzwriterestTool` statements unclaimed — nothing
 * else — the same narrow shape `discord`/`google-meet` above now report too, now that their
 * fetch-helper gap (the `baseConst` literal and the fetch-helper function) is closed; all three
 * fixtures' remaining blockers come from the one recognizer, `recognizeOneCall`/
 * `recognizeRestTools` (tools-rest.ts).
 */
const BLOCKED: Record<string, string> = {
  bitrise: "stub tool handler",
  discord: "query parameters",
  "google-meet": "query parameters",
  zzwrite: "client-credentials auth",
  zzwriteonly: "write body",
  zzwriterest: "write body",
};

function emitted(name: string): { server: string; manifest: string; filter?: string } {
  const specPath = join(import.meta.dir, "..", "..", "fixtures", `${name}.spec.json`);
  const spec = parseSpec(JSON.parse(readFileSync(specPath, "utf8")));
  const files = formatAll(generate(spec));
  const read = (path: string): string => {
    const file = files.find((f) => displayPath(f.path) === path);
    if (file === undefined) throw new Error(`${name} emitted no ${path}`);
    return file.content;
  };
  // Optional, like SourceFiles.filter itself: most BLOCKED fixtures below have no search tool
  // and therefore no src/search-filter.ts at all.
  const filter = files.find((f) => displayPath(f.path) === "src/search-filter.ts")?.content;
  return { server: read("src/server.ts"), manifest: read("nimbus.extension.json"), filter };
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
  await initParser();
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

      const derivation = deriveSpec({
        server,
        manifest,
        filter: files.get("src/search-filter.ts"),
      });
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
