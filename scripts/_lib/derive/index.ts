import { type AstNode, parseModule } from "./ast.ts";
import { type Blocker, blockerFor } from "./blockers.ts";
import { createClaimSet } from "./claims.ts";
import { deriveManifest, type ManifestFields } from "./manifest.ts";
import { recognizeEnv } from "./server/env.ts";
import { recognizeFetchHelper } from "./server/fetch-helper.ts";
import { recognizeFrame } from "./server/index.ts";
import { recognizeTools } from "./server/tools-hand.ts";

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
    return blocked("no-frame", "src/server.ts is not the hand-rolled frame");
  }

  const env = recognizeEnv(statements, claims);
  const fetchHelper = recognizeFetchHelper(statements, claims);
  const tools = recognizeTools(statements, claims);

  const unclaimed = claims.unclaimed(statements);
  if (unclaimed.length > 0) {
    return { ok: false, blockers: unclaimed.map((n) => blockerFor(n, files.server)) };
  }
  if (fetchHelper === undefined) {
    return blocked("no-fetch-helper", "no read helper recognized");
  }
  if (tools === undefined) {
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
      style: "hand-rolled",
      network: manifest.network,
      ...(manifest.id === undefined ? {} : { id: manifest.id }),
      ...(manifest.filesystem === undefined ? {} : { filesystem: manifest.filesystem }),
      syncInterval: manifest.syncInterval,
      minNimbusVersion: manifest.minNimbusVersion,
      env,
      fetchHelper: helper,
      tools,
    },
  };
}
