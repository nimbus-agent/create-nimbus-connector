import { type AstNode, parseModule } from "./ast.ts";
import { type Blocker, blockerFor } from "./blockers.ts";
import { createClaimSet } from "./claims.ts";
import { deriveManifest, type ManifestFields } from "./manifest.ts";
import { recognizeEnv } from "./server/env.ts";
import { recognizeFetchHelper, recognizeRestFetchHelper } from "./server/fetch-helper.ts";
import { recognizeFrame } from "./server/index.ts";
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
    return blocked("no-frame", "src/server.ts is not a recognized frame");
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

    return {
      ok: true,
      spec: {
        name: frame.name,
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
