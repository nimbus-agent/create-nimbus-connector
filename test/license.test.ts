import { describe, expect, it } from "bun:test";
import {
  DEFAULT_STANDALONE_LICENSE,
  defaultLicenseFor,
  MONOREPO_LICENSE,
  validateLicense,
} from "../src/license.ts";

describe("license defaults", () => {
  it("keeps the monorepo target on AGPL-3.0-only", () => {
    expect(MONOREPO_LICENSE).toBe("AGPL-3.0-only");
    expect(defaultLicenseFor("monorepo")).toBe("AGPL-3.0-only");
  });

  it("defaults a standalone package to UNLICENSED, not the monorepo's copyleft stamp", () => {
    // A standalone package is the user's own code, produced by an MIT tool and depending
    // only on the MIT SDK — nothing about it obliges copyleft.
    expect(DEFAULT_STANDALONE_LICENSE).toBe("UNLICENSED");
    expect(defaultLicenseFor("standalone")).toBe("UNLICENSED");
    expect(defaultLicenseFor("standalone")).not.toBe(MONOREPO_LICENSE);
  });
});

describe("validateLicense", () => {
  it("accepts plain SPDX identifiers", () => {
    for (const v of ["MIT", "Apache-2.0", "AGPL-3.0-only", "UNLICENSED", "BSD-3-Clause"]) {
      expect(validateLicense(v)).toBe(v);
    }
  });

  it("accepts expressions, exceptions, references and the + suffix", () => {
    for (const v of [
      "MIT OR Apache-2.0",
      "(MIT OR Apache-2.0) AND CC0-1.0",
      "GPL-2.0-or-later WITH Bison-exception-2.2",
      "LicenseRef-Acme-Internal",
      "LGPL-2.1+",
    ]) {
      expect(validateLicense(v)).toBe(v);
    }
  });

  it("trims surrounding whitespace rather than rejecting it", () => {
    expect(validateLicense("  MIT \n")).toBe("MIT");
  });

  it("rejects empty and whitespace-only values", () => {
    expect(() => validateLicense("")).toThrow(/non-empty/i);
    expect(() => validateLicense("   ")).toThrow(/non-empty/i);
    expect(() => validateLicense("\t\n")).toThrow(/non-empty/i);
  });

  it("rejects characters that cannot appear in an SPDX expression, naming them", () => {
    expect(() => validateLicense("MIT!")).toThrow(/"!"/);
    expect(() => validateLicense('MIT", "evil')).toThrow(/cannot appear/i);
    expect(() => validateLicense("MIT/Apache-2.0")).toThrow(/"\/"/);
  });

  it("rejects malformed expressions, saying what is wrong", () => {
    expect(() => validateLicense("MIT OR")).toThrow(/ends with an operator/i);
    expect(() => validateLicense("OR MIT")).toThrow(/license identifier was expected/i);
    expect(() => validateLicense("(MIT")).toThrow(/unbalanced "\("/);
    expect(() => validateLicense("MIT)")).toThrow(/unbalanced "\)"/);
    expect(() => validateLicense("MIT Apache-2.0")).toThrow(/operator \(AND, OR, WITH\)/);
  });

  it("names the real problem when an operator is lowercase", () => {
    // SPDX operators are uppercase; "MIT or Apache-2.0" is by far the likeliest mistake,
    // and "unexpected token" would not tell the user what to change.
    expect(() => validateLicense("MIT or Apache-2.0")).toThrow(/must be uppercase \("OR"\)/);
    expect(() => validateLicense("MIT and CC0-1.0")).toThrow(/must be uppercase \("AND"\)/);
  });

  it("rejects npm's non-SPDX 'SEE LICENSE IN' form by name", () => {
    expect(() => validateLicense("SEE LICENSE IN LICENSE.txt")).toThrow(/SEE LICENSE IN/);
    expect(() => validateLicense("SEE LICENSE IN LICENSE.txt")).toThrow(/not an SPDX expression/i);
  });
});
