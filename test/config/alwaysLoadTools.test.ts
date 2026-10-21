import { describe, expect, test } from "bun:test";
import { isAlwaysLoadToolsEnabled } from "../../src/config/alwaysLoadTools";

describe("isAlwaysLoadToolsEnabled", () => {
  test("follows the shared flag rule", () => {
    expect(isAlwaysLoadToolsEnabled({ AUTOMOBILE_ALWAYS_LOAD_TOOLS: "true" })).toBe(true);
    expect(isAlwaysLoadToolsEnabled({ AUTOMOBILE_ALWAYS_LOAD_TOOLS: "TRUE" })).toBe(true);
    expect(isAlwaysLoadToolsEnabled({ AUTOMOBILE_ALWAYS_LOAD_TOOLS: "1" })).toBe(true);
    expect(isAlwaysLoadToolsEnabled({ AUTOMOBILE_ALWAYS_LOAD_TOOLS: "false" })).toBe(false);
    expect(isAlwaysLoadToolsEnabled({})).toBe(false);
  });
});
