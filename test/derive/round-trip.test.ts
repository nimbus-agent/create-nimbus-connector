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
 * discord is the rest-kit fixture the query recognizer unblocks — server/query.ts reads
 * `renderTool`'s query branch (`const u = new URL(<base><path>)`, the `searchParams.set` lines,
 * and the `` return `${u}`; `` tail). It sets `fetchHelper.baseConst` (`DISCORD_API`), so it
 * exercises `BasePrefix`'s hoisted form and `deriveRestKitSpec`'s cross-check of it against the
 * base `recognizeRestFetchHelper` recovered independently; and it pins the staticPathStyle
 * abstention, since its `discord_guild_list` path is fully static and votes "quoted" — a query
 * tool voting "template" beside it would make `voteStaticPathStyle` block a connector this
 * generator emits correctly. `google-meet` is the same unblocking, one file short of a full
 * round trip; see PARTIAL_ROUND_TRIP. `BasePrefix`'s LITERAL form has no fixture — both of these
 * hoist their base — and is proved instead by test/derive/query.test.ts, against this
 * repository's own emitter output.
 *
 * zzquery is the HAND-ROLLED half of that same branch, and the only fixture that exercises it:
 * the sweep found the hand-rolled tail `` const path = `${u}` `` zero times across the 94 corpus
 * connectors (measured 2026-08-06), so this fixture is the only thing that will ever run it. It
 * pairs a query tool with the read helper's `path.startsWith("http")` passthrough line, which
 * `renderFetchHelper` emits IFF some tool declares a `query` array — the two halves are useless
 * apart, since without the helper half the tools would recognize and the module would still
 * block on the helper. Its `zzquery_health` tool is fully static and votes "quoted", so a query
 * tool voting "template" beside it would make `voteStaticPathStyle` block a connector this
 * generator emits correctly.
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
  "discord",
  "zzquery",
];

/**
 * Fixtures that DERIVE, and re-emit every file byte-identically except the ones named.
 *
 * A third list rather than an omission from either of the other two, for the same reason
 * fixtures/expectations.json omits a file instead of hiding it: "derives, but one file moves" is
 * a real outcome, and filing it under BLOCKED (it is not blocked) or ROUND_TRIP (it does not
 * round-trip) would state something untrue.
 *
 * Checked in BOTH directions, and the second direction is the point. The listed files must
 * actually DIFFER, so an entry that closes fails here rather than quietly weakening the check
 * that remains. And `unrecovered` names the spec fields the deriver could not recover: the test
 * puts them BACK, re-emits a second time, and then requires EVERY file to match. Without that
 * pass, `reason` would be an unchecked claim — a future regression in `description`,
 * `displayName` or the README's own License section moves the same file, and this entry would
 * absorb it and still report green.
 *
 * `google-meet` — README.md, from `title`. Why is docs/ROADMAP.md's *Known limitations* entry
 * "A recovered rest-kit `title` is verified against only one of its two consumers", including
 * the tier consequence. Not restated here: this docstring has gone stale three times, and two
 * copies of one explanation is how that happens.
 */
type PartialGap = {
  reason: string;
  files: string[];
  /** The fixture's OWN spec -> the fields `deriveSpec` could not recover from it. */
  unrecovered: (spec: Record<string, unknown>) => Record<string, unknown>;
};

const PARTIAL_ROUND_TRIP: Record<string, PartialGap> = {
  "google-meet": {
    reason: 'title "Google Meet" survives into src/server.ts only with its space stripped',
    files: ["README.md"],
    unrecovered: (spec) => ({ title: spec.title }),
  },
};

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
 * "query parameters" no longer names any fixture's blocker — server/query.ts landed the
 * recognizer, and `discord`/`google-meet`, which blocked on the query branch alone, are in
 * ROUND_TRIP / PARTIAL_ROUND_TRIP above. Both had been down to that one gap already: `matchRestUrlConst`
 * (server/fetch-helper.ts) closed their `` `${baseConst}${path}` `` fetch-helper gap earlier,
 * and re-measuring at HEAD before this task began showed each reporting ONLY its own
 * `register<X>Tool(...)` calls unclaimed — never the `baseConst` literal, the fetch-helper
 * function, or the factory.
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
 * the last of that recognizer's four unread `pathFn`/arity shapes now that the query branch is
 * read. Its factory IS claimed (by `recognizeRestRegistrar`, independently of the calls) and its
 * fetch helper (a literal, non-`baseConst` base) matches `recognizeRestFetchHelper` on its own;
 * measured at HEAD, this fixture reports exactly its two `call:registerZzwriterestTool`
 * statements unclaimed — nothing else.
 */
const BLOCKED: Record<string, string> = {
  bitrise: "stub tool handler",
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

/**
 * The fixture's spec as its AUTHOR wrote it — raw, not `parseSpec`'d, so a field the schema would
 * default is absent rather than filled in. `PARTIAL_ROUND_TRIP`'s `unrecovered` reads the field
 * it names from here rather than carrying a literal, so an entry cannot go on asserting against a
 * value the fixture no longer holds.
 */
function fixtureSpec(name: string): Record<string, unknown> {
  const specPath = join(import.meta.dir, "..", "..", "fixtures", `${name}.spec.json`);
  return JSON.parse(readFileSync(specPath, "utf8")) as Record<string, unknown>;
}

/** Every path a spec emits, keyed to its content — the full file set, not just server.ts. */
function emitToMap(spec: unknown): Map<string, string> {
  const files = formatAll(generate(parseSpec(spec)));
  return new Map(files.map((f) => [displayPath(f.path), f.content]));
}

function emittedFiles(name: string): Map<string, string> {
  return emitToMap(fixtureSpec(name));
}

beforeAll(async () => {
  await initFormatter();
  await initParser();
});

/**
 * Emit -> derive -> re-emit, asserting file-for-file.
 *
 * With no `gap`, every file must match. With one, `gap.files` must each actually DIFFER (an entry
 * that closes fails here rather than quietly turning into a weaker check on the files that
 * remain) — and then the whole thing is re-emitted a SECOND time with `gap.unrecovered`'s fields
 * put back, where every file must match. That second pass is what turns "one file moves" into
 * "exactly these spec fields are unrecoverable, and nothing else about this fixture is wrong",
 * which is the claim `gap.reason` actually makes.
 */
function checkReEmission(name: string, gap?: PartialGap): void {
  const files = emittedFiles(name);
  const server = files.get("src/server.ts");
  const manifest = files.get("nimbus.extension.json");
  if (server === undefined || manifest === undefined) {
    throw new Error(`${name} emitted no src/server.ts or nimbus.extension.json`);
  }

  const derivation = deriveSpec({ server, manifest, filter: files.get("src/search-filter.ts") });
  if (!derivation.ok) {
    throw new Error(`${name} did not derive: ${derivation.blockers.map((b) => b.kind).join(", ")}`);
  }

  const reFiles = emitToMap(derivation.spec);

  // Byte equality per file is not enough: a recognizer that caused an extra file to be
  // emitted (or dropped one) would still pass a loop that only checks paths present in
  // `files`. Assert the two path sets are equal in both directions first.
  const originalPaths = [...files.keys()].sort();
  const reEmittedPaths = [...reFiles.keys()].sort();
  expect(reEmittedPaths).toEqual(originalPaths);

  for (const [path, content] of files) {
    if (gap?.files.includes(path) === true) {
      expect(reFiles.get(path)).not.toBe(content);
      continue;
    }
    expect(reFiles.get(path)).toBe(content);
  }

  if (gap === undefined) return;
  const restored = emitToMap({ ...derivation.spec, ...gap.unrecovered(fixtureSpec(name)) });
  for (const [path, content] of files) {
    expect(restored.get(path)).toBe(content);
  }
}

describe("deriveSpec round-trips this repository's own output", () => {
  // Every fixture in fixtures/ must appear in exactly one of ROUND_TRIP / PARTIAL_ROUND_TRIP /
  // BLOCKED — an unlisted fixture is a gap nobody can see. Fail loudly rather than silently
  // skipping one added later.
  it("accounts for every fixture in fixtures/", () => {
    const names = readdirSync(join(import.meta.dir, "..", "..", "fixtures"))
      .filter((f) => f.endsWith(".spec.json"))
      .map((f) => f.replace(".spec.json", ""))
      .sort();
    const listed = [...ROUND_TRIP, ...Object.keys(PARTIAL_ROUND_TRIP), ...Object.keys(BLOCKED)];
    expect(names.filter((n) => !listed.includes(n))).toEqual([]);
    expect(listed.filter((n) => !names.includes(n))).toEqual([]);
    // In EXACTLY one: a fixture in two lists would satisfy both checks above while making one of
    // them vacuous.
    expect(listed.length).toBe(new Set(listed).size);
  });

  for (const name of ROUND_TRIP) {
    it(`re-emits byte-identical output for every file ${name} emits`, () => {
      checkReEmission(name);
    });
  }

  for (const [name, gap] of Object.entries(PARTIAL_ROUND_TRIP)) {
    it(`re-emits every file ${name} emits but ${gap.files.join(", ")} (${gap.reason})`, () => {
      checkReEmission(name, gap);
    });
  }

  for (const [name, reason] of Object.entries(BLOCKED)) {
    it(`blocks ${name} (${reason}) rather than deriving something wrong`, () => {
      const derivation = deriveSpec(emitted(name));
      expect(derivation.ok).toBe(false);
    });
  }
});
