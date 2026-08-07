import { beforeAll, describe, expect, it } from "bun:test";
import {
  biomeVersion,
  formatAll,
  formatterAvailable,
  formatterUnavailableReason,
  formatterUnavailableReasonFor,
  initFormatter,
} from "../src/format.ts";

beforeAll(async () => {
  await initFormatter();
});

describe("initFormatter", () => {
  it("is idempotent", async () => {
    await initFormatter();
    await initFormatter();
    expect(formatterAvailable()).toBe(true);
  });

  it("reports the formatter as available in this repo", () => {
    expect(formatterAvailable()).toBe(true);
  });

  // Strengthens "is idempotent" above: that test alone would also pass if the second call
  // silently re-ran the whole load. This proves re-entry does NOT happen, by observing the
  // seam directly — mock.module replaces "@biomejs/js-api/nodejs" with a fake Biome whose
  // constructor increments a shared counter, then calls initFormatter() twice and asserts
  // the constructor ran exactly once. Run in a subprocess: a fresh module registry, and
  // mock.module's effect is process-global, so isolating it from the rest of the suite
  // matters. No test-only reset/call-count export is added to production code.
  it("does not re-run the loader on a second call (observed via a counting mock)", () => {
    const script =
      'const { mock } = await import("bun:test");' +
      "let constructCount = 0;" +
      'mock.module("@biomejs/js-api/nodejs", () => ({' +
      "  Biome: class {" +
      "    constructor() { constructCount++; }" +
      "    openProject() { return { projectKey: 1 }; }" +
      "    applyConfiguration() {}" +
      "  }," +
      "}));" +
      'const { initFormatter, formatterAvailable } = await import("./src/format.ts");' +
      "await initFormatter();" +
      "await initFormatter();" +
      'if (constructCount !== 1) throw new Error("constructCount=" + constructCount);' +
      'if (!formatterAvailable()) throw new Error("formatterAvailable() was false");' +
      'console.log("ok");';
    const r = Bun.spawnSync(["bun", "-e", script], {
      cwd: `${import.meta.dir}/..`,
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(r.exitCode).toBe(0);
    expect(r.stdout.toString()).toMatch(/ok/);
  });
});

describe("initFormatter surfaces configuration bugs", () => {
  // Pins the distinction the review flagged: a failure past the dynamic import (e.g. a
  // typo in the hardcoded applyConfiguration() call) is a programming error and must
  // reject initFormatter(), not be swallowed into formatterAvailable() === false. Proven
  // at the seam via bun:test's mock.module, which replaces "@biomejs/js-api/nodejs" with a
  // fake Biome whose applyConfiguration() throws. Run in a subprocess (same rationale as
  // "formatAll before init" above): a fresh module registry, and mock.module's effect is
  // process-global, so isolating it from the rest of the suite matters.
  it("rejects instead of reporting unavailable when applyConfiguration throws", () => {
    const script =
      'const { mock } = await import("bun:test");' +
      'mock.module("@biomejs/js-api/nodejs", () => ({' +
      "  Biome: class {" +
      "    openProject() { return { projectKey: 1 }; }" +
      '    applyConfiguration() { throw new Error("boom: injected config bug"); }' +
      "  }," +
      "}));" +
      'const { initFormatter } = await import("./src/format.ts");' +
      "await initFormatter();";
    const r = Bun.spawnSync(["bun", "-e", script], {
      cwd: `${import.meta.dir}/..`,
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(r.exitCode).not.toBe(0);
    expect(r.stderr.toString()).toMatch(/boom: injected config bug/);
  });
});

describe("initFormatter distinguishes an absent optional dependency from a broken one", () => {
  // Both cases degrade to unformatted output — that is what optionalDependencies are for —
  // but the *reason* differs, and reporting "not installed" for a package that is installed
  // sends the user to run an install that cannot fix anything. The seam is the dynamic
  // import: mock.module replaces "@biomejs/js-api/nodejs" with a factory that throws the
  // module-resolution error each case would really produce. Subprocess, same rationale as
  // the mocking tests above: mock.module's effect is process-global.
  function reasonWhenImportThrows(code: string, specifier: string, message: string): string {
    const script =
      'const { mock } = await import("bun:test");' +
      'mock.module("@biomejs/js-api/nodejs", () => {' +
      `  const e = new Error(${JSON.stringify(message)});` +
      `  e.code = ${JSON.stringify(code)};` +
      `  e.specifier = ${JSON.stringify(specifier)};` +
      "  throw e;" +
      "});" +
      'const f = await import("./src/format.ts");' +
      "await f.initFormatter();" +
      'if (f.formatterAvailable()) throw new Error("expected the formatter to be unavailable");' +
      "console.log(f.formatterUnavailableReason());";
    const r = Bun.spawnSync(["bun", "-e", script], {
      cwd: `${import.meta.dir}/..`,
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(r.stderr.toString()).toBe("");
    expect(r.exitCode).toBe(0);
    return r.stdout.toString();
  }

  it("reports the optional dependency as absent when it is the module that is missing", () => {
    const reason = reasonWhenImportThrows(
      "ERR_MODULE_NOT_FOUND",
      "@biomejs/js-api/nodejs",
      "Cannot find module '@biomejs/js-api/nodejs' from '/x'",
    );
    expect(reason).toMatch(/is not installed/);
    expect(reason).toMatch(/optionalDependency/);
  });

  it("reports a load failure, not 'not installed', when a sibling module is what is missing", () => {
    const reason = reasonWhenImportThrows(
      "MODULE_NOT_FOUND",
      "@biomejs/wasm-nodejs",
      "Cannot find module '@biomejs/wasm-nodejs' from '/x/js-api/dist/nodejs.js'",
    );
    expect(reason).not.toMatch(/is not installed/);
    expect(reason).toMatch(/installed but failed to load/);
    expect(reason).toMatch(/@biomejs\/wasm-nodejs/);
    // The underlying error must be surfaced, not replaced by a diagnosis.
    expect(reason).toMatch(/Cannot find module '@biomejs\/wasm-nodejs' from/);
  });

  it("reports a load failure for a non-resolution error too", () => {
    const reason = reasonWhenImportThrows("EACCES", "", "EACCES: permission denied");
    expect(reason).not.toMatch(/is not installed/);
    expect(reason).toMatch(/EACCES: permission denied/);
  });

  it("has no reason to report while the formatter is available", () => {
    expect(formatterAvailable()).toBe(true);
    expect(formatterUnavailableReason()).toBeUndefined();
  });
});

describe("formatterUnavailableReasonFor", () => {
  // The subprocess tests above prove the WIRING — that initFormatter routes a failed import
  // into this diagnosis. These cover the diagnosis itself, in-process, because the subprocess
  // form cannot: Bun does not instrument child processes, so every branch below read as
  // uncovered while being, in fact, exercised. Both layers are kept deliberately — deleting
  // the subprocess tests would leave the wiring unproven, and deleting these would leave the
  // branch table unable to show a regression in the misdiagnosis guard.
  function resolutionError(code: string, extra: Record<string, unknown>): unknown {
    return Object.assign(new Error("Cannot find module 'x' from '/y'"), { code, ...extra });
  }

  it("says 'not installed' when the missing specifier is js-api itself", () => {
    const reason = formatterUnavailableReasonFor(
      resolutionError("ERR_MODULE_NOT_FOUND", { specifier: "@biomejs/js-api/nodejs" }),
    );
    expect(reason).toMatch(/is not installed/);
    expect(reason).toMatch(/optionalDependency/);
  });

  it("accepts the MODULE_NOT_FOUND spelling as well as ERR_MODULE_NOT_FOUND", () => {
    const reason = formatterUnavailableReasonFor(
      resolutionError("MODULE_NOT_FOUND", { specifier: "@biomejs/js-api/nodejs" }),
    );
    expect(reason).toMatch(/is not installed/);
  });

  it("blames the backend, not js-api, when a SIBLING specifier is what is missing", () => {
    const reason = formatterUnavailableReasonFor(
      resolutionError("ERR_MODULE_NOT_FOUND", { specifier: "@biomejs/wasm-nodejs" }),
    );
    expect(reason).not.toMatch(/is not installed/);
    expect(reason).toMatch(/installed but failed to load/);
    expect(reason).toMatch(/@biomejs\/wasm-nodejs/);
  });

  it("falls back to the message when a runtime omits the structured specifier field", () => {
    const err = Object.assign(new Error("Cannot find module '@biomejs/js-api/nodejs' from '/x'"), {
      code: "ERR_MODULE_NOT_FOUND",
    });
    expect(formatterUnavailableReasonFor(err)).toMatch(/is not installed/);
  });

  it("does not claim 'not installed' when neither specifier nor message names js-api", () => {
    const err = Object.assign(new Error("Cannot find module 'something-else' from '/x'"), {
      code: "ERR_MODULE_NOT_FOUND",
    });
    expect(formatterUnavailableReasonFor(err)).toMatch(/installed but failed to load/);
  });

  it("treats a non-resolution error code as a load failure", () => {
    const reason = formatterUnavailableReasonFor(
      Object.assign(new Error("EACCES: permission denied"), { code: "EACCES" }),
    );
    expect(reason).not.toMatch(/is not installed/);
    expect(reason).toMatch(/EACCES: permission denied/);
  });

  it.each([
    ["a plain string", "boom"],
    ["null", null],
    ["undefined", undefined],
    ["a number", 42],
  ])("stringifies %s rather than throwing on a non-Error rejection", (_label, thrown) => {
    const reason = formatterUnavailableReasonFor(thrown);
    expect(reason).toMatch(/installed but failed to load/);
    expect(reason).toMatch(new RegExp(`Underlying error: ${String(thrown)}`));
  });
});

describe("formatAll before init", () => {
  // Run in a subprocess with a pristine module registry. A query-string import
  // (`../src/format.ts?x=1`) does currently give a fresh module in Bun 1.3.14 — verified —
  // but that is loader behaviour, not a documented contract, and this test exists precisely
  // to pin a guarantee. A subprocess also tests what a real caller hits: a program that
  // forgot to init. No test-only reset export is added to production code.
  it("throws a message naming initFormatter", () => {
    const r = Bun.spawnSync(
      [
        "bun",
        "-e",
        'const { formatAll } = await import("./src/format.ts");' +
          'formatAll([{ path: ["a.ts"], content: "const x=1\\n" }]);',
      ],
      { cwd: `${import.meta.dir}/..`, stdout: "pipe", stderr: "pipe" },
    );
    expect(r.exitCode).not.toBe(0);
    expect(r.stderr.toString()).toMatch(/initFormatter/);
  });
});

describe("formatAll", () => {
  it("formats TypeScript to the Nimbus house style", () => {
    const [out] = formatAll([{ path: ["src", "server.ts"], content: "const x = {a:1,b:2}\n" }]);
    expect(out?.content).toBe("const x = { a: 1, b: 2 };\n");
  });

  it("leaves non-TypeScript files untouched", () => {
    const input = { path: ["README.md"], content: "#   Title\n\n\n" };
    const [out] = formatAll([input]);
    expect(out?.content).toBe(input.content);
  });

  it("preserves object expansion chosen by the emitter", () => {
    const expanded = "const r = await fetch(u, {\n  headers: h(),\n});\n";
    const inline = "const r = await fetch(u, { headers: h() });\n";
    const [a, b] = formatAll([
      { path: ["a.ts"], content: expanded },
      { path: ["b.ts"], content: inline },
    ]);
    expect(a?.content).toBe(expanded);
    expect(b?.content).toBe(inline);
  });

  it("breaks lines longer than 100 columns", () => {
    const long = `const value = someFunction(${"argument, ".repeat(12)}last);\n`;
    const [out] = formatAll([{ path: ["c.ts"], content: long }]);
    expect(out?.content.split("\n").every((l) => l.length <= 100)).toBe(true);
  });

  it("round-trips a newrelic-shaped concise-arrow registration unchanged", () => {
    const reg =
      'reg("newrelic_application_list", "List APM applications.", z.object({}), async () =>\n' +
      '  jsonResult(await nrGet("/v2/applications.json")),\n);\n';
    expect(formatAll([{ path: ["d.ts"], content: reg }])[0]?.content).toBe(reg);
  });

  it("throws when fed syntactically invalid TypeScript, including the file path in the error", () => {
    const broken = "const x = {a:1,,,;\nfunction (((\n";
    expect(() => {
      formatAll([{ path: ["src", "server.ts"], content: broken }]);
    }).toThrow(/src\/server\.ts/);
  });

  it("formats valid code with no error diagnostics normally", () => {
    // The counterpart to the invalid-TypeScript test above: valid input must come back
    // formatted, not merely come back. `toBeDefined()` alone passed even for input that
    // was never routed through Biome at all.
    const valid = "const  x :number=42\n";
    const out = formatAll([{ path: ["valid.ts"], content: valid }])[0];
    expect(out?.path).toEqual(["valid.ts"]);
    expect(out?.content).toBe("const x: number = 42;\n");
  });

  it("collapses a short JSON array onto one line", () => {
    const input = JSON.stringify({ a: ["x", "y"] }, undefined, 2);
    const [out] = formatAll([{ path: ["nimbus.extension.json"], content: input }]);
    expect(out?.content).toBe('{\n  "a": ["x", "y"]\n}\n');
  });

  it("keeps a JSON array expanded when it does not fit within 100 columns", () => {
    const items = Array.from({ length: 12 }, (_, i) => `"a-rather-long-array-item-${i}"`);
    const input = `{"network":[${items.join(",")}]}`;
    const [out] = formatAll([{ path: ["nimbus.extension.json"], content: input }]);
    expect(out?.content).toContain("[\n");
    expect(out?.content.split("\n").every((l) => l.length <= 100)).toBe(true);
  });

  it("leaves README.md untouched (regression guard for the pass-through path)", () => {
    const input = { path: ["README.md"], content: "#   Title\n\n\n" };
    const [out] = formatAll([input]);
    expect(out?.content).toBe(input.content);
  });

  it("throws when fed syntactically invalid JSON, including the file path in the error", () => {
    const broken = '{ "a": [1, 2,,, }';
    expect(() => {
      formatAll([{ path: ["nimbus.extension.json"], content: broken }]);
    }).toThrow(/nimbus\.extension\.json/);
  });
});

describe("biomeVersion", () => {
  it("reports the resolved backend version", () => {
    expect(biomeVersion()).toMatch(/^2\.5\./);
  });
});
