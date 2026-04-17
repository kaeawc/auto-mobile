import { describe, expect, test } from "bun:test";
import { describeUnknownError } from "../../src/utils/describeUnknownError";

describe("describeUnknownError", () => {
  test("formats Error with message and truncated stack", () => {
    const err = new Error("boom");
    const s = describeUnknownError(err);
    expect(s).toContain("Error");
    expect(s).toContain("boom");
  });

  test("empty object explains missing keys", () => {
    expect(describeUnknownError({})).toContain("no enumerable keys");
  });

  test("nested Error cause", () => {
    const inner = new Error("inner");
    const outer = new Error("outer", { cause: inner });
    const s = describeUnknownError(outer);
    expect(s).toContain("outer");
    expect(s).toContain("cause=");
    expect(s).toContain("inner");
  });
});
