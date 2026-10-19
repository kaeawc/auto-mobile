import { describe, expect, test } from "bun:test";
import { resolveSharpFactory } from "../../../src/utils/image/loadSharp";

describe("resolveSharpFactory", () => {
  test("returns the default export from a module namespace", () => {
    const factory = () => {};
    expect(Object.is(resolveSharpFactory({ default: factory }), factory)).toBe(true);
  });

  test("returns the legacy callable module itself when there is no default export", () => {
    const mod = () => {};
    expect(Object.is(resolveSharpFactory(mod), mod)).toBe(true);
  });

  test("prefers the default export even when the module itself is callable", () => {
    const factory = () => {};
    const mod = () => {};
    mod.default = factory;
    expect(Object.is(resolveSharpFactory(mod), factory)).toBe(true);
  });

  test("retains the legacy fallback for a nullish default export", () => {
    const mod = () => {};
    mod.default = undefined;
    expect(Object.is(resolveSharpFactory(mod), mod)).toBe(true);
  });
});
