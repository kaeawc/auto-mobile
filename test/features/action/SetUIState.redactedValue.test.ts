import { describe, expect, test } from "bun:test";
import { SetUIState } from "../../../src/features/action/SetUIState";
import type { Element } from "../../../src/models";
import { VALUE_REDACTED_ATTRIBUTE } from "../../../src/models/Element";
import { FakeTimer } from "../../fakes/FakeTimer";
import {
  FakeClearText,
  FakeInputText,
  FakeObserveScreenForSetUIState,
  FakeSwipeOn,
  FakeTapOnElement,
} from "../../fakes/FakeSetUIStateDependencies";
import { buildObserveResult } from "../../helpers/observeFixture";

// A merged web input whose value the SDK redacted (#5162): it has a value, but not a readable one.
const redactedInput: Element = {
  "resource-id": "email",
  class: "input",
  role: "textfield",
  focusable: "true",
  clickable: "true",
  "input-type": "text",
  "content-desc": "Email",
  [VALUE_REDACTED_ATTRIBUTE]: "true",
  bounds: { left: 0, top: 0, right: 400, bottom: 60 },
};

function harness() {
  const timer = new FakeTimer();
  timer.enableAutoAdvance();
  const clear = new FakeClearText();
  const observe = new FakeObserveScreenForSetUIState();
  observe.setResultFactory(() =>
    buildObserveResult({
      updatedAt: timer.now(),
      screenSize: { width: 1080, height: 1920 },
      systemInsets: { top: 0, right: 0, bottom: 0, left: 0 },
      viewHierarchy: { hierarchy: { node: { $: redactedInput } } },
    }),
  );
  const action = new SetUIState({ name: "iPhone", platform: "ios", deviceId: "fake-ios" }, null, {
    timer,
    clearText: clear,
    observeScreen: observe,
    tapOnElement: new FakeTapOnElement(),
    inputText: new FakeInputText(),
    swipeOn: new FakeSwipeOn(),
  });
  return { action, clear };
}

describe("SetUIState on a redacted value", () => {
  test("clearing a field whose value is redacted clears it instead of skipping it as empty", async () => {
    const { action, clear } = harness();
    const result = await action.execute({
      fields: [{ selector: { elementId: "email" }, value: "" }],
    });
    expect(result.fields[0].skipped).toBeUndefined();
    expect(clear.getCallCount()).toBeGreaterThan(0);
  });
});
