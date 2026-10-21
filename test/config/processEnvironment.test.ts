import { describe, expect, test } from "bun:test";
import { readProcessEnvByName } from "../../src/config/processEnvironment";

describe("name-based environment adapter lookup", () => {
  test("preserves raw values and arbitrary names without trimming or legacy fallback", () => {
    const env = { CUSTOM: "  value  ", EMPTY: "", AUTO_MOBILE_DATA_DIR: "/legacy" };
    expect(readProcessEnvByName("CUSTOM", env)).toBe("  value  ");
    expect(readProcessEnvByName("EMPTY", env)).toBe("");
    expect(readProcessEnvByName("MISSING", env)).toBeUndefined();
    expect(readProcessEnvByName("AUTOMOBILE_DATA_DIR", env)).toBeUndefined();
  });
});
