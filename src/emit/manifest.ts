import type { ConnectorSpec } from "../spec.ts";
import type { GeneratedFile } from "../types.ts";

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
    hitlRequired: [] as string[],
    syncInterval: spec.syncInterval,
    minNimbusVersion: spec.minNimbusVersion,
  };
  return {
    path: ["nimbus.extension.json"],
    content: `${JSON.stringify(manifest, undefined, 2)}\n`,
  };
}
