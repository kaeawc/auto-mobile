import { expect, test } from "bun:test";
import { imeActionFailedAfterTextEntered } from "../../../src/features/action/imeActionFailedAfterTextEntered";

test("preserves the action, reason, and existing do-not-retype wording", () => {
  expect(imeActionFailedAfterTextEntered("next", "No element has keyboard focus")).toBe(
    "IME action 'next' failed after the text was entered: No element has keyboard focus. Do not retype the text.",
  );
});
