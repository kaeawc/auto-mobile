import { describe, expect, test } from "bun:test";
import { semanticKeyFailure } from "../../../../src/features/action/sendkeys/SemanticKeyFailure";

describe("semanticKeyFailure (#17463)", () => {
  test("a bare or missing device error becomes a typed failure with alternatives", () => {
    expect(semanticKeyFailure("previous", { approximated: true })).toEqual({
      error:
        'key "previous" was not applied: no previous focusable field was found beside the focused field. Use sendKeys with a selector for the previous field.',
      errorCode: "EDITOR_ACTION_MISMATCH",
    });
    expect(semanticKeyFailure("search", { error: "Action failed" })).toEqual({
      error:
        'key "search" was not applied: the device reported the "search" action as not performed; the field may not accept it, or the key could not be delivered. Tap the screen\'s submit control, or on a single-line field use key:"enter"; observe the result before retrying.',
      errorCode: "EDITOR_ACTION_MISMATCH",
    });
    expect(semanticKeyFailure("next", {})).toEqual({
      error:
        'key "next" was not applied: the focused field did not perform the "next" editor action; its configured action may be another one, such as done. Use key:"tab" to move focus, or sendKeys with a selector for the next field.',
      errorCode: "EDITOR_ACTION_MISMATCH",
    });
  });

  test("a device error that already says why is left alone", () => {
    expect(
      semanticKeyFailure("next", { error: "No focused editable node found for IME action" }),
    ).toBeUndefined();
  });
});
