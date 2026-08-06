import { capitalize, type StaticPathStyle } from "../spec.ts";
import { type AstNode, parseModule } from "./ast.ts";
import { type Blocker, blockerFor } from "./blockers.ts";
import { type ClaimSet, createClaimSet } from "./claims.ts";
import { deriveManifest, type ManifestFields } from "./manifest.ts";
import { recognizeSearchFilter } from "./search-filter.ts";
import type { SchemaShape } from "./server/args.ts";
import { recognizeEnv } from "./server/env.ts";
import { recognizeFetchHelper, recognizeRestFetchHelper } from "./server/fetch-helper.ts";
import type { Frame } from "./server/frame.ts";
import { frameFailureKind, recognizeFrame } from "./server/index.ts";
import type { BasePrefix } from "./server/query.ts";
import { claimSearchImports, type SearchToolFields } from "./server/search.ts";
import { recognizeTools, type ToolFields } from "./server/tools-hand.ts";
import { recognizeRestRegistrar, recognizeRestTools } from "./server/tools-rest.ts";

/**
 * `filter` is `src/search-filter.ts`'s text, supplied whenever the directory being read has one
 * — `undefined` for a connector that never declares a search tool. An absent filter file
 * alongside a RECOGNIZED search tool is a blocker (see `deriveSharedStyleSpec`), not a silent
 * omission: a search tool whose filter cannot be read must not derive a spec that regenerates a
 * connector with a different filter.
 */
export type SourceFiles = { server: string; manifest: string; filter?: string };

/** A shape recognized by `recognizeSearchTool` rather than `recognizeOne` — see `SearchToolFields`'s own docstring for why `impl` is the discriminant. */
function isSearchTool(t: ToolFields | SearchToolFields): t is SearchToolFields {
  return (t as SearchToolFields).impl === "search";
}

export type Derivation =
  | { ok: true; spec: Record<string, unknown>; $effectAmbiguity?: string[] }
  | { ok: false; blockers: Blocker[] };

function blocked(kind: string, detail: string): Derivation {
  return { ok: false, blockers: [{ kind, detail, line: 0 }] };
}

/**
 * `effect` is NOT uniquely recoverable, and this function does not pretend otherwise.
 *
 * src/emit/manifest.ts computes hitlRequired as the deduplicated SET of non-read effects, and
 * src/server.ts does not depend on `effect` at all — so every attribution producing the observed
 * set emits identical bytes, and the byte-compare cannot tell a right one from a wrong one. The
 * corpus proves the ambiguity is real rather than theoretical: `dagster` POSTs GraphQL queries
 * and `ramp` POSTs to exchange an OAuth token, neither of which is a write.
 *
 * So: attribute the effect the method suggests, ONLY to tools that can carry it, and refuse when
 * the observed set cannot be reproduced. --from-connector reports the attribution as unverified,
 * because for its purposes — a spec a human will edit — semantically wrong is a real cost even
 * when byte-identical.
 */
export type EffectAttribution = {
  tools: Record<string, unknown>[];
  /**
   * Effects assigned to MORE THAN ONE tool, and therefore not forced by the evidence. With a
   * single candidate the attribution is the only one reproducing the observed set, so it is
   * correct; with several, at least one carries the effect and this function cannot say which.
   */
  ambiguous: string[];
};

export function attributeEffects(
  tools: readonly Record<string, unknown>[],
  hitlRequired: readonly string[],
): EffectAttribution | undefined {
  const wanted = new Set(hitlRequired);
  const out = tools.map((t) => {
    const method = t.method;
    if (method === "DELETE" && wanted.has("delete")) return { ...t, effect: "delete" };
    if (typeof method === "string" && method !== "GET" && wanted.has("write")) {
      return { ...t, effect: "write" };
    }
    return { ...t };
  });
  // The set the emitter would now compute must equal the one observed, in both directions.
  const counts = new Map<string, number>();
  for (const t of out) {
    const e = t.effect;
    if (typeof e === "string") counts.set(e, (counts.get(e) ?? 0) + 1);
  }
  if (counts.size !== wanted.size) return undefined;
  for (const e of wanted) {
    if (!counts.has(e)) return undefined;
  }
  return {
    tools: out,
    ambiguous: [...counts].filter(([, n]) => n > 1).map(([e]) => e),
  };
}

/**
 * `registrarName`'s sanitizing formula (src/spec.ts), mirrored rather than called: that function
 * takes a full `ConnectorSpec`, and constructing one here for a single-field read would need a
 * cast this module's accessors are built specifically to avoid (see read.ts's own header).
 * `capitalize` (src/spec.ts) IS imported rather than mirrored, deliberately — it is not a full
 * title-case (it upper-cases only the first character, e.g. capitalize("google-meet") ->
 * "Google-meet", hyphen and all), a shape non-obvious enough that reimplementing it here would
 * risk exactly the class of drift this task already found twice.
 *
 * Both are cited by SYMBOL, not by line: this docstring carried `src/spec.ts:745-746` and
 * `740-741` for them, and both had drifted (to 779-781 and 774-776) by the time anyone checked.
 * A line number is a citation that goes stale silently, which is the one thing a citation must
 * not do.
 */
function registrarNameFor(title: string): string {
  return `register${title.replaceAll(/[^A-Za-z0-9]/g, "")}Tool`;
}

/**
 * `register<X>Tool` -> the spec `title` that reproduces it exactly, or `undefined` (refuse) when
 * none does.
 *
 * The registrar's own name is a spec-derived identifier (`registrarName`, computed from
 * `spec.title` — not a `local` field a spec sets directly), and `deriveSpec` used to recover it
 * and then discard it, deriving `ok: true` for any rest-kit module regardless of whether the
 * name it actually carries is reproducible at all: a review demonstrated that renaming
 * `zzstandalone`'s registrar to `registerZzTool` in its own emitted `server.ts` still derived
 * successfully, and re-emitting wrote `registerZzstandaloneTool` back — a different file, from a
 * `deriveSpec` whose contract is "a derived spec or a named blocker," never a spec for a module
 * it provably cannot regenerate.
 *
 * Inverting is strictly better than refusing outright on sight of a non-default name — three
 * corpus connectors this task newly frames (`registerCciTool`, `registerGhaTool`,
 * `registerPdTool`) use exactly this idiom, and Task 6 makes their registrar axis live — but the
 * inversion is VERIFIED here, not trusted from the regex capture alone: a greedy `.+` is not
 * provably a perfect inverse for every input (an underscore or `$` inside the captured group,
 * legal in a JS identifier, sanitizes away when `registrarNameFor` re-encodes it, so the round
 * trip silently fails for exactly the inputs where blind trust would have been wrong). Checked
 * in two steps, either of which can succeed:
 *
 *   1. The schema's own default (`capitalize(name)`) already reproduces the observed name — the
 *      common case (`zzstandalone`, and any spec whose author never set a custom `title`) — so
 *      `{ title: undefined }` lets the derived spec omit `title` and stay minimal. This is
 *      checked FIRST specifically so a default-shaped registrar can never be second-guessed into
 *      an unnecessary explicit `title`.
 *   2. The literal recovered fragment reproduces it -> `{ title: <recovered> }`.
 *
 * Neither reproducing it exactly is a refusal (`undefined`), not a partial derivation.
 */
function recognizeRestTitle(
  observedRegistrar: string,
  name: string,
): { title: string | undefined } | undefined {
  const match = /^register(.+)Tool$/.exec(observedRegistrar);
  if (match === null) return undefined;
  const recovered = match[1]!;

  if (registrarNameFor(capitalize(name)) === observedRegistrar) return { title: undefined };
  if (registrarNameFor(recovered) === observedRegistrar) return { title: recovered };
  return undefined;
}

/**
 * `staticPathStyle` from the SET of tools whose path is fully static — the only ones that carry
 * evidence at all.
 *
 * A static path renders `"…"` under `quoted` and `` `…` `` under `template`, and Biome never
 * rewrites one into the other (unlike `argsSchemaStyle` below, there is no reformatting hazard
 * here), so every tool that recognizePath reports a `staticStyle` for is unambiguous evidence of
 * the connector's own convention. A tool with a dynamic path abstains — `recognizePath` leaves
 * `staticStyle` unset for one (src/emit/server/path-template.ts's `RenderContext.staticStyle`:
 * it "has no effect on a path with any dynamic segment", so the emitter's choice is invisible on
 * that tool) — and abstaining tools neither vote nor block.
 *
 * Two DECISIVE tools disagreeing is a module this emitter cannot have written — it writes one
 * value per connector, never per tool — so that case reports `ok: false` rather than picking a
 * winner; the caller turns it into `blocked("style:mixed-static-path", …)`.
 */
export function voteStaticPathStyle(
  styles: readonly (StaticPathStyle | undefined)[],
): { ok: true; value: StaticPathStyle | undefined } | { ok: false } {
  const decisive = styles.filter((s): s is StaticPathStyle => s !== undefined);
  if (new Set(decisive).size > 1) return { ok: false };
  return { ok: true, value: decisive[0] };
}

/**
 * `argsSchemaStyle` from the SET of emitted arg schemas. Asymmetric on purpose — an earlier
 * draft of this recognizer voted symmetrically (multi-line -> "expanded" the same way a
 * one-liner -> "inline") and that was wrong, measured against the fixtures, not merely
 * suspected.
 *
 * A one-line non-empty `z.object({ … })` is decisive: `renderZodSchema`'s expanded branch
 * (src/emit/server/args.ts) always writes one field per line, so it can NEVER produce a
 * one-liner for a non-empty object — seeing one proves "inline" outright.
 *
 * Multi-line is NOT the mirror of that. Biome (`lineWidth: 100`) re-wraps an over-long inline
 * schema into bytes byte-identical to the expanded form, so "every schema this connector emits
 * is multi-line" is consistent with either "expanded", or "inline" where every schema happened
 * to be too long to stay on one line. Voting "expanded" in that case is nonetheless byte-safe —
 * measured, not assumed: `test/derive/style-recovery.test.ts`'s Step 6b check forces this vote's
 * output back onto every one of the 21 fixtures and requires byte-identical re-emission. Forcing
 * `argsSchemaStyle: "expanded"` on an inline connector whose schemas are all wrapped (zzsearch,
 * zzwriterest) reproduces the original bytes; discord and google-meet carry a short schema that
 * stayed a one-liner, so the decisive rule above catches those before the multi-line fallback
 * would ever run.
 *
 * `propertyCount === 0` (an empty `z.object({})`, identical under both styles) is excluded from
 * `nonEmpty` and never votes either way. Unlike `voteStaticPathStyle`, this never blocks: a
 * single one-liner settles the question outright, so there is no disagreement case to refuse.
 */
export function voteArgsSchemaStyle(
  schemas: readonly SchemaShape[],
): "inline" | "expanded" | undefined {
  const nonEmpty = schemas.filter((s) => s.propertyCount > 0);
  if (nonEmpty.some((s) => s.oneLine)) return "inline";
  if (nonEmpty.length > 0) return "expanded";
  return undefined;
}

/**
 * Every query tool's `new URL(...)` was rendered with `baseExpr(spec)` (src/emit/server/
 * fetch-helper.ts) spliced in as a prefix, so each one must agree with the fetch helper this same
 * module declares — and, for the literal form, the base has to come back OFF the recovered path
 * before it can be a spec `path` again.
 *
 * Both happen HERE rather than inside `recognizeQueryBlock`, and not only because the tool
 * recognizers run before `recognizeRestFetchHelper` and take no helper metadata. Two recognizers
 * producing the base independently is how they drift; comparing them in the caller is the same
 * guard `rest-fetch-helper-name-mismatch` below applies, for the same reason. And the literal
 * split is not merely inconvenient to do earlier — it is not DECIDABLE earlier: `renderPath`
 * fuses the base onto the path's first literal segment with nothing between them, a base may
 * itself carry a path component, and a query tool's path must start with "/" — so several splits
 * of that quasi are byte-identical and only the fetch helper's own `base` says which is right.
 * See `BasePrefix`.
 *
 * `helper.base` is already in `baseExpr`'s own terms for a rest-kit connector: the schema's
 * rest-kit refine (src/spec.ts) rejects any `${env.X}` in `fetchHelper.base`, so `resolveEnvRefs`
 * is the identity on it and no second normalizer is needed there.
 *
 * The HAND-ROLLED caller has no such refine — `${env.X}` in `base` is legal for it — and this
 * function is what REFUSES that combination rather than mis-splitting it. `baseExpr` resolves the
 * reference, so `base: "https://${env.HOST}/api"` reaches `new URL` as
 * `` `https://${HOST()}/api/v1/items` ``, whose leading quasi is "https://" — and `base` still
 * spells the accessor as `${env.HOST}`, which no rendered quasi can ever contain (a path's own
 * `${` is rejected by `parsePathTemplate`'s `assertNoUnparsedPlaceholders`). `startsWith` is
 * therefore false for every env-ref base with text ahead of the accessor, and one with none
 * (`base: "${env.HOST}"`) never reaches here at all: `prefixedPath` refuses an empty leading
 * quasi whose first expression is a call rather than a base const. Both halves are deliberate —
 * see `prefixedPath`'s own comment — because a base that is decided per REQUEST is not one this
 * recognizer can split off a template statically.
 */
function rebaseQueryTools<T extends { readonly path: string }>(
  tools: readonly T[],
  prefixes: readonly (BasePrefix | undefined)[],
  helper: { readonly base: string; readonly baseConst?: string },
): T[] | undefined {
  const out: T[] = [];
  for (const [i, tool] of tools.entries()) {
    const prefix = prefixes[i];
    if (prefix === undefined) {
      out.push(tool);
      continue;
    }
    if (prefix.kind === "const") {
      if (prefix.name !== helper.baseConst) return undefined;
      out.push(tool);
      continue;
    }
    // The base must lie wholly inside the leading quasi — it cannot span a `${…}`. Testing the
    // quasi rather than the recovered path is what keeps a base longer than that quasi from
    // matching by running on into a placeholder's rendered text.
    if (helper.baseConst !== undefined || !prefix.leadingQuasi.startsWith(helper.base)) {
      return undefined;
    }
    out.push({ ...tool, path: tool.path.slice(helper.base.length) });
  }
  return out;
}

/**
 * The rest-kit assembly.
 *
 * rest-kit's tool registrar and fetch helper are both a different shape from hand-rolled/
 * read-only-kit's (recognizeRestRegistrar+recognizeRestTools vs recognizeTools,
 * recognizeRestFetchHelper vs recognizeFetchHelper — see their own docstrings) and it emits
 * no env accessors at all (emitServer gates renderEnvAccessors on isHandStyle), so the two
 * styles are assembled in separate functions rather than threading a style check through
 * recognizeEnv/recognizeFetchHelper/recognizeTools's shared call sites. `deriveSpec` dispatches
 * on `frame.style` and does nothing else with either result.
 */
function deriveRestKitSpec(
  frame: Frame,
  claims: ClaimSet,
  manifest: ManifestFields,
  serverSource: string,
): Derivation {
  const registrar = recognizeRestRegistrar(frame.toolStatements, claims);
  // recognizeRestTools needs the registrar's own name to know which calls are its
  // registrations — nothing to search for without it, so tools stays undefined rather than
  // scanning for a name that was never recognized.
  const tools =
    registrar === undefined
      ? undefined
      : recognizeRestTools(frame.toolStatements, claims, registrar.registrar);
  const restFetchHelper = recognizeRestFetchHelper(frame.verifyStatements, claims);

  // Same totality rule as the shared path in deriveSharedStyleSpec, checked before either
  // recognizer's own "undefined" case: an unclaimed statement (a bespoke `reg()` call, a helper
  // function neither recognizer models, a query-branch tool) blocks the module on its own bucket
  // rather than falling through to the generic "unrecognized-handler" blocked() below.
  const unclaimed = claims.unclaimed(frame.verifyStatements);
  if (unclaimed.length > 0) {
    return { ok: false, blockers: unclaimed.map((n) => blockerFor(n, serverSource)) };
  }
  if (registrar === undefined || tools === undefined || restFetchHelper === undefined) {
    return blocked(
      "unrecognized-handler",
      "a rest-kit registrar, its calls, or its fetch helper were not understood",
    );
  }

  // The factory's `fetch:` property (registrar.fetchLocal) and the recognized fetch-helper
  // function's own name (restFetchHelper.local) are recovered by two separate recognizers
  // that never cross-check each other's output — a module naming a DIFFERENT function in the
  // factory than the one actually recognized (e.g. `fetch: fetch`, the global) would
  // otherwise derive `ok: true` for a spec whose emitted factory calls a name the derived
  // `fetchHelper.local` does not match, same "claimed but not reproducible" defect class as
  // the registrar name below.
  if (registrar.fetchLocal !== restFetchHelper.local) {
    return blocked(
      "rest-fetch-helper-name-mismatch",
      `the factory names fetch helper "${registrar.fetchLocal}", but the recognized fetch ` +
        `helper function is named "${restFetchHelper.local}"`,
    );
  }

  // The same class of guard as the name mismatch above, one recognizer further along: the query
  // tools' base prefixes and the fetch helper's own base are recovered independently and have to
  // agree. See `rebaseQueryTools`, which also finishes a literal prefix's path.
  const rebasedTools = rebaseQueryTools(tools.tools, tools.basePrefixes, restFetchHelper);
  if (rebasedTools === undefined) {
    return blocked(
      "query:base-prefix-mismatch",
      "a query tool's new URL(...) prefix is not the base this module's fetch helper declares",
    );
  }

  const titleRecovery = recognizeRestTitle(registrar.registrar, frame.name);
  if (titleRecovery === undefined) {
    return blocked(
      "unrecognized-registrar-name",
      `"${registrar.registrar}" does not correspond to any title that reproduces it — ` +
        "registrarName() would emit a different const name than the module's own",
    );
  }

  // Tools disagreeing on a connector-wide convention their own emitter can only have written
  // one value for — see voteStaticPathStyle's own docstring for why this is a refusal rather
  // than a pick.
  const staticVote = voteStaticPathStyle(tools.staticPathStyles);
  if (!staticVote.ok) {
    return blocked(
      "style:mixed-static-path",
      "tools disagree on whether a fully static path renders quoted or as a template literal",
    );
  }
  const argsSchemaStyle = voteArgsSchemaStyle(tools.schemaShapes);

  // Last, because it is a different kind of refusal from everything above — every earlier
  // check is "this shape was not recognized"; this one is "the shape WAS recognized, but no
  // attribution of it reproduces what the manifest declares".
  const attribution = attributeEffects(rebasedTools, manifest.hitlRequired);
  if (attribution === undefined) {
    return blocked(
      "manifest:unattributable-hitl",
      `hitlRequired ${JSON.stringify(manifest.hitlRequired)} is not reproduced by any ` +
        "attribution of this connector's tool methods",
    );
  }

  return {
    ok: true,
    spec: {
      name: frame.name,
      ...(titleRecovery.title === undefined ? {} : { title: titleRecovery.title }),
      displayName: manifest.displayName,
      description: manifest.description,
      serviceLabel: registrar.serviceLabel,
      style: frame.style,
      // Emitted only when it differs from ConnectorSpecSchema's "inline" default, so a
      // connector using the default stays byte-comparable with the hand-written fixtures.
      ...(argsSchemaStyle === undefined || argsSchemaStyle === "inline" ? {} : { argsSchemaStyle }),
      network: manifest.network,
      ...(manifest.id === undefined ? {} : { id: manifest.id }),
      ...(manifest.filesystem === undefined ? {} : { filesystem: manifest.filesystem }),
      syncInterval: manifest.syncInterval,
      minNimbusVersion: manifest.minNimbusVersion,
      // The single entry ConnectorSpecSchema's rest-kit refine requires: one var, auth
      // "bearer". `local` names nothing the emitted source calls — rest-kit's
      // makeRestToolRegistrar resolves the credential itself via requireProcessEnv(tokenEnv)
      // — so its value is unobservable in the emitted bytes; any valid identifier round-trips
      // identically, and this one is chosen only to read as what it is.
      env: [{ vars: [registrar.tokenEnv], local: "restAuthToken", auth: "bearer" }],
      fetchHelper: {
        local: restFetchHelper.local,
        base: restFetchHelper.base,
        ...(restFetchHelper.baseConst === undefined
          ? {}
          : { baseConst: restFetchHelper.baseConst }),
        ...(restFetchHelper.inlineHeaders === undefined
          ? {}
          : { inlineHeaders: restFetchHelper.inlineHeaders }),
        // Emitted only when it differs from FetchHelperSchema's "quoted" default — same
        // reasoning as argsSchemaStyle above.
        ...(staticVote.value === undefined || staticVote.value === "quoted"
          ? {}
          : { staticPathStyle: staticVote.value }),
      },
      tools: attribution.tools,
    },
    ...(attribution.ambiguous.length > 0 ? { $effectAmbiguity: attribution.ambiguous } : {}),
  };
}

/**
 * The hand-rolled and read-only-kit assembly — one path, because the two styles differ only in
 * the frame that got them here (see `Frame`'s two statement lists), not in the env accessors,
 * fetch helper or `reg()` handlers those recognizers then read.
 */
function deriveSharedStyleSpec(
  frame: Frame,
  claims: ClaimSet,
  manifest: ManifestFields,
  serverSource: string,
  filterSource: string | undefined,
): Derivation {
  const env = recognizeEnv(frame.verifyStatements, claims);
  const recognizedHelper = recognizeFetchHelper(frame.verifyStatements, claims);
  // recognizedHelper?.fields.local, not a non-null assertion: recognizeTools must be able to run
  // (and refuse) even when the fetch helper itself was never recognized. Checked below, AFTER the
  // totality rule — see this function's own comment on that ordering — rather than
  // short-circuited here, so an unrecognized fetch helper still surfaces as a named,
  // per-statement blocker instead of the coarse "no-fetch-helper" case.
  const toolsResult = recognizeTools(frame.toolStatements, claims, recognizedHelper?.fields.local);

  // Claim the two search-specific imports only once a search tool is positively recognized —
  // the same scoping recognizeReadOnlyFrame uses for its own frame imports (server/index.ts).
  // Unconditional claiming would let a non-search module have an unrelated import claimed; an
  // import this cannot then match stays unclaimed and is reported by the totality rule below,
  // exactly like any other unrecognized statement.
  const searchTools = (toolsResult?.tools ?? []).filter(isSearchTool);
  if (searchTools.length > 0) {
    claimSearchImports(frame.verifyStatements, claims, searchTools);
  }

  // The totality rule walks frame.verifyStatements, NOT the module's own statement list. For
  // read-only-kit those differ by exactly one statement — the wrapper, replaced by its callback
  // body — which is what stops the registrations inside it from inheriting coverage from a claim
  // on the wrapper.
  const unclaimed = claims.unclaimed(frame.verifyStatements);
  if (unclaimed.length > 0) {
    return { ok: false, blockers: unclaimed.map((n) => blockerFor(n, serverSource)) };
  }
  if (recognizedHelper === undefined) {
    return blocked("no-fetch-helper", "no read helper recognized");
  }
  if (toolsResult === undefined) {
    return blocked("unrecognized-handler", "a reg() handler was not understood");
  }
  const fetchHelper = recognizedHelper.fields;

  // `hasQueryTool` (src/emit/server/fetch-helper.ts) decides the read helper's passthrough line
  // from the SET of tools, so the two must agree in both directions. A helper with the line and
  // no query tool regenerates a helper without it; a query tool with no line regenerates one with
  // it. Either way the derived spec would not reproduce this module — the wrong-claim class,
  // caught here because neither recognizer can see the other's evidence on its own.
  // `query` is read off the union without narrowing on purpose: `SearchToolFields` extends
  // `ToolFields`, so the field is there for both, and a search tool never carries one anyway
  // (ToolSchema rejects `impl: "search"` beside `query`). Guarding it would state the opposite.
  const anyQuery = toolsResult.tools.some((t) => t.query !== undefined);
  if (anyQuery !== recognizedHelper.passthrough) {
    return blocked(
      "fetch-helper:query-passthrough-mismatch",
      `the read helper ${recognizedHelper.passthrough ? "carries" : "lacks"} the absolute-URL ` +
        `passthrough line, but ${anyQuery ? "a tool declares" : "no tool declares"} a query array`,
    );
  }

  // The same class of guard, one recognizer further along: the query tools' base prefixes and the
  // fetch helper's own base are recovered independently and have to agree. See `rebaseQueryTools`,
  // which also finishes a literal prefix's path — and which is where an `${env.X}` base, legal for
  // this style but not for rest-kit, is refused rather than mis-split.
  const rebasedTools = rebaseQueryTools(toolsResult.tools, toolsResult.basePrefixes, fetchHelper);
  if (rebasedTools === undefined) {
    return blocked(
      "query:base-prefix-mismatch",
      "a query tool's new URL(...) prefix is not the base this module's fetch helper declares",
    );
  }

  // A search tool whose filter file cannot be read must not derive a spec that regenerates a
  // connector with a different filter — an absent file alongside a recognized search tool is a
  // blocker, not a silent omission. `title` is folded in here too: the type alias
  // (`export type <Title>SearchMatchOptions = SearchMatchOptions;`) is the only place this
  // style's `spec.title` is recoverable at all (rest-kit recovers it from the registrar name
  // instead, in deriveRestKitSpec below) — so it stays unset for every connector with no search
  // tool, unchanged from before this task.
  let tools: (ToolFields | SearchToolFields)[] = rebasedTools;
  let title: string | undefined;
  if (searchTools.length > 0) {
    if (filterSource === undefined) {
      return blocked(
        "missing-file:src/search-filter.ts",
        "a search tool was recognized but no filter file was supplied",
      );
    }
    const filterDerivation = recognizeSearchFilter(filterSource);
    if (!filterDerivation.ok) return { ok: false, blockers: filterDerivation.blockers };

    const wanted = new Set(searchTools.map((t) => t.filter.export));
    const available = new Set(filterDerivation.result.filters.map((f) => f.export));
    const sameSet = wanted.size === available.size && [...wanted].every((e) => available.has(e));
    if (!sameSet) {
      return blocked(
        "search-filter:mismatch",
        `search tools declare filter exports ${JSON.stringify([...wanted])}, but ` +
          `src/search-filter.ts declares ${JSON.stringify([...available])}`,
      );
    }

    const filterByExport = new Map(filterDerivation.result.filters.map((f) => [f.export, f]));
    tools = rebasedTools.map((t) => {
      if (!isSearchTool(t)) return t;
      const recovered = filterByExport.get(t.filter.export);
      return {
        ...t,
        filter: {
          export: t.filter.export,
          ...(recovered?.fields === undefined ? {} : { fields: recovered.fields }),
        },
      };
    });

    // Omitted when it reproduces ConnectorSpecSchema's own default (`capitalize(name)`), so a
    // connector whose author never set a custom `title` stays byte-comparable with the
    // hand-written fixtures — same reasoning as recognizeRestTitle's Step 1 below.
    const defaultTitle = capitalize(frame.name);
    title =
      filterDerivation.result.titleFragment === defaultTitle
        ? undefined
        : filterDerivation.result.titleFragment;
  }

  // Tools disagreeing on a connector-wide convention their own emitter can only have written
  // one value for — see voteStaticPathStyle's own docstring for why this is a refusal rather
  // than a pick.
  const staticVote = voteStaticPathStyle(toolsResult.staticPathStyles);
  if (!staticVote.ok) {
    return blocked(
      "style:mixed-static-path",
      "tools disagree on whether a fully static path renders quoted or as a template literal",
    );
  }
  const argsSchemaStyle = voteArgsSchemaStyle(toolsResult.schemaShapes);

  // Last, because it is a different kind of refusal from everything above — every earlier
  // check is "this shape was not recognized"; this one is "the shape WAS recognized, but no
  // attribution of it reproduces what the manifest declares".
  const attribution = attributeEffects(tools, manifest.hitlRequired);
  if (attribution === undefined) {
    return blocked(
      "manifest:unattributable-hitl",
      `hitlRequired ${JSON.stringify(manifest.hitlRequired)} is not reproduced by any ` +
        "attribution of this connector's tool methods",
    );
  }

  const { serviceLabel, ...helper } = fetchHelper;
  return {
    ok: true,
    spec: {
      name: frame.name,
      ...(title === undefined ? {} : { title }),
      displayName: manifest.displayName,
      description: manifest.description,
      serviceLabel,
      style: frame.style,
      // handlerStyle is top-level (ConnectorSpecSchema), not per-tool — recognizeTools
      // recovers it from the SET of recognized tools; see its docstring for the rule.
      // Omitted lets the schema's `.default("concise")` apply.
      ...(toolsResult.handlerStyle === undefined ? {} : { handlerStyle: toolsResult.handlerStyle }),
      // Emitted only when it differs from ConnectorSpecSchema's "inline" default, so a
      // connector using the default stays byte-comparable with the hand-written fixtures.
      ...(argsSchemaStyle === undefined || argsSchemaStyle === "inline" ? {} : { argsSchemaStyle }),
      network: manifest.network,
      ...(manifest.id === undefined ? {} : { id: manifest.id }),
      ...(manifest.filesystem === undefined ? {} : { filesystem: manifest.filesystem }),
      syncInterval: manifest.syncInterval,
      minNimbusVersion: manifest.minNimbusVersion,
      env,
      fetchHelper: {
        ...helper,
        // Emitted only when it differs from FetchHelperSchema's "quoted" default — same
        // reasoning as argsSchemaStyle above.
        ...(staticVote.value === undefined || staticVote.value === "quoted"
          ? {}
          : { staticPathStyle: staticVote.value }),
      },
      tools: attribution.tools,
    },
    ...(attribution.ambiguous.length > 0 ? { $effectAmbiguity: attribution.ambiguous } : {}),
  };
}

/**
 * Derive a spec object from one connector's source, or report what stopped it.
 *
 * The totality rule is the last step and it has no exceptions: every top-level statement must be
 * covered by some recognizer's claim. There is no "ignore the rest" path, because a scrape that
 * ignores what it does not recognize reports silence as absence — the method that produced three
 * consecutive wrong reach numbers. It is enforced inside each style's assembly, on that style's
 * own `frame.verifyStatements`, before any recognizer's "undefined" case is reported.
 *
 * The returned spec is RAW, not parsed. parseSpec and validateSpec are the `emits` tier
 * boundary and run in the reporting layer, so a derived spec that trips RESERVED_IDENTIFIERS is
 * counted rather than thrown.
 */
export function deriveSpec(files: SourceFiles): Derivation {
  let manifest: ManifestFields;
  try {
    manifest = deriveManifest(files.manifest);
  } catch (err) {
    return blocked("no-manifest", err instanceof Error ? err.message : String(err));
  }

  let statements: AstNode[];
  try {
    statements = parseModule(files.server);
  } catch (err) {
    return blocked("parse-error", err instanceof Error ? err.message : String(err));
  }

  const claims = createClaimSet();
  const frame = recognizeFrame(statements, claims);
  if (frame === undefined) {
    return blocked(frameFailureKind(statements), "src/server.ts is not a recognized frame");
  }

  return frame.style === "rest-kit"
    ? deriveRestKitSpec(frame, claims, manifest, files.server)
    : deriveSharedStyleSpec(frame, claims, manifest, files.server, files.filter);
}
