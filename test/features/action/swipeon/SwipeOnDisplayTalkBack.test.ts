import { afterEach, expect, mock, test } from "bun:test";
import type { SwipeOnOptions } from "../../../../src/models";
import { TALKBACK_STATE_UNKNOWN_WARNING } from "../../../../src/features/accessibility/interfaces/AccessibilityDetector";
import { runSessionDisplayPin } from "../../../../src/server/sessionDisplayPin";
import { harness } from "./displaySwipeHarness";

const DEVICE_ID = "swipe-display-search";
const swipe: SwipeOnOptions = { direction: "up", display: "external" };
const search: SwipeOnOptions = { ...swipe, lookFor: { text: "Found" } };

afterEach(() => mock.restore());

function talkBackOn(h: ReturnType<typeof harness>) {
  h.detector.setDetectionResult(DEVICE_ID, true);
}

function expectNoRawGesture(h: ReturnType<typeof harness>) {
  expect(h.legs()).toEqual([]);
  expect(h.commands()).toEqual([]);
  expect(h.ctrl.getSwipeHistory()).toEqual([]);
  expect(h.ctrl.getDragHistory()).toEqual([]);
  expect(h.ctrl.getTwoFingerSwipeHistory()).toEqual([]);
  expect(h.talkback).not.toHaveBeenCalled();
}

for (const route of ["ctrlproxy", "adb"] as const) {
  test(`TalkBack on: swipeOn on a non-default display refuses before any gesture via ${route}`, async () => {
    const h = harness({ route });
    talkBackOn(h);
    const result = await h.action.execute(swipe);
    expect(result.success).toBe(false);
    expect(result.error).toContain("TalkBack scrolling cannot target display 2");
    expect(result.error).toContain("no gesture was dispatched");
    expectNoRawGesture(h);
  });

  test(`TalkBack on: swipeOn lookFor on a non-default display refuses before any gesture via ${route}`, async () => {
    const h = harness({ route });
    talkBackOn(h);
    const result = await h.action.execute(search);
    expect(result.success).toBe(false);
    expect(result.error).toContain("TalkBack scrolling cannot target display 2");
    expectNoRawGesture(h);
  });
}

test("TalkBack on: a session-pinned display refuses the same way", async () => {
  const h = harness();
  talkBackOn(h);
  const result = await runSessionDisplayPin({
    name: "swipeOn",
    acceptsDisplay: true,
    device: {
      name: "Search fake",
      deviceId: DEVICE_ID,
      platform: "android",
      displays: {
        panels: [
          { key: "internal", role: "inner", sizePx: { width: 100, height: 100 } },
          { key: "external", role: "external", sizePx: { width: 200, height: 200 } },
        ],
        postures: [],
      },
    },
    sessionUuid: "s1",
    store: { getDeviceForSession: () => DEVICE_ID, getDisplayPin: () => "external" },
    args: {},
    invoke: (args) =>
      h.action.execute({
        direction: "up",
        display: typeof args.display === "string" ? args.display : undefined,
      }),
  });
  expect(result).toMatchObject({
    success: false,
    error: expect.stringContaining("TalkBack scrolling cannot target display 2"),
  });
  expectNoRawGesture(h);
});

test("TalkBack on, default display: swipeOn uses the TalkBack executor instead of a raw swipe", async () => {
  const h = harness();
  talkBackOn(h);
  h.adb.setCommandResult(
    "shell cmd display get-displays",
    'Display id 0: DisplayInfo{uniqueId "local:external" type EXTERNAL, real 200 x 200}',
  );
  const result = await h.action.execute(swipe);
  expect(result.success).toBe(true);
  expect(h.talkback).toHaveBeenCalledTimes(1);
  expect(h.ctrl.getTwoFingerSwipeHistory()).toHaveLength(1);
  expect(h.ctrl.getSwipeHistory()).toEqual([]);
  expect(h.commands()).toEqual([]);
});

test("TalkBack off: swipeOn on a display keeps the raw CtrlProxy swipe and no TalkBack call", async () => {
  const h = harness();
  const result = await h.action.execute(swipe);
  expect(result.success).toBe(true);
  expect(result.warnings).toBeUndefined();
  expect(h.ctrl.getSwipeHistory()).toHaveLength(1);
  expect(h.ctrl.getSwipeHistory()[0]).toMatchObject({ displayId: 2 });
  expect(h.ctrl.getTwoFingerSwipeHistory()).toEqual([]);
  expect(h.talkback).not.toHaveBeenCalled();
});

test("TalkBack off: swipeOn on a display keeps the raw ADB swipe via adb", async () => {
  const h = harness({ route: "adb" });
  const result = await h.action.execute(swipe);
  expect(result.success).toBe(true);
  expect(h.commands()).toHaveLength(1);
  expect(h.commands()[0]).toContain("input touchscreen -d 2 swipe ");
  expect(h.talkback).not.toHaveBeenCalled();
});

test("TalkBack state unknown: swipeOn follows the raw route and carries the unknown-state warning", async () => {
  const h = harness();
  h.detector.setDefaultResult(null);
  const result = await h.action.execute(swipe);
  expect(result.success).toBe(true);
  expect(result.warnings).toEqual([TALKBACK_STATE_UNKNOWN_WARNING]);
  expect(h.ctrl.getSwipeHistory()).toHaveLength(1);
  expect(h.talkback).not.toHaveBeenCalled();
});
