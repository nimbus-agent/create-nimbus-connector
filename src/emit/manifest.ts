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

/**
 * Collapse `permissions.filesystem` back onto one line.
 *
 * `JSON.stringify(x, undefined, 2)` breaks every nested object across lines and Biome's
 * JSON formatter preserves that break rather than collapsing it, so a plain serialisation
 * can only ever produce the four-line form. 27 of the 29 corpus manifests that declare
 * `permissions.filesystem` write it on one line; the other two are expanded, and this
 * emitter does not reach them.
 *
 * The block to replace is not guessed. It is re-derived from the same value with the same
 * serialiser, shifted from depth 1 to `permissions`'s depth 2, so it is exactly the
 * substring `JSON.stringify` just produced — no sentinel to collide with a description, and
 * no regex to drift from the serialiser's output. Biome puts the spaces back inside the
 * braces; only the line break is this function's business.
 *
 * The replacement is a FUNCTION, not a string, and that is a correctness fix rather than a
 * style choice. `String.prototype.replace` expands `$&`, `` $` ``, `$'`, `$$` and `$n`
 * inside a replacement STRING, and the replacement here is built from spec-supplied
 * filesystem paths. A path of `"$&BAD"` spliced the whole matched block back into the
 * middle of the emitted array and produced a manifest `JSON.parse` rejects; `"A$$B"` was
 * silently corrupted to `"A$B"`. A replacer function is handed to the engine verbatim, so
 * no character in it is special.
 */
function collapseFilesystem(json: string, filesystem: NonNullable<ConnectorSpec["filesystem"]>) {
  const expanded = JSON.stringify({ filesystem }, undefined, 2)
    .split("\n")
    .slice(1, -1)
    .map((line) => `  ${line}`)
    .join("\n");
  return json.replace(expanded, () => `    "filesystem": ${JSON.stringify(filesystem)}`);
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
    permissions: {
      network: spec.network,
      // Spread rather than a key set to undefined: the manifest distinguishes "declares no
      // filesystem access" (the key absent, 65 of 94) from "declares it, and it is empty"
      // (the key present with two empty arrays), and the spec's optionality is that
      // distinction.
      ...(spec.filesystem === undefined ? {} : { filesystem: spec.filesystem }),
    },
    hitlRequired: hitlRequired(spec),
    syncInterval: spec.syncInterval,
    minNimbusVersion: spec.minNimbusVersion,
  };
  const json = JSON.stringify(manifest, undefined, 2);
  return {
    path: ["nimbus.extension.json"],
    content: `${spec.filesystem === undefined ? json : collapseFilesystem(json, spec.filesystem)}\n`,
  };
}
