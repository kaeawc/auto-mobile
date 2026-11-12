import { expect, test } from "bun:test";
import {
  InMemoryCtrlProxyCaptureCooldown,
  CTRLPROXY_CAPTURE_FAILURE_COOLDOWN_MS,
} from "../../../../src/features/observe/android/CtrlProxyCaptureCooldown";
import { A11Y_SCREENSHOT_REPROBE_COOLDOWN_MS } from "../../../../src/features/observe/android/AndroidScreenshotCapture";
import { FakeTimer } from "../../../fakes/FakeTimer";

test("one-shot failure cooldown expires at the boundary, isolates devices and clears on success", () => {
  const timer = new FakeTimer();
  const cooldown = new InMemoryCtrlProxyCaptureCooldown(timer);
  expect(CTRLPROXY_CAPTURE_FAILURE_COOLDOWN_MS).toBe(A11Y_SCREENSHOT_REPROBE_COOLDOWN_MS);
  cooldown.recordFailure("a");
  expect(cooldown.hasRecentFailure("a")).toBe(true);
  expect(cooldown.hasRecentFailure("b")).toBe(false);
  timer.advanceTime(59_999);
  expect(cooldown.hasRecentFailure("a")).toBe(true);
  timer.advanceTime(1);
  expect(cooldown.hasRecentFailure("a")).toBe(false);
  cooldown.recordFailure("a");
  expect(cooldown.hasRecentFailure("a")).toBe(true);
  cooldown.clear("a");
  expect(cooldown.hasRecentFailure("a")).toBe(false);
  expect(timer.getSleepHistory()).toEqual([]);
});

test("cooldown duration is injectable", () => {
  const timer = new FakeTimer();
  const cooldown = new InMemoryCtrlProxyCaptureCooldown(timer, 10);
  cooldown.recordFailure("a");
  timer.advanceTime(10);
  expect(cooldown.hasRecentFailure("a")).toBe(false);
});

test("a backward wall-clock step expires the cooldown instead of extending it", () => {
  const timer = new FakeTimer();
  const cooldown = new InMemoryCtrlProxyCaptureCooldown(timer);
  cooldown.recordFailure("a");
  timer.stepWallClock(-3_600_000);
  expect(cooldown.hasRecentFailure("a")).toBe(false);
});
