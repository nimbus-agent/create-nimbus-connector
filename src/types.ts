/** One emitted file. `path` is OS-independent path segments, e.g. ["src", "server.ts"]. */
export type GeneratedFile = {
  readonly path: readonly string[];
  readonly content: string;
};

/** Join a GeneratedFile path for display and comparison. Always forward slashes. */
export function displayPath(path: readonly string[]): string {
  return path.join("/");
}
