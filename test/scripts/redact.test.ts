/**
 * Unit tests for the harness's credential redaction.
 *
 * These exist because CodeQL flagged the original of scripts/runtime-acceptance.ts for
 * clear-text logging of sensitive information: six checks echoed bearer tokens, an API key
 * and a `client_secret=` form body straight to stdout, and that output lands in CI logs.
 *
 * The contract is stronger than "do not print the whole secret", and that is what the last
 * two tests in each block pin. Every returned value must be a string LITERAL selected by a
 * comparison — no prefix, no length, no regex capture, no parsed field name — because
 * anything derived from the credential carries its taint. An earlier attempt returned
 * `${scheme}, unexpected value`, pulling the auth scheme out with a regex; that is not a
 * secret and it still got the file re-flagged. So the assertions below are not only "the
 * verdict is right" but "the secret does not appear in the output, in any form".
 */

import { describe, expect, it } from "bun:test";
import { describeAuth, describeFormFields } from "../../scripts/_lib/redact.ts";

describe("describeAuth", () => {
  it("reports an absent header as absent", () => {
    expect(describeAuth(undefined, "Bearer tok-123")).toBe("absent");
  });

  it("reports a header that matches what the harness expected", () => {
    expect(describeAuth("Bearer tok-123", "Bearer tok-123")).toBe("present, as expected");
  });

  it("reports a mismatch without saying what arrived", () => {
    expect(describeAuth("Bearer wrong-token", "Bearer tok-123")).toBe("present, unexpected value");
  });

  it("distinguishes absent from wrong — they are different defects", () => {
    // "absent" means the connector never sent the header; "unexpected value" means it sent
    // the wrong credential. Collapsing them sends a reader to the wrong half of the emitter.
    expect(describeAuth(undefined, "x")).not.toBe(describeAuth("y", "x"));
  });

  it("never emits the credential, or any substring of it, on the mismatch path", () => {
    const secret = "Bearer sk-live-4f9a2c7e-DO-NOT-LOG";

    const out = describeAuth(secret, "Bearer expected");

    expect(out).toBe("present, unexpected value");
    // Every window of the secret, so a "just the scheme" or "just the prefix" regression is
    // caught rather than only a whole-value leak.
    for (let i = 0; i + 4 <= secret.length; i++) {
      expect(out).not.toContain(secret.slice(i, i + 4));
    }
  });

  it("never emits the credential on the matching path either", () => {
    const secret = "Bearer sk-live-4f9a2c7e";

    expect(describeAuth(secret, secret)).toBe("present, as expected");
  });

  it("returns one of exactly three fixed strings, whatever it is given", () => {
    const allowed = new Set(["absent", "present, as expected", "present, unexpected value"]);
    const inputs: Array<string | undefined> = [undefined, "", "Basic abc", "Bearer x", "expected"];

    for (const value of inputs) expect(allowed.has(describeAuth(value, "expected"))).toBe(true);
  });
});

describe("describeFormFields", () => {
  const EXPECTED = ["grant_type", "client_id", "client_secret"];

  it("reports an absent body as empty", () => {
    expect(describeFormFields(undefined, EXPECTED)).toBe("(empty)");
  });

  it("reports an empty-string body as empty rather than as missing fields", () => {
    // A GET or DELETE records body "" — that is "there was no body", not "the token
    // exchange omitted client_secret", and conflating them mislabels the failure.
    expect(describeFormFields("", EXPECTED)).toBe("(empty)");
  });

  it("confirms a body that carries every expected field", () => {
    const body = "grant_type=client_credentials&client_id=id-1&client_secret=secret-1";

    expect(describeFormFields(body, EXPECTED)).toBe("carries the expected fields");
  });

  it("reports a body missing one of the expected fields", () => {
    expect(describeFormFields("grant_type=client_credentials&client_id=id-1", EXPECTED)).toBe(
      "missing expected field(s)",
    );
  });

  it("accepts extra fields it was not asked about", () => {
    const body = "grant_type=x&client_id=y&client_secret=z&scope=read";

    expect(describeFormFields(body, EXPECTED)).toBe("carries the expected fields");
  });

  it("checks presence, not value — an empty-valued field is still present", () => {
    // `params.has(name)` is the contract. Reading the value would be reading the secret.
    expect(describeFormFields("grant_type=&client_id=&client_secret=", EXPECTED)).toBe(
      "carries the expected fields",
    );
  });

  it("never emits the secret, or a field name parsed out of it, in either verdict", () => {
    const carrying =
      "grant_type=client_credentials&client_id=acme&client_secret=hunter2-DO-NOT-LOG";
    const missing = "grant_type=client_credentials&client_secret=hunter2-DO-NOT-LOG";

    expect(describeFormFields(carrying, EXPECTED)).toBe("carries the expected fields");
    expect(describeFormFields(missing, EXPECTED)).toBe("missing expected field(s)");
    for (const out of [
      describeFormFields(carrying, EXPECTED),
      describeFormFields(missing, EXPECTED),
    ]) {
      expect(out).not.toContain("hunter2");
      expect(out).not.toContain("acme");
      expect(out).not.toContain("client_secret");
    }
  });
});
