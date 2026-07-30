# Design Review: create-nimbus-connector (Stage B)

This document provides a review, suggestions, and open questions for the [Stage B Design Specification](file:///C:/gitrep/create-nimbus-connector/docs/superpowers/specs/2026-07-30-create-nimbus-connector-stage-b-design.md).

---

## 1. Open Questions

### Runtime Constraints for Standalone Connectors
* **Question:** Decision B6 states that the published CLI targets Bun only. However, what is the runtime support matrix for the *generated standalone connectors* themselves?
* **Implication:** If the generated server code (`src/server.ts`) or its dependencies rely on Bun-specific globals or modules (e.g., `Bun.env` instead of `process.env`), the standalone connectors will also be locked to Bun.
* **Suggestion:** Explicitly document if generated standalone connectors are compatible with Node.js (using standard entry points and compiling to standard ESM/CJS), or if they are also strictly Bun-only by design.

### Programmatic Formatting Initialization API
* **Question:** The load of the optional Biome formatter is moved out of `formatAll` to `await initFormatter()`. If the generator package is used programmatically as a library, who is responsible for calling `initFormatter`?
* **Suggestion:** Make `initFormatter()` part of the exported API of the package, or automatically invoke it asynchronously in a non-blocking background task upon package import, exposing a promise (e.g., `formatterReady`) that consumers can optionally await.

### Standalone Build Tooling and Target Format
* **Question:** The spec mentions that the standalone `package.json` includes `dev` and `build` scripts, producing `dist/server.js`. Which compiler or bundler performs this build?
* **Implication:** If it uses standard `tsc` (TypeScript compiler), it outputs multiple files and requires configuring `"moduleResolution"`. If it uses `bun build`, it produces a single self-contained file.
* **Suggestion:** Define the default build script command (e.g., `bun build ./src/server.ts --outdir ./dist --target bun` or `tsc`) to ensure predictability in the output shape.

---

## 2. Improvements & Suggestions

### Frictionless Biome Installation Notice
* **Suggestion:** When the CLI degrades gracefully due to Biome's absence, instead of a generic message, print the exact package manager command to install it.
* **Idea:** Detect if the user ran the command via `bunx` / `bun` vs `npx` / `npm` and suggest the appropriate command:
  * For Bun: `bun add -d @biomejs/biome`
  * For npm/yarn: `npm install --save-dev @biomejs/biome`

### Cross-Repo CI Verification
* **Suggestion:** Since the contract spans three separate repositories (`create-nimbus-connector`, `nimbus-sdk`, `Nimbus`), verification is highly manual.
* **Idea:** Add a helper script or configure a workflow in `nimbus-sdk` that clones `create-nimbus-connector` and runs its acceptance suite against the SDK branch prior to releasing version `1.11.0`. This ensures that any breaking changes in the SDK's package layout or typescript definitions are caught immediately.

### Explicit ESM Configuration in Standalone `tsconfig.json`
* **Suggestion:** The standalone `tsconfig.json` should explicitly set `"module": "ESNext"`, `"target": "ES2022"`, and `"moduleResolution": "bundler"` (or `"node"`) to ensure compatibility with standard Node/Bun environments. 
* **Rationale:** This guarantees that the generated connector correctly imports `@nimbus-dev/sdk/connector-kit` using standard ESM resolution without requiring complex bundle-time hacks.
