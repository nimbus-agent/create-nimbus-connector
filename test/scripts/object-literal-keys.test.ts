/**
 * Unit tests for the object-literal key extractor behind `bun run wiring:conformance`.
 *
 * This module exists because that harness's first check was VACUOUS: it asked whether the whole
 * emitted `*-sync.ts` matched `\bsync\s*[:(]`, and the emitted file's own docstring says
 * "sync() below throws", so the pattern matched as English no matter what the skeleton declared.
 * Renaming the emitted method left the gate green.
 *
 * These tests pin the cases that separate "the literal supplies this member" from "the file
 * mentions this word": prose above the literal, prose inside the method body, and comments
 * inside the literal itself.
 */

import { describe, expect, it } from "bun:test";
import { objectLiteralKeys } from "../../scripts/_lib/object-literal-keys.ts";

describe("objectLiteralKeys", () => {
  it("lists the keys a flat literal supplies", () => {
    const source = "const x = {\n  serviceId: SERVICE_ID,\n  defaultIntervalMs: 300000,\n};";

    expect(objectLiteralKeys(source, "const x = {")).toEqual(["serviceId", "defaultIntervalMs"]);
  });

  it("reports a method signature, which sits at the literal's own depth", () => {
    const source = ["return {", "  sync(ctx, cursor) {", "    return go(ctx);", "  },", "};"].join(
      "\n",
    );

    expect(objectLiteralKeys(source, "return {")).toEqual(["sync"]);
  });

  // The regression this module was written for.
  it("ignores prose ABOVE the literal that looks like a member", () => {
    const source = [
      "/**",
      " * A skeleton. sync() below throws. See the mapping stub.",
      " */",
      "export function make(): Syncable {",
      "  return {",
      "    serviceId: SERVICE_ID,",
      "  };",
      "}",
    ].join("\n");

    // Without scoping, `\bsync\s*[:(]` matches the docstring and the gate passes vacuously.
    expect(objectLiteralKeys(source, "return {")).toEqual(["serviceId"]);
  });

  it("ignores prose INSIDE a method body", () => {
    const source = [
      "return {",
      "  serviceId: ID,",
      "  sync(_ctx) {",
      "    // fetchOne(): not supplied by this skeleton",
      "    throw new Error(`make().sync is unimplemented (drain ${LIST_TOOL_ID})`);",
      "  },",
      "};",
    ].join("\n");

    expect(objectLiteralKeys(source, "return {")).toEqual(["serviceId", "sync"]);
  });

  it("ignores a comment inside the literal at its own depth", () => {
    const source = [
      "return {",
      "  // defaultIntervalMs: deliberately omitted",
      "  /* initialSyncDepthDays: also omitted */",
      "  serviceId: ID,",
      "};",
    ].join("\n");

    expect(objectLiteralKeys(source, "return {")).toEqual(["serviceId"]);
  });

  it("survives braces inside a template interpolation in a nested body", () => {
    // `${...}` moves the depth counter and must balance, or every later key is lost.
    const source = [
      "return {",
      "  sync(_ctx) {",
      "    throw new Error(`drain ${LIST_TOOL_ID} first`);",
      "  },",
      "  serviceId: ID,",
      "};",
    ].join("\n");

    expect(objectLiteralKeys(source, "return {")).toEqual(["sync", "serviceId"]);
  });

  it("sees only the first of two keys sharing a line — the safe direction", () => {
    // The pattern is anchored to line starts because the unanchored form is quadratic
    // (Sonar typescript:S8786). This is the cost, pinned so it is a known property rather than
    // a surprise: a missed key makes the harness report a member as NOT supplied, which is a
    // loud false red. Over-reporting would be a false green, which is what this module removed.
    const source = "return {\n  a: 1, b: 2,\n};";

    expect(objectLiteralKeys(source, "return {")).toEqual(["a"]);
  });

  it("throws rather than returning nothing when the opener is absent", () => {
    // An empty list would read as "the skeleton supplies no members", which the harness would
    // report as every member missing — a confusing failure in place of a precise one.
    expect(() => objectLiteralKeys("const x = 1;", "return {")).toThrow(/no `return \{`/);
  });

  it("throws when the literal is unterminated", () => {
    expect(() => objectLiteralKeys("return {\n  serviceId: ID,", "return {")).toThrow(
      /unterminated/,
    );
  });
});
