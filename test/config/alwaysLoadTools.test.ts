import { describe, expect, test } from "bun:test";
import { isAlwaysLoadToolsEnabled } from "../../src/config/alwaysLoadTools";

describe("isAlwaysLoadToolsEnabled", () => {
  test("is true only for the exact value true", () => {
    expect(isAlwaysLoadToolsEnabled({ AUTOMOBILE_ALWAYS_LOAD_TOOLS: "true" })).toBe(true);
    expect(isAlwaysLoadToolsEnabled({ AUTOMOBILE_ALWAYS_LOAD_TOOLS: "TRUE" })).toBe(false);
    expect(isAlwaysLoadToolsEnabled({ AUTOMOBILE_ALWAYS_LOAD_TOOLS: "1" })).toBe(false);
    expect(isAlwaysLoadToolsEnabled({})).toBe(false);
  });
});
