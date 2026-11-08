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
        'key "search" was not applied: the focused field rejected the "search" editor action; its configured action may be another one, such as done. Use key:"enter", or tap the screen\'s submit control.',
      errorCode: "EDITOR_ACTION_MISMATCH",
    });
  });

  test("a device error that already says why is left alone", () => {
    expect(
      semanticKeyFailure("next", { error: "No focused editable node found for IME action" }),
    ).toBeUndefined();
  });
});
