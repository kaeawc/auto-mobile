import { describe, expect, test } from "bun:test";
import { SetUIState } from "../../../src/features/action/SetUIState";
import type { ObserveResult } from "../../../src/models";
import { FakeTimer } from "../../fakes/FakeTimer";
import {
  FakeClearText,
  FakeInputText,
  FakeObserveScreenForSetUIState,
  FakeSwipeOn,
  FakeTapOnElement,
} from "../../fakes/FakeSetUIStateDependencies";
import clearedCapture from "../../fixtures/ios-safari-url-field/runner-cleared-keyboard-up.json";
import typedCapture from "../../fixtures/ios-safari-url-field/runner-typed-keyboard-up.json";
import { observationFromRunnerCapture } from "../../helpers/iosRunnerCapture";

// Round 5 of #15175 (issue #15212): on Safari's address field a `setUIState` clear (`value: ""`)
// cleared the field but reported failure after about 30 s, because the step after the verified
// clear typed the empty string and the iOS typed-text read-back rejected that no-op. The
// observations are the real iOS 27.0 runner captures of the field holding text, then blank.

const NOTHING_TYPED = "iOS nothing was typed: the focused field value is unchanged.";

function harness(options: { observations: ObserveResult[] }) {
  const timer = new FakeTimer();
  timer.enableAutoAdvance();
  const tap = new FakeTapOnElement();
  const input = new FakeInputText();
  // What the live InputText did with an empty string: the typed-text check rejected the no-op.
  input.setResultForText("", { success: false, error: NOTHING_TYPED, text: "" });
  const clear = new FakeClearText();
  const observe = new FakeObserveScreenForSetUIState();
  let reads = 0;
  observe.setResultFactory(() => {
    const index = Math.min(reads, options.observations.length - 1);
    reads++;
    return options.observations[index];
  });
  const action = new SetUIState(
    { name: "iPhone 18 Pro", platform: "ios", deviceId: "fake-ios" },
    null,
    {
      timer,
      tapOnElement: tap,
      inputText: input,
      clearText: clear,
      swipeOn: new FakeSwipeOn(),
      observeScreen: observe,
    },
  );
  return { action, input, clear };
}

describe("SetUIState empty value on Safari's address field (#15212)", () => {
  test("clearing a typed URL succeeds once the clear step ran, without typing an empty string", async () => {
    const typed = observationFromRunnerCapture(typedCapture);
    const cleared = observationFromRunnerCapture(clearedCapture);
    const { action, input, clear } = harness({ observations: [typed, cleared] });

    const result = await action.execute({
      fields: [{ selector: { text: "Address" }, value: "" }],
    });

    expect(result.fields[0].error).toBeUndefined();
    expect(result.success).toBe(true);
    expect(result.fields[0]).toMatchObject({ success: true, attempts: 1 });
    expect(clear.getCallCount()).toBe(1);
    expect(input.getCallCount()).toBe(0);
  });

  test("still types a non-empty value after the clear", async () => {
    const typed = observationFromRunnerCapture(typedCapture);
    const { action, input } = harness({ observations: [typed] });

    await action.execute({ fields: [{ selector: { text: "Address" }, value: "x" }] });

    expect(input.getCalls().map((call) => call.text)).toContain("x");
  });

  test("a failed clear still fails the empty-value call", async () => {
    const typed = observationFromRunnerCapture(typedCapture);
    const { action, input, clear } = harness({ observations: [typed] });
    clear.setResult({ success: false, error: "clear removed nothing" });

    const result = await action.execute({
      fields: [{ selector: { text: "Address" }, value: "" }],
    });

    expect(result.success).toBe(false);
    expect(result.fields[0].error).toContain("Failed to clear text");
    expect(input.getCallCount()).toBe(0);
  });
});
