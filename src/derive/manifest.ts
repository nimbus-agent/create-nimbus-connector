export type ManifestFields = {
  id?: string;
  displayName: string;
  description: string;
  network: string[];
  filesystem?: { read: string[]; write: string[] };
  /**
   * The manifest's observed capability set, exactly as written — not attributed to any tool
   * here. `src/derive/index.ts`'s `attributeEffects` does that, against the recognized tools'
   * methods, and refuses rather than guess when no attribution reproduces this set.
   */
  hitlRequired: string[];
  syncInterval: number;
  minNimbusVersion: string;
};

/**
 * A manifest that IS a manifest but lacks a key `src/emit/manifest.ts` always writes — distinct
 * from a file that is absent, unparseable, or carrying a wrong-typed field, all three of which
 * stay in the coarse `no-manifest` bucket (`reqString`'s `TypeError` is the third, and is neither
 * absent nor unparseable). `iac` is the live corpus instance: its `nimbus.extension.json` exists
 * and parses; it simply predates `syncInterval`. `deriveSpec` maps this to
 * `manifest:missing-<key>` rather than the generic bucket, so the histogram sends a reader to the
 * missing field rather than to a file that is right there.
 */
export class MissingManifestKey extends Error {
  constructor(readonly key: string) {
    super(`nimbus.extension.json has no "${key}".`);
  }
}

function req<T>(value: T | undefined, key: string): T {
  if (value === undefined) {
    throw new MissingManifestKey(key);
  }
  return value;
}

/**
 * A present key's value as a string, refusing anything else — used for `id`, the one field read
 * off the parsed JSON rather than cast.
 *
 * `String(value)` on the raw `unknown` turns a JSON object into the literal text
 * "[object Object]" and an array into its comma-joined elements — junk that would then be carried
 * into the derived spec as though it were the connector's id, an invented value of exactly the
 * kind `req` above refuses to produce for a missing key. The emitter only ever writes a string
 * here, so requiring one is lossless for every manifest this generator can produce, and a
 * manifest carrying anything else is named as the defect it is rather than derived from.
 */
function reqString(value: unknown, key: string): string {
  if (typeof value !== "string") {
    throw new TypeError(`nimbus.extension.json's "${key}" is not a string.`);
  }
  return value;
}

/**
 * The inverse of src/emit/manifest.ts, key for key.
 *
 * `hitlRequired` is surfaced as the observed SET the manifest declares, unattributed — see
 * `attributeEffects` in `src/derive/index.ts` for why matching it back to individual tools is a
 * separate, fallible step this function does not perform. `version`, `author`, `entrypoint` and
 * `runtime` remain emitter constants, unrecovered because the emitter never reads them back.
 */
export function deriveManifest(json: string): ManifestFields {
  const m = JSON.parse(json) as Record<string, unknown>;
  const displayName = req(m.displayName as string | undefined, "displayName");
  const description = req(m.description as string | undefined, "description");
  const permissions = req(m.permissions as Record<string, unknown> | undefined, "permissions");
  const filesystem = permissions.filesystem as ManifestFields["filesystem"];
  return {
    ...(m.id === undefined ? {} : { id: reqString(m.id, "id") }),
    displayName,
    description,
    network: req(permissions.network as string[] | undefined, "permissions.network"),
    ...(filesystem === undefined ? {} : { filesystem }),
    hitlRequired: req(m.hitlRequired as string[] | undefined, "hitlRequired"),
    syncInterval: req(m.syncInterval as number | undefined, "syncInterval"),
    minNimbusVersion: req(m.minNimbusVersion as string | undefined, "minNimbusVersion"),
  };
}
