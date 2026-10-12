import { describe, expect, test } from "bun:test";
import {
  findValueOperand,
  findValueOperands,
  parseBooleanFlagValue,
  readBooleanFlag,
  readValueOperand,
  splitFlagToken,
} from "../../src/utils/flagTokens";

describe("splitFlagToken", () => {
  test.each([
    ["--port=3001", "--port", "3001"],
    ["--host=a=b", "--host", "a=b"],
    ["--host=", "--host", ""],
    ["--host=--x", "--host", "--x"],
    ["--port", "--port", undefined],
    ["plain=word", "plain=word", undefined],
    ["--=x", "--=x", undefined],
    ["-v=1", "-v", "1"],
  ])("%j", (token, flag, inlineValue) => {
    expect(splitFlagToken(token)).toEqual({ flag, inlineValue });
  });
});

describe("readValueOperand", () => {
  test("separate and inline forms give the same flag and value", () => {
    expect(readValueOperand(["--port", "1"], 0)).toMatchObject({
      flag: "--port",
      value: "1",
      last: 1,
    });
    expect(readValueOperand(["--port=1"], 0)).toMatchObject({
      flag: "--port",
      value: "1",
      last: 0,
    });
  });

  test("a following flag is not swallowed, a negative number is a value", () => {
    expect(readValueOperand(["--port", "--debug"], 0)).toMatchObject({ value: undefined, last: 0 });
    expect(readValueOperand(["--wait-ms", "-5"], 0)).toMatchObject({ value: "-5", last: 1 });
    expect(readValueOperand(["--port"], 0)).toMatchObject({ value: undefined, last: 0 });
    expect(readValueOperand(["--port", "--"], 0)).toMatchObject({ value: undefined });
  });
});

describe("findValueOperands", () => {
  test("finds every occurrence in either form and stops at --", () => {
    const found = findValueOperands(["--a=1", "x", "--a", "2", "--", "--a=3"], ["--a"]);
    expect(found.map((operand) => operand.value)).toEqual(["1", "2"]);
  });

  test("a value equal to another flag's name is skipped, not re-read", () => {
    expect(findValueOperand(["--a", "--b"], ["--b"])?.value).toBeUndefined();
    expect(findValueOperands(["--a", "--b=1"], ["--a"])[0].value).toBeUndefined();
  });
});

describe("boolean flags", () => {
  test("parseBooleanFlagValue", () => {
    expect([undefined, "true", "false", "maybe", "", "1"].map(parseBooleanFlagValue)).toEqual([
      true,
      true,
      false,
      undefined,
      undefined,
      undefined,
    ]);
  });

  test("readBooleanFlag: absent, last wins, invalid warned and ignored, stops at --", () => {
    const warnings: string[] = [];
    const log = { warn: (message: string) => warnings.push(message) };
    expect(readBooleanFlag(["--x"], ["--y"], log)).toBeUndefined();
    expect(readBooleanFlag(["--x", "--x=false"], ["--x"], log)).toBe(false);
    expect(readBooleanFlag(["--x=false", "--x"], ["--x"], log)).toBe(true);
    expect(readBooleanFlag(["--x=maybe"], ["--x"], log)).toBeUndefined();
    expect(warnings.join("\n")).toContain("--x");
    expect(readBooleanFlag(["--", "--x"], ["--x"], log)).toBeUndefined();
    expect(readBooleanFlag(["--old"], ["--new", "--old"], log)).toBe(true);
  });
});
