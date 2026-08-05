import { beforeAll, describe, expect, it } from "bun:test";
import {
  initParser,
  parseModule,
  parserAvailable,
  parserUnavailableReason,
  parserUnavailableReasonFor,
} from "../../src/derive/ast.ts";

beforeAll(async () => {
  await initParser();
});

describe("the parser boundary", () => {
  it("parses a module after initParser()", async () => {
    await initParser();
    expect(parserAvailable()).toBe(true);
    const body = parseModule("const a = 1;\n");
    expect(body).toHaveLength(1);
    expect(body[0]?.type).toBe("VariableDeclaration");
  });

  it("names bun add, not npm install, when the parser is absent", () => {
    // A Bun-only project must not print a Node instruction. Reachable only through this pure
    // function: @babel/parser cannot be made unresolvable in-process in a repo that has it.
    const err = { code: "ERR_MODULE_NOT_FOUND", specifier: "@babel/parser" };
    const reason = parserUnavailableReasonFor(err);
    expect(reason).toContain("bun add @babel/parser");
    expect(reason).not.toContain("npm install");
  });

  it("does not misreport a broken install as a missing one", () => {
    const err = { code: "ERR_MODULE_NOT_FOUND", specifier: "@babel/helper-validator" };
    const reason = parserUnavailableReasonFor(err);
    expect(reason).toContain("installed but failed to load");
  });
});

describe("initParser", () => {
  it("is idempotent", async () => {
    await initParser();
    await initParser();
    expect(parserAvailable()).toBe(true);
  });

  it("throws on source it cannot parse, rather than returning a partial program", () => {
    expect(() => parseModule("const = ;")).toThrow();
  });

  it("has no reason to report while the parser is available", () => {
    expect(parserAvailable()).toBe(true);
    expect(parserUnavailableReason()).toBeUndefined();
  });
});

describe("parseModule before init", () => {
  // Run in a subprocess with a pristine module registry, same rationale as
  // test/format.test.ts's "formatAll before init": a query-string import gives a fresh module,
  // and this is what a real caller hits if it forgets to await initParser() first. Unlike
  // formatAll (which degrades), parseModule has no degraded mode, so this must throw rather
  // than silently returning an empty program.
  it("throws a message naming initParser", () => {
    const r = Bun.spawnSync(
      [
        "bun",
        "-e",
        'const { parseModule } = await import("./src/derive/ast.ts");' +
          'parseModule("const a = 1;\\n");',
      ],
      { cwd: `${import.meta.dir}/../..`, stdout: "pipe", stderr: "pipe" },
    );
    expect(r.exitCode).not.toBe(0);
    expect(r.stderr.toString()).toMatch(/initParser/);
  });
});

describe("initParser distinguishes an absent optional dependency from a broken one", () => {
  // Both a genuinely-absent @babel/parser and one whose own import failed reach initParser's
  // catch, and conflating them sends the user to reinstall a package that is already there.
  // The seam is the dynamic import: mock.module replaces "@babel/parser" with a factory that
  // throws the module-resolution error each case would really produce. Subprocess, same
  // rationale as test/format.test.ts's equivalent block: mock.module's effect is
  // process-global.
  function reasonWhenImportThrows(code: string, specifier: string, message: string): string {
    const script =
      'const { mock } = await import("bun:test");' +
      'mock.module("@babel/parser", () => {' +
      `  const e = new Error(${JSON.stringify(message)});` +
      `  e.code = ${JSON.stringify(code)};` +
      `  e.specifier = ${JSON.stringify(specifier)};` +
      "  throw e;" +
      "});" +
      'const a = await import("./src/derive/ast.ts");' +
      "await a.initParser();" +
      'if (a.parserAvailable()) throw new Error("expected the parser to be unavailable");' +
      // A missing parser cannot degrade — confirm parseModule still throws, and that its
      // message is the SAME diagnosis parserUnavailableReason() reports, not the fallback
      // "was not initialised" text (that text is for the "initParser() never ran" case only).
      "let threw;" +
      'try { a.parseModule("const a = 1;\\n"); } catch (err) { threw = err; }' +
      'if (threw === undefined) throw new Error("expected parseModule to throw");' +
      "if (threw.message !== a.parserUnavailableReason()) {" +
      '  throw new Error("parseModule threw a different message: " + threw.message);' +
      "}" +
      "console.log(a.parserUnavailableReason());";
    const r = Bun.spawnSync(["bun", "-e", script], {
      cwd: `${import.meta.dir}/../..`,
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
      "@babel/parser",
      "Cannot find module '@babel/parser' from '/x'",
    );
    expect(reason).toMatch(/is not installed/);
    expect(reason).toMatch(/optionalDependency/);
    expect(reason).toMatch(/bun add @babel\/parser/);
  });

  it("reports a load failure, not 'not installed', when a sibling module is what is missing", () => {
    const reason = reasonWhenImportThrows(
      "MODULE_NOT_FOUND",
      "@babel/helper-validator-identifier",
      "Cannot find module '@babel/helper-validator-identifier' from '/x/parser/lib/index.js'",
    );
    expect(reason).not.toMatch(/is not installed/);
    expect(reason).toMatch(/installed but failed to load/);
    // The underlying error must be surfaced, not replaced by a diagnosis.
    expect(reason).toMatch(/Cannot find module '@babel\/helper-validator-identifier' from/);
  });
});

describe("parserUnavailableReasonFor", () => {
  // The subprocess tests above prove the WIRING — that initParser routes a failed import into
  // this diagnosis. These cover the diagnosis itself, in-process, because the subprocess form
  // cannot: Bun does not instrument child processes, so every branch below would read as
  // uncovered while being, in fact, exercised.
  function resolutionError(code: string, extra: Record<string, unknown>): unknown {
    return Object.assign(new Error("Cannot find module 'x' from '/y'"), { code, ...extra });
  }

  it("accepts the MODULE_NOT_FOUND spelling as well as ERR_MODULE_NOT_FOUND", () => {
    const reason = parserUnavailableReasonFor(
      resolutionError("MODULE_NOT_FOUND", { specifier: "@babel/parser" }),
    );
    expect(reason).toMatch(/is not installed/);
  });

  it("falls back to the message when a runtime omits the structured specifier field", () => {
    const err = Object.assign(new Error("Cannot find module '@babel/parser' from '/x'"), {
      code: "ERR_MODULE_NOT_FOUND",
    });
    expect(parserUnavailableReasonFor(err)).toMatch(/is not installed/);
  });

  it("does not claim 'not installed' when neither specifier nor message names @babel/parser", () => {
    const err = Object.assign(new Error("Cannot find module 'something-else' from '/x'"), {
      code: "ERR_MODULE_NOT_FOUND",
    });
    expect(parserUnavailableReasonFor(err)).toMatch(/installed but failed to load/);
  });

  it("treats a non-resolution error code as a load failure", () => {
    const reason = parserUnavailableReasonFor(
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
    const reason = parserUnavailableReasonFor(thrown);
    expect(reason).toMatch(/installed but failed to load/);
    expect(reason).toMatch(new RegExp(`Underlying error: ${String(thrown)}`));
  });
});
