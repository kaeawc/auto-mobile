import { expect, test } from "bun:test";
import { getFocusedTextField } from "../../../src/features/action/ClearText";
import {
  IOS_FOCUSED_VALUE_READ_WINDOW,
  compareIosTypedText,
  describeIosCommittedText,
  verifyIosTypedText,
} from "../../../src/features/action/iosTypedTextVerification";
import { FakeTimer } from "../../fakes/FakeTimer";
import capturedFocusedNode from "../../fixtures/ios-typed-text/focused-element-long-value.json";
import { typedObservation } from "./IosTypedTextTestHarness";

const readWindow = IOS_FOCUSED_VALUE_READ_WINDOW;
const observation = {
  ...typedObservation(""),
  viewHierarchy: { hierarchy: { node: { $: capturedFocusedNode } } },
};
const capturedField = getFocusedTextField(observation.viewHierarchy, undefined, {
  includeIosNativeEditableValues: true,
});

test("an unchanged captured XCUI value filling the read window cannot prove nothing was typed", () => {
  expect(readWindow).toBe(512);
  expect(capturedField?.value).toBe(capturedFocusedNode.value);
  expect(capturedField?.value).toHaveLength(readWindow);
  const result = compareIosTypedText("Scheduled", capturedField, capturedField);
  expect(result.success).toBe(true);
  expect(result.error).toBeUndefined();
  expect(result.warning).toContain("not verified");
  expect(result.warning).toContain("512-character read window");
  expect(result.warning).not.toContain(capturedFocusedNode.value);
});

test("verifyIosTypedText accepts the unchanged captured focused node through a fake observer", async () => {
  let reads = 0;
  const result = await verifyIosTypedText("Scheduled", capturedField, {
    observer: {
      execute: async (options) => {
        reads++;
        expect(options).toMatchObject({ freshness: "fresh", skipScreenshot: true });
        return observation;
      },
    },
    timer: new FakeTimer(),
  });
  expect(reads).toBe(1);
  expect(result.success).toBe(true);
  expect(result.error).toBeUndefined();
  expect(result.warning).toContain("not verified");
  expect(result.warning).toContain("512-character read window");
  expect(result.warning).not.toContain(capturedFocusedNode.value);
});

for (const length of [readWindow, readWindow + 1, 700]) {
  test(`a changed ${length}-character value warns without exposing the read window`, () => {
    const after = capturedFocusedNode.value.padEnd(length, "x");
    const result = compareIosTypedText(
      "Scheduled",
      { secure: false, value: "old" },
      { secure: false, value: after },
    );
    expect(result.success).toBe(true);
    expect(result.error).toBeUndefined();
    expect(result.warning).toContain("not verified");
    expect(result.warning).toContain("512-character read window");
    expect(result.warning).not.toContain(capturedFocusedNode.value);
    expect(result.warning).not.toContain("observed value");
  });
}

for (const value of ["old", capturedFocusedNode.value.slice(0, readWindow - 1)]) {
  test(`an unchanged ${value.length}-character value still proves nothing was typed`, () => {
    const field = { secure: false, value };
    expect(compareIosTypedText("Scheduled", field, field)).toEqual({
      success: false,
      error: "iOS nothing was typed: the focused field value is unchanged.",
    });
  });
}

for (const before of ["old", capturedFocusedNode.value, undefined]) {
  test(`timeout readback with ${before === undefined ? "unreadable" : before.length}-character prior value treats a full window as unknown`, () => {
    const description = describeIosCommittedText(
      "Scheduled",
      { secure: false, value: before },
      capturedField,
    );
    expect(description).toContain("512-character read window");
    expect(description).toContain("what was committed is unknown");
    expect(description).not.toContain("unchanged");
    expect(description).not.toContain(capturedFocusedNode.value);
  });
}
