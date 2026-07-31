import type { ConnectorSpec } from "../spec.ts";
import type { GeneratedFile } from "../types.ts";

/**
 * The corpus's capability order — NOT alphabetical.
 *
 * Measured across all 94 monorepo manifests: 57 declare `[]`, 23 declare
 * `["write", "delete"]`, 14 declare `["write"]`. Not one declares `delete` first, so an
 * alphabetical `.sort()` — which yields `["delete", "write"]` — can never byte-reproduce
 * any of the 23 mutating connectors. The order is a fixed convention of the corpus, so it
 * is written down here as one rather than derived from a comparator that happens to agree.
 */
const CAPABILITY_ORDER = ["write", "delete"] as const;

/**
 * The unique set of non-read effects, in CAPABILITY_ORDER.
 *
 * Computed rather than declared: 32 of the 94 monorepo connectors have a hand-written
 * hitlRequired that disagrees with their tools, which is what a hand-maintained
 * capability list does over time.
 */
function hitlRequired(spec: ConnectorSpec): string[] {
  const effects = new Set(spec.tools.map((t) => t.effect).filter((e) => e !== "read"));
  return CAPABILITY_ORDER.filter((c) => effects.has(c));
}

export function emitManifest(spec: ConnectorSpec): GeneratedFile {
  const manifest = {
    id: spec.id,
    displayName: spec.displayName,
    version: "0.1.0",
    description: spec.description,
    author: "Nimbus",
    entrypoint: "dist/server.js",
    runtime: "bun",
    permissions: { network: spec.network },
    hitlRequired: hitlRequired(spec),
    syncInterval: spec.syncInterval,
    minNimbusVersion: spec.minNimbusVersion,
  };
  return {
    path: ["nimbus.extension.json"],
    content: `${JSON.stringify(manifest, undefined, 2)}\n`,
  };
}
