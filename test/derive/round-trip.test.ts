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
 * zzwriteonly is the write-body fixture, and it is the only one that exercises a connector with
 * NO read helper: its single tool is a POST, so `renderReadHelper` emits nothing (a read helper
 * nothing calls is a TS6133 in the generated package) and `<local>Send` is the only place
 * `fetchHelper.local`, `base`, `serviceLabel` and the headers appear at all — see
 * `recognizeWriteHelper`'s own section header. Its POST's body is the DEFAULT, which is what
 * makes it a check on server/body.ts's omit-when-it-is-the-default rule and not merely on the
 * mapping reader: an explicit `body` derived here would re-emit the identical bytes and still be
 * wrong, so the round trip alone cannot catch it — test/derive/body.test.ts compares the derived
 * `body` against each fixture author's own.
 *
 * zzwriterest is the rest-kit half of the write-body fixture pair — zzwriteonly's GET-less
 * connector is the hand-rolled half, above. Its single write tool (`zzwriterest_item_update`, a
 * PATCH) is the arity-5 `<registrar>(...)` call `recognizeInitFn` now reads (Task 6): the
 * bodyless `zzwriterest_item_list` stays arity 4 (a GET), so this fixture also proves the two
 * arities coexist in one module. The PATCH's `mode` arg is hoisted (with a default) in the PATH
 * callback but referenced inline (`parsed.mode ?? "merge"`) in the INIT callback — the same arg,
 * two different expressions, because the init callback is a separate arrow with nothing the path
 * callback declared in scope — which is what pins `recognizeInitFn`'s `hoistsInScope: false` at
 * this call site rather than merely asserting it as a `recognizeBodyExpr` unit-level contract
 * (test/derive/body.test.ts's own "contract for the rest-kit caller" tests). Its `body` mapping
 * (`title`, `mode`, `notify`) also differs from the DEFAULT (`title`, `notify` — `mode` rides the
 * path) by one key, so this fixture is the only round-trip proof that the explicit-mapping path,
 * not just the omit-when-default one, survives a real emit -> derive -> re-emit cycle for the
 * rest-kit `initFn`.
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
 *
 * zzwrite is Task 8's fixture, and the last one to move: it is the ONLY fixture with
 * `auth: "client-credentials"`, whose four module-scope statements (`let cachedToken`,
 * `let tokenExpiresAt`, `async function token()`, `async function authHeaders()`)
 * `matchClientCredentials` (server/env.ts) now claims as one entry. It is also the only fixture
 * that exercises the AWAITED headers accessor — `headerOption` writes `await authHeaders()`
 * exactly for this auth mode — so it is the only round-trip proof of
 * `fetch-helper:headers-await-mismatch`'s two agreeing sides, in both the read helper and the
 * write helper, and of the token function's own `serviceLabel` agreeing with the fetch helper's.
 *
 * `bitrise` is Task 7's fixture, unblocked by `recognizeStubShape`/`recognizeStubHandler`
 * (server/tools-hand.ts) — its two `impl: "stub"` tools were the last thing standing between it
 * and this list; see BLOCKED's own docstring, below, for the shape that used to stop it. Like
 * `mercury`/`netlify`/`zendesk`/`dependencytrack` above, this is a LOCAL claim, not a corpus one
 * — fixtures/expectations.json still lists bitrise as `4/7` against the real connector, whose
 * `bitrise_list`/`bitrise_get` are hand-written conditionals this spec language cannot express
 * (see that fixture's own header comment); `impl: "stub"` here is a deliberate placeholder for
 * functionality outside the DSL's reach, not an attempt at a fifth matching file. The fixture's
 * own `handlerStyle: "block"` and `fetchHelper.staticPathStyle: "template"` both go unrecovered
 * without being GAPS: both stub tools abstain from the handlerStyle vote (see `ToolShape`'s own
 * docstring) and the connector's only OTHER tool is the search one, which never votes either;
 * and the search tool's own path (`/v0.1/apps/${arg.appSlug}/builds?limit=50`) is dynamic, so no
 * tool in this connector carries any staticPathStyle evidence at all. Neither setting is
 * observable in a single byte this connector emits, so their absence from the derived spec is
 * the correct minimal spec, not a recovery this deriver failed at.
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
  "zzwriteonly",
  "zzwriterest",
  "bitrise",
  "zzwrite",
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
 * Fixtures that must derive as BLOCKED, each with the construct that stops it.
 *
 * **This list is empty**, and the invariant it now records is: every fixture in `fixtures/`
 * derives, and every one of them re-emits byte-identically except `google-meet`, whose single
 * moving file PARTIAL_ROUND_TRIP names and re-checks in both directions. No count appears here
 * deliberately — the "accounts for every fixture" test does that arithmetic on every run, which is
 * this file's own top docstring's rule and CLAUDE.md's ("do not restate live numbers"): a number
 * written down here goes stale silently the next time a fixture is added.
 *
 * The list is kept rather than deleted because that same test spans all three: a fixture added
 * later that does NOT derive belongs here, on screen, rather than being quietly absent — the same
 * reason fixtures/expectations.json omits a file instead of hiding it.
 *
 * The rule for any future entry is unchanged, and it is the reason this docstring is a rule
 * rather than a narrative: **the reason must be measured by actually running `deriveSpec` against
 * that fixture's emitted output**, never inferred from the spec or the emitter. Three successive
 * versions of this comment described gaps that had already closed — a claim that rest-kit's frame
 * never matched, which stopped being true when src/derive/server/index.ts grew its rest-kit
 * branch; a claim that the factory const stayed unclaimed, which stopped being true when
 * tools-rest.ts split into `recognizeRestRegistrar` and `recognizeRestTools`; and a
 * "client-credentials auth" entry whose stated authority was a `recognizeOne` docstring that Task
 * 8 rewrote. Each time, the task closing the gap edited the LIST and left the prose.
 *
 * Which recognizer unblocked which fixture is recorded where it can go stale visibly instead —
 * beside the fixture, in ROUND_TRIP's and PARTIAL_ROUND_TRIP's own docstrings above.
 */
const BLOCKED: Record<string, string> = {};

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
    expect(listed).toHaveLength(new Set(listed).size);
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
