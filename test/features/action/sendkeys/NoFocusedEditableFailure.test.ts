import { describe, expect, test } from "bun:test";
import { EventAllTyper } from "../../../../src/features/action/sendkeys/EventAllTyper";
import { EventLastTyper } from "../../../../src/features/action/sendkeys/EventLastTyper";
import {
  ANDROID_TYPE_FOCUS_FAILURE,
  NO_FOCUSED_EDITABLE_ERROR_CODE,
  NoFocusedEditableError,
} from "../../../../src/features/action/sendkeys/AndroidTypingConstants";
import { ActionableError } from "../../../../src/models/ActionableError";
import { eventHost } from "./EventTyperTestHarness";

const NO_FOCUS_MESSAGE =
  "No editable field has focus. Focus the target field first (tap it, or tapOn with focus), then retry sendKeys without a mode.";
/** Every Android typing mode name; the no-focus remedy must name none of them (#17165). */
const TYPING_MODE_NAMES = /\b(?:imeKeyEvents|eventAll|eventLast|eventOnly|a11y|ime|auto)\b/;

/** An event host whose focus precheck finds no focused editable field. */
function unfocusedHost() {
  const harness = eventHost();
  harness.host.requireFocusedAndroidInput = async (_signal, failure) => ({
    success: false,
    error: failure?.error ?? "missing failure",
    ...(failure?.errorCode === undefined ? {} : { errorCode: failure.errorCode }),
  });
  return harness;
}

describe("no focused editable field (#17165)", () => {
  test("the type failure carries a stable code and names no typing mode", () => {
    expect(ANDROID_TYPE_FOCUS_FAILURE).toEqual({
      error: NO_FOCUS_MESSAGE,
      errorCode: "NO_FOCUSED_EDITABLE",
    });
    expect(NO_FOCUS_MESSAGE).not.toMatch(TYPING_MODE_NAMES);
    expect(NO_FOCUS_MESSAGE).not.toContain("event delivery");
  });

  test("the thrown form is actionable and carries the same code", () => {
    const error = new NoFocusedEditableError();
    expect(error).toBeInstanceOf(ActionableError);
    expect(error.message).toBe(NO_FOCUS_MESSAGE);
    expect(error.errorCode).toBe(NO_FOCUSED_EDITABLE_ERROR_CODE);
  });

  test("eventAll precheck returns the code without dispatching", async () => {
    const { host, calls } = unfocusedHost();
    const result = await new EventAllTyper(host).type({ text: "ab", operation: "insert" });
    expect(result).toEqual({
      success: false,
      error: NO_FOCUS_MESSAGE,
      errorCode: "NO_FOCUSED_EDITABLE",
    });
    expect(calls.some((call) => typeof call === "object" && call && "plan" in call)).toBe(false);
  });

  test("eventLast precheck returns the code without dispatching", async () => {
    const { host, calls } = unfocusedHost();
    const result = await new EventLastTyper(host).type({ text: "😀a", operation: "insert" });
    expect(result).toEqual({
      success: false,
      error: NO_FOCUS_MESSAGE,
      errorCode: "NO_FOCUSED_EDITABLE",
    });
    expect(calls).toEqual([]);
  });
});
