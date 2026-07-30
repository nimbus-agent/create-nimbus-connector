import type { ConnectorSpec } from "../spec.ts";
import type { GeneratedFile } from "../types.ts";
import { validateSpec } from "../validate.ts";
import { emitManifest } from "./manifest.ts";
import { emitPackageJson } from "./package-json.ts";
import { emitReadme } from "./readme.ts";
import { emitSandboxTest } from "./sandbox-test.ts";
import { emitServer } from "./server/index.ts";
import { emitTsconfig } from "./tsconfig.ts";

/** Pure. Returns UNFORMATTED files — callers pass the result through formatAll(). */
export function generate(spec: ConnectorSpec): GeneratedFile[] {
  validateSpec(spec);
  return [
    emitServer(spec),
    emitSandboxTest(),
    emitPackageJson(spec),
    emitManifest(spec),
    emitTsconfig(),
    emitReadme(spec),
  ];
}
