import { capitalize } from "../../../src/spec.ts";
import { type AstNode, parseModule } from "./ast.ts";
import { type Blocker, blockerFor } from "./blockers.ts";
import { createClaimSet } from "./claims.ts";
import { deriveManifest, type ManifestFields } from "./manifest.ts";
import { recognizeEnv } from "./server/env.ts";
import { recognizeFetchHelper, recognizeRestFetchHelper } from "./server/fetch-helper.ts";
import { frameFailureKind, recognizeFrame } from "./server/index.ts";
import { recognizeTools } from "./server/tools-hand.ts";
import { recognizeRestRegistrar, recognizeRestTools } from "./server/tools-rest.ts";

export type SourceFiles = { server: string; manifest: string };

export type Derivation =
  | { ok: true; spec: Record<string, unknown> }
  | { ok: false; blockers: Blocker[] };

function blocked(kind: string, detail: string): Derivation {
  return { ok: false, blockers: [{ kind, detail, line: 0 }] };
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
 * Derive a spec object from one connector's source, or report what stopped it.
 *
 * The totality rule is the last step and it has no exceptions: every top-level statement must be
 * covered by some recognizer's claim. There is no "ignore the rest" path, because a scrape that
 * ignores what it does not recognize reports silence as absence — the method that produced three
 * consecutive wrong reach numbers.
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

  // rest-kit's tool registrar and fetch helper are both a different shape from hand-rolled/
  // read-only-kit's (recognizeRestRegistrar+recognizeRestTools vs recognizeTools,
  // recognizeRestFetchHelper vs recognizeFetchHelper — see their own docstrings) and it emits
  // no env accessors at all (emitServer gates renderEnvAccessors on isHandStyle), so the two
  // styles are assembled in separate branches rather than threading a style check through
  // recognizeEnv/recognizeFetchHelper/recognizeTools's shared call sites.
  if (frame.style === "rest-kit") {
    const registrar = recognizeRestRegistrar(frame.toolStatements, claims);
    // recognizeRestTools needs the registrar's own name to know which calls are its
    // registrations — nothing to search for without it, so tools stays undefined rather than
    // scanning for a name that was never recognized.
    const tools =
      registrar === undefined
        ? undefined
        : recognizeRestTools(frame.toolStatements, claims, registrar.registrar);
    const restFetchHelper = recognizeRestFetchHelper(frame.verifyStatements, claims);

    // Same totality rule as the shared path below, checked before either recognizer's own
    // "undefined" case: an unclaimed statement (a bespoke `reg()` call, a helper function
    // neither recognizer models, a query-branch tool) blocks the module on its own bucket
    // rather than falling through to the generic "unrecognized-handler" blocked() below.
    const unclaimed = claims.unclaimed(frame.verifyStatements);
    if (unclaimed.length > 0) {
      return { ok: false, blockers: unclaimed.map((n) => blockerFor(n, files.server)) };
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
        tools,
      },
    };
  }

  const env = recognizeEnv(frame.verifyStatements, claims);
  const fetchHelper = recognizeFetchHelper(frame.verifyStatements, claims);
  const toolsResult = recognizeTools(frame.toolStatements, claims);

  // The totality rule walks frame.verifyStatements, NOT `statements`. For read-only-kit those
  // differ by exactly one statement — the wrapper, replaced by its callback body — which is what
  // stops the registrations inside it from inheriting coverage from a claim on the wrapper.
  const unclaimed = claims.unclaimed(frame.verifyStatements);
  if (unclaimed.length > 0) {
    return { ok: false, blockers: unclaimed.map((n) => blockerFor(n, files.server)) };
  }
  if (fetchHelper === undefined) {
    return blocked("no-fetch-helper", "no read helper recognized");
  }
  if (toolsResult === undefined) {
    return blocked("unrecognized-handler", "a reg() handler was not understood");
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
      tools: toolsResult.tools,
    },
  };
}
