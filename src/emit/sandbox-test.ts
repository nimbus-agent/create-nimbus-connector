import type { GeneratedFile } from "../types.ts";
import type { GenerateTarget } from "./index.ts";

/** The sandbox contract test is identical in 79 of 94 connectors — a constant, no substitutions. */
const SANDBOX_TEST_MONOREPO = `import { describe, expect, it } from "bun:test";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { runSandboxContractTests } from "@nimbus-dev/sdk/testing";

const manifestPath = resolve(fileURLToPath(import.meta.url), "../../nimbus.extension.json");

describe.skipIf(!process.env["NIMBUS_TEST_HARNESS"])("sandbox contract", () => {
  it("respects declared permissions", async () => {
    await expect(runSandboxContractTests(manifestPath)).resolves.toBeUndefined();
  });
});
`;

const SANDBOX_TEST_STANDALONE = `import { describe, expect, it } from "bun:test";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { runSandboxContractTests } from "@nimbus-dev/sdk/testing";

const manifestPath = resolve(fileURLToPath(import.meta.url), "../nimbus.extension.json");

describe.skipIf(!process.env["NIMBUS_TEST_HARNESS"])("sandbox contract", () => {
  it("respects declared permissions", async () => {
    await expect(runSandboxContractTests(manifestPath)).resolves.toBeUndefined();
  });
});
`;

export function emitSandboxTest(target: GenerateTarget = "monorepo"): GeneratedFile {
  const content = target === "standalone" ? SANDBOX_TEST_STANDALONE : SANDBOX_TEST_MONOREPO;
  return { path: ["test", "sandbox.test.ts"], content };
}
