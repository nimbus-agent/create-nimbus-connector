import { describe, expect, it } from "bun:test";
import { isMissingModule } from "../src/optional-dep.ts";

describe("isMissingModule", () => {
  it("matches when the structured specifier field names the module itself", () => {
    const err = { code: "ERR_MODULE_NOT_FOUND", specifier: "@babel/parser" };
    expect(isMissingModule(err, "@babel/parser")).toBe(true);
  });

  it("rejects when the structured specifier names a DIFFERENT module", () => {
    // The package resolved; one of ITS imports did not. Reporting this as "not installed"
    // sends the user to reinstall a package that is already there.
    const err = { code: "ERR_MODULE_NOT_FOUND", specifier: "@babel/helper-validator" };
    expect(isMissingModule(err, "@babel/parser")).toBe(false);
  });

  it("accepts the MODULE_NOT_FOUND spelling", () => {
    const err = { code: "MODULE_NOT_FOUND", specifier: "@babel/parser" };
    expect(isMissingModule(err, "@babel/parser")).toBe(true);
  });

  it("falls back to the message only when the structured field is absent", () => {
    const err = { code: "ERR_MODULE_NOT_FOUND", message: "Cannot find module '@babel/parser'" };
    expect(isMissingModule(err, "@babel/parser")).toBe(true);
  });

  it("rejects any error without a module-resolution code", () => {
    expect(isMissingModule(new TypeError("boom"), "@babel/parser")).toBe(false);
    expect(isMissingModule({ code: "EACCES", specifier: "@babel/parser" }, "@babel/parser")).toBe(
      false,
    );
  });

  it("rejects non-objects rather than throwing", () => {
    expect(isMissingModule(undefined, "x")).toBe(false);
    expect(isMissingModule(null, "x")).toBe(false);
    expect(isMissingModule("a string", "x")).toBe(false);
  });
});
