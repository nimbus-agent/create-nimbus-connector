export type ManifestFields = {
  id?: string;
  displayName: string;
  description: string;
  network: string[];
  filesystem?: { read: string[]; write: string[] };
  syncInterval: number;
  minNimbusVersion: string;
};

function req<T>(value: T | undefined, key: string): T {
  if (value === undefined) {
    throw new Error(`nimbus.extension.json has no "${key}" — it is not a connector manifest.`);
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
    throw new TypeError(
      `nimbus.extension.json's "${key}" is not a string — it is not a connector manifest.`,
    );
  }
  return value;
}

/**
 * The inverse of src/emit/manifest.ts, key for key.
 *
 * `hitlRequired` is deliberately not recovered: the emitter computes it from tool effects
 * rather than reading it, so a derived spec that carried it would be carrying a field the
 * emitter ignores. `version`, `author`, `entrypoint` and `runtime` are emitter constants for
 * the same reason.
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
    syncInterval: req(m.syncInterval as number | undefined, "syncInterval"),
    minNimbusVersion: req(m.minNimbusVersion as string | undefined, "minNimbusVersion"),
  };
}
