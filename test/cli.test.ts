import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseCliArgs, renderTree, USAGE } from "../src/cli.ts";
import { emitReadme } from "../src/emit/readme.ts";
import { buildSpec, type PromptAnswers } from "../src/prompts.ts";
import { registrarName } from "../src/spec.ts";

describe("parseCliArgs", () => {
  it("reads a positional name", () => {
    expect(parseCliArgs(["slack"])).toEqual({
      name: "slack",
      dryRun: false,
      standalone: false,
      force: false,
    });
  });

  it("reads --spec and --dry-run", () => {
    expect(parseCliArgs(["--spec", "fixtures/sentry.spec.json", "--dry-run"])).toEqual({
      specPath: "fixtures/sentry.spec.json",
      dryRun: true,
      standalone: false,
      force: false,
    });
  });

  it("reads --out-dir", () => {
    expect(parseCliArgs(["x", "--out-dir", "/tmp/x"])).toEqual({
      name: "x",
      outDir: "/tmp/x",
      dryRun: false,
      standalone: false,
      force: false,
    });
  });

  it("rejects an unknown flag", () => {
    expect(() => parseCliArgs(["--nope"])).toThrow(/--nope/);
  });

  it("rejects --spec with no following value", () => {
    expect(() => parseCliArgs(["--spec"])).toThrow(/--spec/);
  });

  it("rejects --out-dir with no following value", () => {
    expect(() => parseCliArgs(["--out-dir"])).toThrow(/--out-dir/);
  });

  it("rejects a positional name combined with --spec", () => {
    expect(() => parseCliArgs(["slack", "--spec", "x.json"])).toThrow(/--spec/);
  });

  it("still accepts a bare positional name", () => {
    expect(() => parseCliArgs(["slack"])).not.toThrow();
  });

  it("still accepts --spec alone with a value", () => {
    expect(() => parseCliArgs(["--spec", "x.json"])).not.toThrow();
  });

  describe("--standalone", () => {
    it("defaults to false", () => {
      expect(parseCliArgs(["acme"]).standalone).toBe(false);
    });

    it("is set by the flag", () => {
      expect(parseCliArgs(["acme", "--standalone"]).standalone).toBe(true);
    });

    it("carries --license through when standalone", () => {
      expect(parseCliArgs(["acme", "--standalone", "--license", "MIT"]).license).toBe("MIT");
    });

    it("leaves license undefined when the flag is absent", () => {
      expect(parseCliArgs(["acme", "--standalone"]).license).toBeUndefined();
    });

    it("rejects --license without --standalone rather than ignoring it", () => {
      expect(() => parseCliArgs(["acme", "--license", "MIT"])).toThrow(/--standalone/);
      expect(() => parseCliArgs(["acme", "--license", "MIT"])).toThrow(/AGPL-3\.0-only/);
    });

    it("rejects --license with no following value", () => {
      expect(() => parseCliArgs(["acme", "--standalone", "--license"])).toThrow(/--license/);
    });

    it("rejects a malformed --license at parse time, before any file is emitted", () => {
      expect(() => parseCliArgs(["acme", "--standalone", "--license", "  "])).toThrow(/non-empty/i);
      expect(() => parseCliArgs(["acme", "--standalone", "--license", "MIT!"])).toThrow(/"!"/);
    });

    it("combines with --spec and --out-dir", () => {
      expect(parseCliArgs(["--spec", "x.json", "--standalone", "--out-dir", "/tmp/x"])).toEqual({
        specPath: "x.json",
        outDir: "/tmp/x",
        standalone: true,
        dryRun: false,
        force: false,
      });
    });
  });

  describe("--gateway-wiring", () => {
    it("is undefined by default", () => {
      expect(parseCliArgs(["acme"]).gatewayWiring).toBeUndefined();
    });

    it("is set by the flag", () => {
      expect(parseCliArgs(["acme", "--gateway-wiring", "C:/gitrep/Nimbus"]).gatewayWiring).toBe(
        "C:/gitrep/Nimbus",
      );
    });

    it("rejects --gateway-wiring with no following value", () => {
      expect(() => parseCliArgs(["acme", "--gateway-wiring"])).toThrow(/--gateway-wiring/);
    });

    // Final fix wave, MINOR 2. The README calls this flag monorepo-target only, and every
    // other conflict in this CLI already errors; this pairing was the one silently accepted.
    it("rejects --gateway-wiring with --standalone rather than accepting it silently", () => {
      expect(() => parseCliArgs(["acme", "--standalone", "--gateway-wiring", "C:/x"])).toThrow(
        /monorepo target only/,
      );
      // Order-independent: the check runs after the whole argv is parsed.
      expect(() => parseCliArgs(["acme", "--gateway-wiring", "C:/x", "--standalone"])).toThrow(
        /monorepo target only/,
      );
    });

    it("still accepts --gateway-wiring on its own", () => {
      expect(() => parseCliArgs(["acme", "--gateway-wiring", "C:/x"])).not.toThrow();
    });
  });

  describe("--force", () => {
    it("defaults to false", () => {
      expect(parseCliArgs(["acme"]).force).toBe(false);
    });

    it("is set by the flag when combined with --gateway-wiring", () => {
      expect(parseCliArgs(["acme", "--gateway-wiring", "C:/gitrep/Nimbus", "--force"]).force).toBe(
        true,
      );
    });

    it("rejects --force without --gateway-wiring rather than ignoring it", () => {
      expect(() => parseCliArgs(["acme", "--force"])).toThrow(/--gateway-wiring/);
    });
  });

  describe("--from-connector", () => {
    it("is undefined by default", () => {
      expect(parseCliArgs(["acme"]).fromConnector).toBeUndefined();
    });

    it("is set by the flag", () => {
      expect(parseCliArgs(["--from-connector", "/tmp/some-connector"]).fromConnector).toBe(
        "/tmp/some-connector",
      );
    });

    it("rejects --from-connector with no following value", () => {
      expect(() => parseCliArgs(["--from-connector"])).toThrow(/--from-connector/);
    });

    it("still accepts --from-connector on its own", () => {
      expect(() => parseCliArgs(["--from-connector", "/tmp/x"])).not.toThrow();
    });

    it("rejects --from-connector combined with --spec, naming both flags", () => {
      expect(() => parseCliArgs(["--from-connector", "/tmp/x", "--spec", "x.json"])).toThrow(
        /--from-connector/,
      );
      expect(() => parseCliArgs(["--from-connector", "/tmp/x", "--spec", "x.json"])).toThrow(
        /--spec/,
      );
    });

    it("rejects --from-connector combined with a positional name", () => {
      expect(() => parseCliArgs(["acme", "--from-connector", "/tmp/x"])).toThrow(
        /--from-connector/,
      );
    });

    it("rejects --from-connector combined with --gateway-wiring", () => {
      expect(() =>
        parseCliArgs(["--from-connector", "/tmp/x", "--gateway-wiring", "C:/gitrep/Nimbus"]),
      ).toThrow(/--gateway-wiring/);
    });
  });
});

describe("renderTree", () => {
  it("lists every file with its byte count", () => {
    const out = renderTree([
      { path: ["src", "server.ts"], content: "abc" },
      { path: ["README.md"], content: "hello" },
    ]);
    expect(out).toContain("src/server.ts");
    expect(out).toContain("3 bytes");
    expect(out).toContain("README.md");
    expect(out).toContain("5 bytes");
  });
});

describe("buildSpec (promptForSpec's spec-construction logic)", () => {
  const base: Omit<PromptAnswers, "authKind" | "headerName"> = {
    name: "acme",
    displayName: "Acme",
    serviceLabel: "Acme",
    description: "Acme connector. Read-focused.",
    baseUrl: "https://api.acme.com",
    envVar: "ACME_TOKEN",
    toolNames: ["acme_list"],
  };

  it("maps auth: bearer to style: rest-kit with a single auth: bearer env entry", () => {
    const spec = buildSpec({ ...base, authKind: "bearer", headerName: "" });
    expect(spec.style).toBe("rest-kit");
    expect(spec.env).toHaveLength(1);
    expect(spec.env[0]?.auth).toBe("bearer");
    expect(spec.env[0]?.vars).toEqual(["ACME_TOKEN"]);
    expect(spec.fetchHelper.headers).toBeUndefined();
  });

  it("maps auth: token to style: hand-rolled with a single auth: headers env entry", () => {
    const spec = buildSpec({ ...base, authKind: "token", headerName: "X-Api-Key" });
    expect(spec.style).toBe("hand-rolled");
    expect(spec.env).toHaveLength(1);
    expect(spec.env[0]?.auth).toBe("headers");
    expect(spec.env[0]?.headerNames).toEqual(["X-Api-Key"]);
    expect(spec.fetchHelper.headers).toBe("headers");
  });

  it("maps auth: basic to style: hand-rolled with a single auth: headers env entry", () => {
    const spec = buildSpec({ ...base, authKind: "basic", headerName: "Authorization" });
    expect(spec.style).toBe("hand-rolled");
    expect(spec.env).toHaveLength(1);
    expect(spec.env[0]?.auth).toBe("headers");
    expect(spec.env[0]?.headerNames).toEqual(["Authorization"]);
    expect(spec.fetchHelper.headers).toBe("headers");
  });

  it("emits every requested tool as impl: stub", () => {
    const spec = buildSpec({
      ...base,
      authKind: "bearer",
      headerName: "",
      toolNames: ["acme_list", "acme_get"],
    });
    expect(spec.tools).toHaveLength(2);
    expect(spec.tools.every((t) => t.impl === "stub")).toBe(true);
  });

  it("sets title from displayName for a hyphenated name (F1)", () => {
    const spec = buildSpec({
      ...base,
      name: "google-meet",
      displayName: "Google Meet",
      authKind: "bearer",
      headerName: "",
    });
    expect(spec.title).toBe("Google Meet");
    expect(emitReadme(spec, "monorepo").content).toContain("# Google Meet Connector");
    expect(registrarName(spec)).toBe("registerGoogleMeetTool");
  });

  it("throws a message naming the base URL field and value when it is not a valid URL", () => {
    expect(() =>
      buildSpec({ ...base, authKind: "bearer", headerName: "", baseUrl: "not-a-url" }),
    ).toThrow(/not-a-url/);
    try {
      buildSpec({ ...base, authKind: "bearer", headerName: "", baseUrl: "not-a-url" });
      throw new Error("expected buildSpec to throw");
    } catch (e) {
      expect((e as Error).message).toContain("not-a-url");
      expect((e as Error).message).toMatch(/base api url/i);
    }
  });
});

describe("--help", () => {
  const cliSource = readFileSync(join(import.meta.dir, "..", "src", "cli.ts"), "utf8");

  /**
   * Usage text that drifts from the parser is worse than no usage text: it documents flags
   * that do not exist, or omits ones that do, and nothing fails. parseFlags is the source of
   * truth, so the flags it compares against are extracted from the source and required to
   * appear in USAGE.
   */
  it("documents every flag parseFlags accepts", () => {
    const parsed = [...cliSource.matchAll(/a === "(--[a-z-]+)"/g)].map((m) => m[1]!);
    expect(parsed.length).toBeGreaterThan(5);
    for (const flag of parsed) {
      expect(USAGE).toContain(flag);
    }
  });

  it("documents no flag parseFlags would reject", () => {
    // The reverse direction: a line in USAGE for a flag that does not exist sends the user
    // to "Unknown flag", which is exactly the experience --help is here to prevent.
    for (const m of USAGE.matchAll(/^ {2}(--[a-z-]+)/gm)) {
      const flag = m[1]!;
      // Handled before parseCliArgs by design, so the parser never sees them.
      if (flag === "--help" || flag === "--version") continue;
      expect(() => parseCliArgs([flag, "x"])).not.toThrow(/Unknown flag/);
    }
  });

  it("names the path-template syntax, the one thing that fails silently without it", () => {
    expect(USAGE).toContain("${arg.NAME}");
    expect(USAGE).toMatch(/\{id\}.*rejected|rejected.*\{id\}/s);
  });
});
