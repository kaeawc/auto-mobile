import { describe, expect, test } from "bun:test";
import { withEpilogueWarning } from "../../src/utils/bestEffortEpilogue";

// #6868: a best-effort post-action epilogue (keyboard dismissal, cleanup) that
// fails must degrade to a `warnings[]` entry on an otherwise-successful result,
// never promote the whole call to an error.
describe("withEpilogueWarning", () => {
  test("returns the result untouched when the epilogue succeeded", () => {
    const result = { success: true, text: "hello" };

    expect(withEpilogueWarning(result, null)).toBe(result);
    expect(withEpilogueWarning(result, undefined)).toBe(result);
    expect(withEpilogueWarning(result, "")).toBe(result);
  });

  test("appends the warning without touching success", () => {
    const warned = withEpilogueWarning({ success: true, text: "hello" }, "cleanup failed: boom");

    expect(warned.success).toBe(true);
    expect(warned.warnings).toEqual(["cleanup failed: boom"]);
  });

  test("preserves warnings already on the result rather than replacing them", () => {
    const warned = withEpilogueWarning({ success: true, warnings: ["first"] }, "second");

    expect(warned.warnings).toEqual(["first", "second"]);
  });

  test("does not mutate the result it was given", () => {
    const result = { success: true, warnings: ["first"] };
    withEpilogueWarning(result, "second");

    expect(result.warnings).toEqual(["first"]);
  });
});
