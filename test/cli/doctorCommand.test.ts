import { describe, expect, test } from "bun:test";
import { doctorToolParams } from "../../src/cli";

describe("doctorToolParams", () => {
  test("keeps CLI JSON formatting out of the daemon doctor request", () => {
    expect(doctorToolParams({ ios: true, json: true })).toEqual({ ios: true });
  });
});
