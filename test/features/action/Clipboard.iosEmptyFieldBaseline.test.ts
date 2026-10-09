import { beforeEach, describe, expect, test } from "bun:test";
import cartAItem44Focused from "../../fixtures/ios/nested-selection/cart-a-item-44-quantity-focused.json";
import { Clipboard } from "../../../src/features/action/Clipboard";
import { getFocusedTextField } from "../../../src/features/action/ClearText";
import { DefaultElementParser } from "../../../src/features/utility/ElementParser";
import type { BootedDevice, ViewHierarchyNode, ViewHierarchyResult } from "../../../src/models";
import { FakeAdbClientFactory } from "../../fakes/FakeAdbClientFactory";
import { FakeIOSCtrlProxy } from "../../fakes/FakeIOSCtrlProxy";
import { FakeKeyboardHierarchyProvider } from "../../fakes/FakeKeyboardHierarchyProvider";
import { FakeTimer } from "../../fakes/FakeTimer";

/**
 * Issue #9078: pasting into an empty iOS field reported success with nothing pasted, because the
 * runner omits an empty field's value and verification had no baseline. The capture is a real
 * iOS Playground `observe` with the empty `quantity` field focused (placeholder "item_44 qty").
 */
type Capture = { viewHierarchy: unknown };
const PLACEHOLDER = "item_44 qty";

function emptyFocusedCapture(): ViewHierarchyResult {
  return structuredClone((cartAItem44Focused as Capture).viewHierarchy) as ViewHierarchyResult;
}

/** Synthetic variant of the capture: the focused field's runner `value` set to `value`. */
function withFocusedValue(value: string): ViewHierarchyResult {
  const hierarchy = emptyFocusedCapture();
  const parser = new DefaultElementParser();
  for (const root of parser.extractRootNodes(hierarchy)) {
    parser.traverseNode(root, (node: ViewHierarchyNode) => {
      const raw = node as ViewHierarchyNode & { focused?: string; value?: string };
      if (raw.focused === "true") {
        raw.value = value;
      }
    });
  }
  return hierarchy;
}

describe("Clipboard iOS paste into an empty field (#9078)", () => {
  const device: BootedDevice = { name: "iPhone", platform: "ios", deviceId: "paste-empty" };
  let proxy: FakeIOSCtrlProxy;
  let hierarchy: FakeKeyboardHierarchyProvider;
  let timer: FakeTimer;
  let clipboard: Clipboard;

  beforeEach(() => {
    proxy = new FakeIOSCtrlProxy();
    proxy.setClipboardResults([
      { success: true, action: "get", text: "Z1", totalTimeMs: 1 },
      { success: true, action: "paste", totalTimeMs: 1 },
    ]);
    hierarchy = new FakeKeyboardHierarchyProvider();
    timer = new FakeTimer();
    timer.enableAutoAdvance();
    clipboard = new Clipboard(device, new FakeAdbClientFactory(), () => proxy, hierarchy, timer);
  });

  test("the captured empty field has no readable value by default but an empty baseline for paste", () => {
    const capture = emptyFocusedCapture();
    expect(getFocusedTextField(capture)).toBeUndefined();
    expect(getFocusedTextField(capture, undefined, { iosEmptyAsBlank: true })).toEqual({
      value: "",
      secure: false,
    });
  });

  test("a runner-emitted empty value reads as an empty baseline without the fallback", () => {
    expect(getFocusedTextField(withFocusedValue(""))).toEqual({ value: "", secure: false });
  });

  test("a paste into a field the runner reports as empty succeeds once the value changes", async () => {
    hierarchy.setResults([withFocusedValue(""), withFocusedValue("Z1")]);
    const result = await clipboard.execute("paste");
    expect(result.success).toBe(true);
  });

  test("a value equal to the placeholder is an empty baseline", () => {
    expect(
      getFocusedTextField(withFocusedValue(PLACEHOLDER), undefined, { iosEmptyAsBlank: true })
        ?.value,
    ).toBe("");
    expect(
      getFocusedTextField(withFocusedValue("Z1"), undefined, { iosEmptyAsBlank: true })?.value,
    ).toBe("Z1");
  });

  test("a paste that leaves the captured empty field empty fails instead of succeeding", async () => {
    hierarchy.setDefaultResult(emptyFocusedCapture());
    const result = await clipboard.execute("paste");
    expect(result.success).toBe(false);
    expect(result.error).toContain("nothing appears to have been pasted");
    expect(timer.now()).toBe(1500);
  });

  test("a placeholder-only value after the paste still counts as empty", async () => {
    hierarchy.setResults([emptyFocusedCapture(), withFocusedValue(PLACEHOLDER)]);
    hierarchy.setDefaultResult(withFocusedValue(PLACEHOLDER));
    const result = await clipboard.execute("paste");
    expect(result.success).toBe(false);
    expect(result.error).toContain("nothing appears to have been pasted");
  });

  test("a paste that fills the captured empty field succeeds", async () => {
    hierarchy.setResults([emptyFocusedCapture(), withFocusedValue("Z1")]);
    const result = await clipboard.execute("paste");
    expect(result).toEqual({ success: true, action: "paste", text: undefined, method: "a11y" });
    expect(hierarchy.getCallCount()).toBe(2);
  });

  test("a field that cannot be read after the paste reports the paste as unconfirmed", async () => {
    hierarchy.setResults([emptyFocusedCapture()]);
    hierarchy.setDefaultResult(null);
    const result = await clipboard.execute("paste");
    expect(result.success).toBe(false);
    expect(result.error).toContain("could not be read after the paste");
    expect(result.error).toContain("unconfirmed");
  });
});
