import { describe, expect, test } from "bun:test";
import { PROTOTYPE_DISMISS_ID } from "../../../src/features/prototype/prototypeHostControls";
import { prototypeReservedTestTagError } from "../../../src/features/prototype/prototypePlatform";
import { validatePrototypeSpec } from "../../../src/features/prototype/prototypeValidation";

function specWith(testTag: string) {
  return {
    id: "p",
    window: { placement: { type: "fullscreen" } },
    root: {
      type: "column",
      children: [
        { type: "text", text: "x" },
        { type: "text", text: "y", testTag },
      ],
    },
  };
}

describe("the automobile- testTag namespace is host-owned (#15120)", () => {
  test("a tag that takes a host control id or any automobile- tag is rejected with its path", () => {
    for (const tag of [
      PROTOTYPE_DISMISS_ID,
      "automobile-prototype-window",
      "automobile-future-id",
    ]) {
      const result = validatePrototypeSpec(specWith(tag));
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.path).toBe("root.children[1].testTag");
        expect(result.error.message).toContain("automobile-");
      }
    }
  });

  test("near misses stay valid", () => {
    for (const tag of ["automobile", "Automobile-x", "my-automobile-x", "auto-mobile-x"]) {
      expect(validatePrototypeSpec(specWith(tag)).success).toBe(true);
    }
  });

  test("the check reports the first reserved node and ignores non-string tags", () => {
    expect(prototypeReservedTestTagError([])).toBeUndefined();
    expect(
      prototypeReservedTestTagError([
        { value: { testTag: 4 }, path: "root" },
        { value: { testTag: "ok" }, path: "root.a" },
        { value: { testTag: "automobile-a" }, path: "root.b" },
        { value: { testTag: "automobile-c" }, path: "root.c" },
      ])?.path,
    ).toBe("root.b.testTag");
  });
});
