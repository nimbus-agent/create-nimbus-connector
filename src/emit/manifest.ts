import type { ConnectorSpec } from "../spec.ts";
import type { GeneratedFile } from "../types.ts";

/**
 * The sorted unique set of non-read effects.
 *
 * Computed rather than declared: 32 of the 94 monorepo connectors have a hand-written
 * hitlRequired that disagrees with their tools, which is what a hand-maintained
 * capability list does over time.
 */
function hitlRequired(spec: ConnectorSpec): string[] {
  const effects = new Set(spec.tools.map((t) => t.effect).filter((e) => e !== "read"));
  return [...effects].sort();
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
