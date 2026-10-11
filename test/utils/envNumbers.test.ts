import { describe, expect, test } from "bun:test";
import { readEnvPositiveInteger } from "../../src/utils/envNumbers";

const spec = { names: ["PRIMARY_MS", "LEGACY_MS"], fallback: 7000 };

function read(env: NodeJS.ProcessEnv, overrides: { min?: number } = {}) {
  const warnings: string[] = [];
  const value = readEnvPositiveInteger({ ...spec, ...overrides }, env, {
    warn: (message) => warnings.push(message),
  });
  return { value, warnings };
}

describe("readEnvPositiveInteger", () => {
  test("a plain integer is used, trimmed, from either name", () => {
    expect(read({ PRIMARY_MS: "1500" })).toEqual({ value: 1500, warnings: [] });
    expect(read({ LEGACY_MS: " 1500 " })).toEqual({ value: 1500, warnings: [] });
  });

  test("the first name that is set decides, even when it is unusable", () => {
    expect(read({ PRIMARY_MS: "x", LEGACY_MS: "1500" }).value).toBe(7000);
  });

  test("unset and empty are the default without a warning", () => {
    expect(read({})).toEqual({ value: 7000, warnings: [] });
    expect(read({ PRIMARY_MS: "  " })).toEqual({ value: 7000, warnings: [] });
  });

  test.each(["2m", "120s", "1e5", "1.5", "-3", "0", "+4", "0x10", "12abc", "9007199254740993"])(
    "%j falls back and the warning names the variable and the value",
    (raw) => {
      const { value, warnings } = read({ PRIMARY_MS: raw });
      expect(value).toBe(7000);
      expect(warnings).toHaveLength(1);
      expect(warnings[0]).toContain("PRIMARY_MS");
      expect(warnings[0]).toContain(JSON.stringify(raw.trim()));
    },
  );

  test("a value below min falls back to the default", () => {
    expect(read({ PRIMARY_MS: "100" }, { min: 500 }).value).toBe(7000);
    expect(read({ PRIMARY_MS: "500" }, { min: 500 }).value).toBe(500);
  });

  test("the same bad value warns once per process", () => {
    const first = read({ PRIMARY_MS: "dedupe-me" });
    const second = read({ PRIMARY_MS: "dedupe-me" });
    expect(first.warnings).toHaveLength(1);
    expect(second.warnings).toHaveLength(0);
  });
});
