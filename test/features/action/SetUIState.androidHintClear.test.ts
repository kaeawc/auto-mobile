import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { SetUIState } from "../../../src/features/action/SetUIState";
import type { Element } from "../../../src/models";
import { FakeTimer } from "../../fakes/FakeTimer";
import {
  FakeClearText,
  FakeInputText,
  FakeObserveScreenForSetUIState,
  FakeSwipeOn,
  FakeTapOnElement,
} from "../../fakes/FakeSetUIStateDependencies";
import { buildObserveResult } from "../../helpers/observeFixture";

const elementId = "com.google.android.settings.intelligence:id/open_search_view_edit_text";

// These captures are attribute pairs, not XML or raw hierarchy dumps.
function capturedSearchAttributes(file: string): { text: string; hint: string } {
  const lines = readFileSync(
    `${import.meta.dir}/../../fixtures/android-setuistate-hint/${file}`,
    "utf8",
  )
    .trim()
    .split("\n");
  const hintIndex = lines.findIndex((line) => line.startsWith('hint="') && line !== 'hint=""');
  if (hintIndex < 1 || !lines[hintIndex - 1].startsWith('text="')) {
    throw new Error(`Missing captured search text/hint pair: ${file}`);
  }
  return { text: lines[hintIndex - 1].slice(6, -1), hint: lines[hintIndex].slice(6, -1) };
}

const before = capturedSearchAttributes("gt-before-clear.txt");
const after = capturedSearchAttributes("gt-after-clear.txt");

function searchElement(text: string, hint: string | undefined = after.hint): Element {
  return {
    "resource-id": elementId,
    class: "android.widget.EditText",
    text,
    "hint-text": hint,
    editable: true,
    bounds: { left: 0, top: 0, right: 400, bottom: 60 },
  };
}

function harness(postApply: Element, initial = searchElement(before.text)) {
  const timer = new FakeTimer();
  timer.enableAutoAdvance();
  const clear = new FakeClearText();
  const observe = new FakeObserveScreenForSetUIState();
  // Applying clear switches the hierarchy; no dependence on incidental observe call counts.
  observe.setResultFactory(() =>
    buildObserveResult({
      updatedAt: timer.now(),
      screenSize: { width: 1080, height: 1920 },
      systemInsets: { top: 0, right: 0, bottom: 0, left: 0 },
      viewHierarchy: { hierarchy: { node: { $: clear.getCallCount() ? postApply : initial } } },
    }),
  );
  const action = new SetUIState(
    { name: "Settings", platform: "android", deviceId: "fake-android" },
    null,
    {
      timer,
      clearText: clear,
      observeScreen: observe,
      tapOnElement: new FakeTapOnElement(),
      inputText: new FakeInputText(),
      swipeOn: new FakeSwipeOn(),
    },
  );
  return { action, clear };
}

describe("SetUIState Android hint-as-text clear", () => {
  test.each([
    {
      name: "cleared field exposes its hint",
      expected: "",
      text: after.text,
      hint: after.hint,
      success: true,
    },
    {
      name: "real content remains after clear",
      expected: "",
      text: before.text,
      hint: before.hint,
      success: false,
    },
    {
      name: "non-empty target differs from hint",
      expected: "x",
      text: after.text,
      hint: after.hint,
      success: false,
    },
    {
      name: "non-empty text matches",
      expected: before.text,
      text: before.text,
      hint: before.hint,
      success: true,
    },
    {
      name: "non-empty target equals hint",
      expected: after.hint,
      text: after.text,
      hint: after.hint,
      success: true,
    },
    { name: "empty field without hint", expected: "", text: "", hint: undefined, success: true },
    {
      name: "hint-like text without hint metadata",
      expected: "",
      text: after.text,
      hint: undefined,
      success: false,
    },
    {
      name: "empty hint cannot hide content",
      expected: "",
      text: before.text,
      hint: "",
      success: false,
    },
  ])("$name", async ({ expected, text, hint, success }) => {
    const postApply = { ...searchElement(text), "hint-text": hint };
    // A distinct initial value ensures every case exercises post-apply verification.
    const { action, clear } = harness(postApply, searchElement("initial content"));
    const result = await action.execute({ fields: [{ selector: { elementId }, value: expected }] });
    expect(clear.getCallCount()).toBeGreaterThan(0);
    expect(result.success).toBe(success);
    expect(result.fields[0].success).toBe(success);
    if (success) {
      expect(result.fields[0].verified).toBe(true);
      expect(result.fields[0].error).toBeUndefined();
    } else {
      expect(result.fields[0].error).toBe(
        `Verification failed for elementId="${elementId}": expected ${JSON.stringify(expected)}, observed ${JSON.stringify(text)}`,
      );
    }
  });

  test("already-empty hinted field skips clear consistently", async () => {
    const element = searchElement(after.text);
    const { action, clear } = harness(element, element);
    const result = await action.execute({ fields: [{ selector: { elementId }, value: "" }] });
    expect(result.fields[0]).toMatchObject({ success: true, verified: true, skipped: true });
    expect(clear.getCallCount()).toBe(0);
  });
});
