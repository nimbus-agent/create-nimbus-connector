import { describe, expect, it } from "bun:test";
import { parseCliArgs, renderTree } from "../src/cli.ts";
import { buildSpec, type PromptAnswers } from "../src/prompts.ts";

describe("parseCliArgs", () => {
  it("reads a positional name", () => {
    expect(parseCliArgs(["slack"])).toEqual({ name: "slack", dryRun: false });
  });

  it("reads --spec and --dry-run", () => {
    expect(parseCliArgs(["--spec", "fixtures/sentry.spec.json", "--dry-run"])).toEqual({
      specPath: "fixtures/sentry.spec.json",
      dryRun: true,
    });
  });

  it("reads --out-dir", () => {
    expect(parseCliArgs(["x", "--out-dir", "/tmp/x"])).toEqual({
      name: "x",
      outDir: "/tmp/x",
      dryRun: false,
    });
  });

  it("rejects an unknown flag", () => {
    expect(() => parseCliArgs(["--nope"])).toThrow(/--nope/);
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
});
