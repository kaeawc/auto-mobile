import { describe, expect, test } from "bun:test";
import { resolveSharpFactory } from "../../../src/utils/image/loadSharp";

describe("resolveSharpFactory", () => {
  test("returns the default export from a module namespace", () => {
    const factory = () => {};
    expect(resolveSharpFactory({ default: factory })).toBe(factory);
  });

  test("returns the legacy callable module itself when there is no default export", () => {
    const mod = () => {};
    expect(resolveSharpFactory(mod)).toBe(mod);
  });

  test("prefers the default export even when the module itself is callable", () => {
    const factory = () => {};
    const mod = Object.assign(() => {}, { default: factory });
    expect(resolveSharpFactory(mod)).toBe(factory);
  });

  test("retains the legacy fallback for a nullish default export", () => {
    const mod = Object.assign(() => {}, { default: undefined });
    expect(resolveSharpFactory(mod)).toBe(mod);
  });
});
