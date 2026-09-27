import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { TapOnElement } from "../../../src/features/action/TapOnElement";
import { SearchableHierarchy } from "../../../src/features/utility/SearchableNode";
import { serverConfig } from "../../../src/utils/ServerConfig";
import { attachRawViewHierarchy } from "../../../src/utils/viewHierarchySearch";
import { FakeAdbClient } from "../../fakes/FakeAdbClient";
import { FakeElementSelector } from "../../fakes/FakeElementSelector";
import { FakeTimer } from "../../fakes/FakeTimer";
import type { Element } from "../../../src/models/Element";
import type { ViewHierarchyResult } from "../../../src/models/ViewHierarchyResult";

const editableElement = (focus: Record<string, unknown>) => ({
  text: "Phone number",
  class: "android.widget.EditText",
  "resource-id": "com.example:id/phone",
  bounds: { left: 0, top: 0, right: 100, bottom: 40 },
  ...focus,
});

afterEach(() => serverConfig.setRawElementSearchEnabled(false));

async function executeFocus(
  element: ReturnType<typeof editableElement>,
  postTapHierarchy: ViewHierarchyResult = { hierarchy: { node: {} } },
  elementId?: string,
  matchedElement?: Element,
) {
  const fakeSelector = new FakeElementSelector(element as any);
  if (matchedElement) {
    fakeSelector.setNextSelection({ element: element as Element, matchedElement });
  }
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
  const observation = { viewHierarchy: postTapHierarchy };
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

  const result = await tapOnElement.execute(
    elementId ? { elementId, action: "focus" } : { text: "Phone", action: "focus" },
  );
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

  test("verifies focus after an s2 id changes on the post-tap Compose field (#7758)", async () => {
    const before = editableElement({
      "resource-id": undefined,
      "view-id": "s2-35973cc76070aa26",
      focused: false,
    });
    const after = {
      ...before,
      "view-id": "s2-7e6d952ea5fe0ddf",
      focused: true,
      node: [{ text: "Email" }],
    };
    const { result, tapped } = await executeFocus(
      before,
      { hierarchy: { node: after } },
      "s2-35973cc76070aa26",
    );

    expect(tapped).toBe(true);
    expect(result.success).toBe(true);
    expect(result.focusVerified).toBe(true);
  });

  test("verifies focus when the IME pans a field vertically without changing its horizontal extent (PR #7780 review)", async () => {
    const before = editableElement({
      "resource-id": undefined,
      "view-id": "s2-before",
      bounds: { left: 0, top: 400, right: 100, bottom: 440 },
      focused: false,
    });
    const after = {
      ...before,
      "view-id": "s2-after",
      bounds: { left: 0, top: 100, right: 100, bottom: 140 },
      focused: true,
    };
    const { result } = await executeFocus(before, { hierarchy: { node: after } });

    expect(result.focusVerified).toBe(true);
    expect(result.success).toBe(true);
  });

  test("verifies focus on a label-promoted ancestor using the matched label's text (PR #7780 review)", async () => {
    const before = editableElement({
      text: undefined,
      "resource-id": undefined,
      "view-id": "s2-before",
      bounds: { left: 0, top: 400, right: 100, bottom: 440 },
      focused: false,
    });
    const after = {
      ...before,
      text: "Phone number",
      "view-id": "s2-after",
      bounds: { left: 0, top: 100, right: 100, bottom: 140 },
      focused: true,
    };
    const label = { text: "Phone number", class: "android.widget.TextView", bounds: before.bounds };
    const { result } = await executeFocus(before, { hierarchy: { node: after } }, undefined, label);

    expect(result.focusVerified).toBe(true);
    expect(result.success).toBe(true);
  });

  test("deduplicates a focused field that appears twice via linked window roots (PR #7780 review)", async () => {
    const before = editableElement({
      "resource-id": undefined,
      "view-id": "s2-before",
      bounds: { left: 0, top: 400, right: 100, bottom: 440 },
      focused: false,
    });
    const focusedNode = {
      ...before,
      "view-id": "s2-after",
      bounds: { left: 0, top: 100, right: 100, bottom: 140 },
      focused: true,
    };
    const viewHierarchy = {
      hierarchy: { node: focusedNode },
      windows: [{ windowLayer: 1, hierarchy: focusedNode }],
    };
    const { result } = await executeFocus(before, viewHierarchy);

    expect(result.focusVerified).toBe(true);
    expect(result.success).toBe(true);
  });

  test("rejects a same-bounds replacement field lacking a stable identity match (PR #7780 review)", async () => {
    const before = editableElement({
      "resource-id": undefined,
      "view-id": "s2-before",
      focused: false,
    });
    const after = {
      ...before,
      text: "Email",
      "view-id": "s2-after",
      focused: true,
    };
    const { result } = await executeFocus(before, { hierarchy: { node: after } });

    expect(result.focusVerified).toBe(false);
    expect(result.success).toBe(false);
  });

  test("rejects a different field with the same class but a different hint when focus verification runs (PR #7780 review)", async () => {
    const before = editableElement({
      "resource-id": undefined,
      "view-id": "s2-before",
      bounds: { left: 0, top: 400, right: 100, bottom: 440 },
      focused: false,
    });
    const after = {
      ...before,
      text: "Email",
      "view-id": "s2-after",
      bounds: { left: 0, top: 100, right: 100, bottom: 140 },
      focused: true,
    };
    const { result } = await executeFocus(before, { hierarchy: { node: after } });

    expect(result.focusVerified).toBe(false);
    expect(result.success).toBe(false);
    expect(result.error).toContain("Failed to confirm focus");
  });

  test("rejects an IME-panned field with a different stable resource ID (PR #7780 review)", async () => {
    const before = editableElement({
      "view-id": "s2-before",
      bounds: { left: 0, top: 400, right: 100, bottom: 440 },
      focused: false,
    });
    const after = {
      ...before,
      "resource-id": "com.example:id/email",
      "view-id": "s2-after",
      bounds: { left: 0, top: 100, right: 100, bottom: 140 },
      focused: true,
    };
    const { result } = await executeFocus(before, { hierarchy: { node: after } });

    expect(result.focusVerified).toBe(false);
    expect(result.success).toBe(false);
  });

  test("rejects an ambiguous IME pan when two editable fields report focus (PR #7780 review)", async () => {
    const before = editableElement({
      "resource-id": undefined,
      "view-id": "s2-before",
      bounds: { left: 0, top: 400, right: 100, bottom: 440 },
      focused: false,
    });
    const focused = {
      ...before,
      "view-id": "s2-after",
      bounds: { left: 0, top: 100, right: 100, bottom: 140 },
      focused: true,
    };
    const anotherFocused = {
      ...focused,
      text: "Email",
      "view-id": "s2-other",
      bounds: { left: 0, top: 150, right: 100, bottom: 190 },
    };
    const { result } = await executeFocus(before, {
      hierarchy: { node: [focused, anotherFocused] },
    });

    expect(result.focusVerified).toBe(false);
    expect(result.success).toBe(false);
  });

  test("verifies focus against the attached raw hierarchy when raw element search is enabled (PR #7780 review)", async () => {
    const before = editableElement({
      "resource-id": undefined,
      "view-id": "s2-before",
      focused: false,
    });
    const after = { ...before, "view-id": "s2-after", focused: true };
    const filtered = { hierarchy: { node: { text: "Visible sibling" } } };
    const raw = { hierarchy: { node: after } };
    attachRawViewHierarchy(filtered, raw);
    serverConfig.setRawElementSearchEnabled(true);

    const project = spyOn(SearchableHierarchy.prototype, "project");
    try {
      const { result, tapped } = await executeFocus(before, filtered);

      expect(tapped).toBe(true);
      expect(result.success).toBe(true);
      expect(result.focusVerified).toBe(true);
      expect(project.mock.calls.at(-1)?.[0]).toBe(raw);
    } finally {
      project.mockRestore();
    }
  });

  test("does not accept keyboard focus on a different editable field (#7758)", async () => {
    const before = editableElement({
      "resource-id": undefined,
      "view-id": "s2-35973cc76070aa26",
      focused: false,
    });
    const after = {
      ...before,
      text: "Email",
      "view-id": "s2-7e6d952ea5fe0ddf",
      bounds: { left: 0, top: 80, right: 100, bottom: 120 },
      focused: true,
    };
    const { result } = await executeFocus(
      before,
      { hierarchy: { node: after } },
      "s2-35973cc76070aa26",
    );
    expect(result.focusVerified).toBe(false);
    expect(result.success).toBe(false);
  });
});
