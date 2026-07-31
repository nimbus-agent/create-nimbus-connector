import type { ConnectorSpec } from "../spec.ts";
import type { GeneratedFile } from "../types.ts";
import type { GenerateTarget } from "./index.ts";

export function emitPackageJson(spec: ConnectorSpec, target: GenerateTarget): GeneratedFile {
  const standalone = target === "standalone";
  const pkg = {
    name: `nimbus-mcp-${spec.name}`,
    version: "0.1.0",
    private: false,
    license: "AGPL-3.0-only",
    type: "module",
    scripts: {
      ...(standalone ? { dev: "bun run --watch src/server.ts" } : {}),
      ...(standalone ? { build: "bun build src/server.ts --outdir dist --target bun" } : {}),
      typecheck: "tsc --noEmit",
      lint: "biome check src/",
      test: "bun test",
      clean: "rm -rf dist",
    },
    dependencies: {
      "@modelcontextprotocol/sdk": "1.30.0",
      "@nimbus-dev/sdk": standalone ? "^1.11.0" : "^1.8.1",
      zod: "^4.4.2",
    },
    devDependencies: { "@types/bun": "latest" },
  };
  return { path: ["package.json"], content: `${JSON.stringify(pkg, undefined, 2)}\n` };
}
