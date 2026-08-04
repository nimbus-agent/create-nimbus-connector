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
    ...(m.id === undefined ? {} : { id: String(m.id) }),
    displayName,
    description,
    network: req(permissions.network as string[] | undefined, "permissions.network"),
    ...(filesystem === undefined ? {} : { filesystem }),
    syncInterval: req(m.syncInterval as number | undefined, "syncInterval"),
    minNimbusVersion: req(m.minNimbusVersion as string | undefined, "minNimbusVersion"),
  };
}
