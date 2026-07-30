import { describe, expect, it } from "bun:test";
import { renderEnvAccessor } from "../../../src/emit/server/env.ts";
import { EnvSchema } from "../../../src/spec.ts";

const env = (raw: unknown) => EnvSchema.parse(raw);

describe("renderEnvAccessor", () => {
  it("renders a required string accessor", () => {
    const out = renderEnvAccessor(
      env({ vars: ["NEW_RELIC_API_KEY"], local: "apiKey", bindings: ["k"], required: true }),
    );
    expect(out).toBe(`function apiKey(): string {
  const k = process.env["NEW_RELIC_API_KEY"]?.trim();
  if (k === undefined || k === "") {
    throw new Error("NEW_RELIC_API_KEY is not set");
  }
  return k;
}`);
  });

  it("applies transform before suffix", () => {
    const out = renderEnvAccessor(
      env({
        vars: ["SENTRY_URL"],
        local: "apiRoot",
        bindings: ["u"],
        default: "https://sentry.io",
        transform: "stripTrailingSlash",
        suffix: "/api/0",
      }),
    );
    expect(out).toBe(`function apiRoot(): string {
  const u = process.env["SENTRY_URL"]?.trim() || "https://sentry.io";
  return \`\${u.replace(/\\/$/, "")}/api/0\`;
}`);
  });

  it("renders a defaulted accessor with a prefix", () => {
    const out = renderEnvAccessor(
      env({
        vars: ["DD_SITE"],
        local: "siteHost",
        bindings: ["s"],
        default: "datadoghq.com",
        prefix: "api.",
      }),
    );
    expect(out).toContain('const s = process.env["DD_SITE"]?.trim() || "datadoghq.com";');
    expect(out).toContain("return `api.${s}`;");
  });

  it("returns a bare expression when there is no prefix or suffix", () => {
    const out = renderEnvAccessor(
      env({
        vars: ["GRAFANA_URL"],
        local: "baseUrl",
        bindings: ["u"],
        required: true,
        transform: "stripTrailingSlash",
      }),
    );
    expect(out).toContain('return u.replace(/\\/$/, "");');
    expect(out).not.toContain("`");
  });

  it("renders a bearer auth accessor", () => {
    const out = renderEnvAccessor(
      env({ vars: ["SENTRY_AUTH_TOKEN"], local: "headers", bindings: ["t"], auth: "bearer" }),
    );
    expect(out).toBe(`function headers(): Record<string, string> {
  const t = process.env["SENTRY_AUTH_TOKEN"]?.trim();
  if (t === undefined || t === "") {
    throw new Error("SENTRY_AUTH_TOKEN is not set");
  }
  return { Authorization: \`Bearer \${t}\`, Accept: "application/json" };
}`);
  });

  it("renders a multi-var header accessor with a joint error", () => {
    const out = renderEnvAccessor(
      env({
        vars: ["DD_API_KEY", "DD_APP_KEY"],
        local: "headers",
        bindings: ["ak", "app"],
        auth: "headers",
        headerNames: ["DD-API-KEY", "DD-APPLICATION-KEY"],
      }),
    );
    expect(out).toContain(
      'if (ak === undefined || ak === "" || app === undefined || app === "") {',
    );
    expect(out).toContain('throw new Error("DD_API_KEY and DD_APP_KEY must be set");');
    expect(out).toContain('"DD-API-KEY": ak,');
    expect(out).toContain('"DD-APPLICATION-KEY": app,');
    expect(out).toContain('Accept: "application/json",');
  });
});
