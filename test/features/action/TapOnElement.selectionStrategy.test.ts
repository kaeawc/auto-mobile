import { describe, expect, test } from "bun:test";
import { TapOnElement } from "../../../src/features/action/TapOnElement";
import { FakeAdbClient } from "../../fakes/FakeAdbClient";
import { FakeElementSelector } from "../../fakes/FakeElementSelector";
import { FakeTimer } from "../../fakes/FakeTimer";

const editableElement = (focus: Record<string, unknown>) => ({
  text: "Phone number",
  class: "android.widget.EditText",
  "resource-id": "com.example:id/phone",
  bounds: { left: 0, top: 0, right: 100, bottom: 40 },
  ...focus,
});

async function executeFocus(element: ReturnType<typeof editableElement>) {
  const fakeSelector = new FakeElementSelector(element as any);
  let tapped = false;
  const tapOnElement = new TapOnElement(
    {
      name: "test-device",
      platform: "android",
      deviceId: "emulator-5554",
    } as any,
    new FakeAdbClient() as any,
    {
      timer: new FakeTimer(),
      elementSelector: fakeSelector,
      tapStrategy: {
        isAccessibilityServiceEnabled: async () => false,
        shouldRunPreTapStability: () => false,
      } as any,
      selectionStateTracker: { finalize: async () => [] } as any,
    },
  );
  const observation = { viewHierarchy: { hierarchy: { node: {} } } };
  (tapOnElement as any).observedInteraction = async (
    action: (currentObservation: typeof observation) => Promise<Record<string, unknown>>,
  ) => ({ ...(await action(observation)), observation });
  (tapOnElement as any).executeAndroidTap = async () => {
    tapped = true;
  };
  (tapOnElement as any).prepareSelectionCapture = async () => null;
  (tapOnElement as any).deriveTapEffectAfterPostTapObservation = async (
    _previousObservation: unknown,
    currentObservation: typeof observation,
  ) => ({ observation: currentObservation });
  (tapOnElement as any).captureTerminalObservationScreenshot = async () => {};
  (tapOnElement as any).recordDeferredPredictionOutcome = async () => {};
  (tapOnElement as any).enforceFreshnessConsistencyWithEffect = () => {};

  const result = await tapOnElement.execute({ text: "Phone", action: "focus" });
  return { result, tapped };
}

describe("TapOnElement selectionStrategy", () => {
  test("passes selectionStrategy to the element selector", () => {
    const fakeSelector = new FakeElementSelector({
      bounds: { left: 0, top: 0, right: 10, bottom: 10 },
    } as any);
    const tapOnElement = new TapOnElement(
      {
        name: "test-device",
        platform: "android",
        deviceId: "emulator-5554",
      } as any,
      new FakeAdbClient() as any,
      {
        timer: new FakeTimer(),
        elementSelector: fakeSelector,
      },
    );

    const result = (tapOnElement as any).findElementInHierarchy(
      {
        text: "Match",
        action: "tap",
        selectionStrategy: "random",
      },
      { hierarchy: { node: {} } },
    );

    expect(result.selection.element).not.toBeNull();
    expect(fakeSelector.lastText).toBe("Match");
    expect(fakeSelector.lastStrategy).toBe("random");
  });

  test("uses input-focused text selection only for focus actions", () => {
    const fakeSelector = new FakeElementSelector({
      bounds: { left: 0, top: 0, right: 10, bottom: 10 },
    } as any);
    const tapOnElement = new TapOnElement(
      {
        name: "test-device",
        platform: "android",
        deviceId: "emulator-5554",
      } as any,
      new FakeAdbClient() as any,
      {
        timer: new FakeTimer(),
        elementSelector: fakeSelector,
      },
    );

    (tapOnElement as any).findElementInHierarchy(
      { text: "Match", action: "tap" },
      { hierarchy: { node: {} } },
    );
    expect(fakeSelector.lastTextSelectionIntent).toBe("tap");

    (tapOnElement as any).findElementInHierarchy(
      { textAny: ["Match"], action: "focus" },
      { hierarchy: { node: {} } },
    );
    expect(fakeSelector.lastTextSelectionIntent).toBe("focus-input");
  });

  test("fails focus on a non-editable match without tapping it", async () => {
    const fakeSelector = new FakeElementSelector({
      text: "Phone notification: ",
      class: "android.widget.TextView",
      bounds: { left: 0, top: 0, right: 10, bottom: 10 },
    } as any);
    const tapOnElement = new TapOnElement(
      {
        name: "test-device",
        platform: "android",
        deviceId: "emulator-5554",
      } as any,
      new FakeAdbClient() as any,
      { timer: new FakeTimer(), elementSelector: fakeSelector },
    );
    let tapped = false;
    (tapOnElement as any).observedInteraction = async (action: (observation: unknown) => unknown) =>
      action({ viewHierarchy: { hierarchy: { node: {} } } });
    (tapOnElement as any).executeAndroidTap = async () => {
      tapped = true;
    };

    const result = await tapOnElement.execute({ text: "Phone", action: "focus" });

    expect(result.success).toBe(false);
    expect(result.error).toContain("Phone notification");
    expect(tapped).toBe(false);
  });

  test("does not treat a selected editable target as already keyboard-focused", async () => {
    const { result, tapped } = await executeFocus(editableElement({ selected: "true" }));

    expect(tapped).toBe(true);
    expect(result.wasAlreadyFocused).toBeUndefined();
    expect(result.focusVerified).toBe(false);
    expect(result.success).toBe(false);
    expect(result.error).toContain("Failed to confirm focus");
  });

  test("keeps a genuinely keyboard-focused editable target verified", async () => {
    const { result, tapped } = await executeFocus(
      editableElement({ focused: "true", selected: "false" }),
    );

    expect(tapped).toBe(false);
    expect(result.wasAlreadyFocused).toBe(true);
    expect(result.focusVerified).toBe(true);
    expect(result.success).toBe(true);
  });
});
