/**
 * Shared by every optionalDependency load path in this repo. Two very different failures reach
 * a dynamic import's catch, and conflating them sends the user to fix a package that is already
 * installed:
 *   1. the optional dependency is genuinely absent;
 *   2. it is present but one of ITS OWN imports is not.
 *
 * Under Bun a failed dynamic import rejects with a ResolveMessage carrying `code`
 * ERR_MODULE_NOT_FOUND / MODULE_NOT_FOUND and a `specifier` field naming the module that could
 * not be found — which is the *inner* specifier in case 2. That difference is the whole
 * discrimination.
 *
 * What each caller DOES with the answer differs and must not be unified here: a missing
 * formatter degrades to unformatted output (src/format.ts), a missing parser cannot degrade at
 * all (src/derive/ast.ts). This predicate only says which failure occurred.
 */
export function isMissingModule(err: unknown, specifier: string): boolean {
  if (typeof err !== "object" || err === null) return false;
  const e = err as { code?: unknown; specifier?: unknown; message?: unknown };
  if (e.code !== "ERR_MODULE_NOT_FOUND" && e.code !== "MODULE_NOT_FOUND") return false;
  // Prefer the structured field; fall back to the message only if a runtime omits it.
  if (typeof e.specifier === "string") return e.specifier === specifier;
  return typeof e.message === "string" && e.message.includes(specifier);
}
