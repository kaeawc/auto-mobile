import { describe, expect, test } from "bun:test";
import { compareIosTypedText } from "../../../src/features/action/iosTypedTextVerification";
import { typedObservation } from "./IosTypedTextTestHarness";
import { createSendKeysHarness, ios } from "./SendKeysTestHarness";

const omittedNative = { secure: false, iosNativeValueOmitted: true } as const;

describe("iOS sendKeys: a missing native baseline value reads as blank (#17764)", () => {
  test("verified when the typed text appears after typing", async () => {
    let reads = 0;
    const h = createSendKeysHarness(ios, {
      execute: async () =>
        reads++ === 0 ? typedObservation("", false, true) : typedObservation("x"),
    });
    const result = await h.executor.type({ action: "type", text: "x" });
    expect(result).toMatchObject({ success: true });
    expect(result.warning).toBeUndefined();
    expect(h.inserted).toEqual(["x"]);
  });

  test("not verified when the field stays empty after typing", async () => {
    let reads = 0;
    const h = createSendKeysHarness(ios, {
      execute: async () =>
        reads++ === 0 ? typedObservation("", false, true) : typedObservation(""),
    });
    const result = await h.executor.type({ action: "type", text: "x" });
    expect(result.success).toBe(false);
    expect(result.error).toContain("nothing was typed");
  });

  test("an omitted native baseline is blank for whole-text and append comparisons", () => {
    for (const options of [false, { verifyAppend: true, firstChunk: true }]) {
      expect(
        compareIosTypedText("x", omittedNative, { secure: false, value: "x" }, options),
      ).toEqual({ success: true });
      expect(
        compareIosTypedText("x", omittedNative, { secure: false, value: "" }, options).success,
      ).toBe(false);
    }
  });

  test("an unreadable after value and an unflagged missing baseline stay unverified", () => {
    expect(compareIosTypedText("x", omittedNative, { secure: false }).warning).toContain(
      "could not be read",
    );
    expect(
      compareIosTypedText("x", { secure: false }, { secure: false, value: "x" }).warning,
    ).toContain("could not be read");
  });

  test.each([
    { before: "ab", after: "abx", success: true, error: undefined },
    { before: "ab", after: "ab", success: false, error: "nothing was typed" },
  ])(
    "non-empty baseline $before -> $after is unchanged",
    async ({ before, after, success, error }) => {
      let reads = 0;
      const h = createSendKeysHarness(ios, {
        execute: async () => typedObservation(reads++ === 0 ? before : after),
      });
      const result = await h.executor.type({ action: "type", text: "x" });
      expect(result.success).toBe(success);
      if (error === undefined) {
        expect(result.warning).toBeUndefined();
      } else {
        expect(result.error).toContain(error);
      }
    },
  );
});
