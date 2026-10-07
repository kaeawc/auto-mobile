import { describe, expect, test } from "bun:test";
import { FakeCtrlProxy } from "./FakeCtrlProxy";
import { FakeTimer } from "./FakeTimer";
import type {
  AndroidCtrlProxy,
  AccessibilityNodeSelector,
} from "../../src/features/observe/android";
import { NoOpPerformanceTracker } from "../../src/utils/PerformanceTracker";

const selector: AccessibilityNodeSelector = {
  resourceId: "app:id/row",
  testTag: "widget_42",
  uniqueId: "row-42",
  collectionRow: 2,
  collectionColumn: 1,
};

describe("FakeCtrlProxy node actions", () => {
  test("implements the interface and records the full selector separately from legacy actions", async () => {
    const fake = new FakeCtrlProxy();
    const proxy: AndroidCtrlProxy = fake;
    const perf = new NoOpPerformanceTracker();
    const signal = new AbortController().signal;
    expect(await proxy.requestNodeAction("click", selector, 123, perf, signal)).toMatchObject({
      success: true,
      action: "click",
    });
    expect(fake.getNodeActionHistory()).toEqual([
      { action: "click", selector, timeoutMs: 123, perf, signal },
    ]);
    expect(fake.getActionHistory()).toEqual([]);
    await proxy.requestAction("click", selector.resourceId);
    expect(fake.getActionHistory()).toEqual([
      { action: "click", resourceId: selector.resourceId, timeoutMs: 5000 },
    ]);
  });

  test("focused-input clicks implement the interface and honor configured results", async () => {
    const fake = new FakeCtrlProxy();
    const proxy: AndroidCtrlProxy = fake;
    expect(await proxy.requestClickFocusedInput()).toMatchObject({
      success: true,
      action: "click",
    });
    const refusal = {
      success: false,
      action: "click",
      totalTimeMs: 1,
      error: "Unknown command type: request_click_focused_input",
    };
    fake.setActionResult(refusal);
    expect(await proxy.requestClickFocusedInput()).toBe(refusal);
    fake.setFailureMode("requestClickFocusedInput", new Error("disconnected"));
    await expect(proxy.requestClickFocusedInput()).rejects.toThrow("disconnected");
  });

  test("honors configured action results and restores default success", async () => {
    const fake = new FakeCtrlProxy();
    const result = { success: false, action: "long_click", totalTimeMs: 1, error: "rejected" };
    fake.setActionResult(result);
    expect(await fake.requestNodeAction("long_click", selector)).toBe(result);
    expect(fake.getNodeActionHistory()).toHaveLength(1);
    fake.setActionResult(null);
    expect(await fake.requestNodeAction("long_click", selector)).toMatchObject({ success: true });
  });

  test("honors the node-action failure key without recording a dispatched call", async () => {
    const fake = new FakeCtrlProxy();
    fake.setFailureMode("requestNodeAction", new Error("disconnected"));
    await expect(fake.requestNodeAction("click", selector)).rejects.toThrow("disconnected");
    expect(fake.getNodeActionHistory()).toEqual([]);
    fake.setFailureMode("requestNodeAction", null);
    expect(await fake.requestNodeAction("click", selector)).toMatchObject({ success: true });
  });

  test("delays node actions through an injected FakeTimer", async () => {
    const timer = new FakeTimer();
    const fake = new FakeCtrlProxy(timer);
    fake.setOperationDelay("requestNodeAction", 20);
    const pending = fake.requestNodeAction("click", selector);
    expect(fake.getNodeActionHistory()).toEqual([]);
    timer.advanceTime(20);
    expect(await pending).toMatchObject({ success: true });
    expect(fake.getNodeActionHistory()).toHaveLength(1);
  });

  test("configures selector support and clears node history with other history", async () => {
    const fake = new FakeCtrlProxy();
    expect(await fake.supportsNodeActionSelectors()).toBe(true);
    fake.setSupportsNodeActionSelectors(false);
    expect(await fake.supportsNodeActionSelectors()).toBe(false);
    fake.setSupportsNodeActionSelectors(true);
    await fake.requestNodeAction("click", selector);
    fake.clearHistory();
    expect(fake.getNodeActionHistory()).toEqual([]);
    expect(await fake.supportsNodeActionSelectors()).toBe(true);
  });
});
