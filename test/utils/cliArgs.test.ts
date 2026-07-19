import { describe, expect, test } from "bun:test";
import { firstFlagValue } from "../../src/utils/cliArgs";

describe("firstFlagValue", () => {
  test("reads the space-separated form", () => {
    expect(firstFlagValue(["--flag", "value"], ["--flag"])).toBe("value");
  });

  test("reads the inline =value form", () => {
    expect(firstFlagValue(["--flag=value"], ["--flag"])).toBe("value");
  });

  test("returns undefined when the value is a following flag", () => {
    expect(firstFlagValue(["--flag", "--other"], ["--flag"])).toBeUndefined();
  });

  test("returns undefined when the flag has no value", () => {
    expect(firstFlagValue(["--flag"], ["--flag"])).toBeUndefined();
  });

  test("returns undefined when no flag matches", () => {
    expect(firstFlagValue(["--other", "x"], ["--flag"])).toBeUndefined();
  });

  test("matches any flag alias", () => {
    expect(firstFlagValue(["--alias", "v"], ["--flag", "--alias"])).toBe("v");
    expect(firstFlagValue(["--alias=v"], ["--flag", "--alias"])).toBe("v");
  });

  test("empty inline value yields empty string, not undefined", () => {
    expect(firstFlagValue(["--flag="], ["--flag"])).toBe("");
  });
});
