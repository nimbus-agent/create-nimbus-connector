import { join } from "node:path";
import { type ResolveOptions, type RootSpec, resolveRoot } from "./resolve-root.ts";

export type { ResolveOptions };

export const MARKER = join("packages", "mcp-connectors", "shared", "mcp-tool-kit.ts");

const NIMBUS: RootSpec = {
  marker: MARKER,
  // "Nimbus" first: the repository's own casing. "nimbus" is probed too because a
  // case-sensitive filesystem will not find one when given the other.
  siblings: ["Nimbus", "nimbus"],
  flagName: "--nimbus-root",
  envName: "$NIMBUS_ROOT",
  subject: "the Nimbus monorepo",
  checkoutOf: "Nimbus",
};

export function resolveNimbusRoot(opts: ResolveOptions): string {
  return resolveRoot(opts, NIMBUS);
}
