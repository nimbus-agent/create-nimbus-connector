import { capitalize } from "../spec.ts";
import { type AstNode, parseModule } from "./ast.ts";
import { type Blocker, blockerFor } from "./blockers.ts";
import { type ClaimSet, createClaimSet } from "./claims.ts";
import { deriveManifest, type ManifestFields } from "./manifest.ts";
import { recognizeEnv } from "./server/env.ts";
import { recognizeFetchHelper, recognizeRestFetchHelper } from "./server/fetch-helper.ts";
import type { Frame } from "./server/frame.ts";
import { frameFailureKind, recognizeFrame } from "./server/index.ts";
import { recognizeTools } from "./server/tools-hand.ts";
import { recognizeRestRegistrar, recognizeRestTools } from "./server/tools-rest.ts";

export type SourceFiles = { server: string; manifest: string };

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
 * `registrarName`'s sanitizing formula (src/spec.ts:745-746), mirrored rather than called: that
 * function takes a full `ConnectorSpec`, and constructing one here for a single-field read
 * would need a cast this module's accessors are built specifically to avoid (see read.ts's own
 * header). `capitalize` (src/spec.ts:740-741) IS imported rather than mirrored, deliberately —
 * it is not a full title-case (it upper-cases only the first character, e.g.
 * capitalize("google-meet") -> "Google-meet", hyphen and all), a shape non-obvious enough that
 * reimplementing it here would risk exactly the class of drift this task already found twice.
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

  const titleRecovery = recognizeRestTitle(registrar.registrar, frame.name);
  if (titleRecovery === undefined) {
    return blocked(
      "unrecognized-registrar-name",
      `"${registrar.registrar}" does not correspond to any title that reproduces it — ` +
        "registrarName() would emit a different const name than the module's own",
    );
  }

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

  return {
    ok: true,
    spec: {
      name: frame.name,
      ...(titleRecovery.title === undefined ? {} : { title: titleRecovery.title }),
      displayName: manifest.displayName,
      description: manifest.description,
      serviceLabel: registrar.serviceLabel,
      style: frame.style,
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
        ...(restFetchHelper.inlineHeaders === undefined
          ? {}
          : { inlineHeaders: restFetchHelper.inlineHeaders }),
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
): Derivation {
  const env = recognizeEnv(frame.verifyStatements, claims);
  const fetchHelper = recognizeFetchHelper(frame.verifyStatements, claims);
  // fetchHelper?.local, not fetchHelper!.local: recognizeTools must be able to run (and refuse)
  // even when the fetch helper itself was never recognized. Checked below, AFTER the totality
  // rule — see this function's own comment on that ordering — rather than short-circuited here,
  // so an unrecognized fetch helper still surfaces as a named, per-statement blocker instead of
  // the coarse "no-fetch-helper" case.
  const toolsResult = recognizeTools(frame.toolStatements, claims, fetchHelper?.local);

  // The totality rule walks frame.verifyStatements, NOT the module's own statement list. For
  // read-only-kit those differ by exactly one statement — the wrapper, replaced by its callback
  // body — which is what stops the registrations inside it from inheriting coverage from a claim
  // on the wrapper.
  const unclaimed = claims.unclaimed(frame.verifyStatements);
  if (unclaimed.length > 0) {
    return { ok: false, blockers: unclaimed.map((n) => blockerFor(n, serverSource)) };
  }
  if (fetchHelper === undefined) {
    return blocked("no-fetch-helper", "no read helper recognized");
  }
  if (toolsResult === undefined) {
    return blocked("unrecognized-handler", "a reg() handler was not understood");
  }

  // Last, because it is a different kind of refusal from everything above — every earlier
  // check is "this shape was not recognized"; this one is "the shape WAS recognized, but no
  // attribution of it reproduces what the manifest declares".
  const attribution = attributeEffects(toolsResult.tools, manifest.hitlRequired);
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
      displayName: manifest.displayName,
      description: manifest.description,
      serviceLabel,
      style: frame.style,
      // handlerStyle is top-level (ConnectorSpecSchema), not per-tool — recognizeTools
      // recovers it from the SET of recognized tools; see its docstring for the rule.
      // Omitted lets the schema's `.default("concise")` apply.
      ...(toolsResult.handlerStyle === undefined ? {} : { handlerStyle: toolsResult.handlerStyle }),
      network: manifest.network,
      ...(manifest.id === undefined ? {} : { id: manifest.id }),
      ...(manifest.filesystem === undefined ? {} : { filesystem: manifest.filesystem }),
      syncInterval: manifest.syncInterval,
      minNimbusVersion: manifest.minNimbusVersion,
      env,
      fetchHelper: helper,
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
    : deriveSharedStyleSpec(frame, claims, manifest, files.server);
}
