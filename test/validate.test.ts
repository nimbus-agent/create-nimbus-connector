import { describe, expect, it } from "bun:test";
import { parseSpec } from "../src/spec.ts";
import { validateSpec } from "../src/validate.ts";

function specWith(over: Record<string, unknown>) {
  return parseSpec({
    name: "sentry",
    displayName: "Sentry",
    description: "Sentry connector.",
    serviceLabel: "Sentry",
    style: "hand-rolled",
    env: [{ vars: ["SENTRY_ORG_SLUG"], local: "org", bindings: ["o"], required: true }],
    fetchHelper: { local: "sentryGet", base: "${env.org}", headers: "headers" },
    tools: [],
    ...over,
  });
}

function restKitSpecWith(over: Record<string, unknown>) {
  return parseSpec({
    name: "discord",
    title: "Discord",
    displayName: "Discord",
    description: "Discord connector.",
    serviceLabel: "Discord",
    style: "rest-kit",
    env: [
      { vars: ["DISCORD_TOKEN"], local: "token", bindings: ["t"], required: true, auth: "bearer" },
    ],
    fetchHelper: { local: "discordGet", base: "https://discord.com/api/v10" },
    tools: [],
    ...over,
  });
}

describe("validateSpec", () => {
  it("accepts a spec with no collisions", () => {
    expect(() => validateSpec(specWith({}))).not.toThrow();
  });

  it("rejects a hoisted arg local that shadows an env accessor", () => {
    const s = specWith({
      tools: [
        {
          name: "sentry_issue_list",
          description: "List issues.",
          args: { limit: { type: "number", optional: true, default: 20, local: "org" } },
          path: "/projects/${env.org}/issues/",
        },
      ],
    });
    expect(() => validateSpec(s)).toThrow(/org/);
  });

  it("rejects two env accessors with the same local", () => {
    const s = specWith({
      env: [
        { vars: ["A"], local: "dup", bindings: ["a"], required: true },
        { vars: ["B"], local: "dup", bindings: ["b"], required: true },
      ],
    });
    expect(() => validateSpec(s)).toThrow(/dup/);
  });

  it("rejects an env local colliding with a reserved emitter name", () => {
    const s = specWith({ env: [{ vars: ["A"], local: "reg", bindings: ["a"], required: true }] });
    expect(() => validateSpec(s)).toThrow(/reg/);
  });

  it("rejects a fetchHelper local colliding with an env local", () => {
    const s = specWith({ fetchHelper: { local: "org", base: "https://x", headers: "headers" } });
    expect(() => validateSpec(s)).toThrow(/org/);
  });

  it("rejects duplicate tool names", () => {
    const t = { name: "dup_tool", description: "d.", path: "/a" };
    expect(() => validateSpec(specWith({ tools: [t, t] }))).toThrow(/dup_tool/);
  });

  it("rejects a rest-kit spec whose env local collides with the registrar name", () => {
    const s = restKitSpecWith({
      title: "Foo",
      env: [{ vars: ["A"], local: "registerFooTool", bindings: ["a"], required: true }],
    });
    expect(() => validateSpec(s)).toThrow(/registerFooTool/);
  });

  it("accepts a hand-rolled spec whose env local matches what rest-kit would claim", () => {
    const s = specWith({
      title: "Foo",
      style: "hand-rolled",
      env: [{ vars: ["A"], local: "registerFooTool", bindings: ["a"], required: true }],
    });
    expect(() => validateSpec(s)).not.toThrow();
  });

  it("correctly strips non-alphanumerics from title in registrar name", () => {
    const s = restKitSpecWith({
      title: "Google Meet",
      env: [{ vars: ["A"], local: "registerGoogleMeetTool", bindings: ["a"], required: true }],
    });
    expect(() => validateSpec(s)).toThrow(/registerGoogleMeetTool/);
  });
});
