import { describe, expect, test } from "bun:test";
import type { Element } from "../../../src/models";
import { TapOnElement } from "../../../src/features/action/TapOnElement";
import { FakeAdbClient } from "../../fakes/FakeAdbClient";
import { FakeTimer } from "../../fakes/FakeTimer";

interface TapSpy {
  calls: Array<{ x: number; y: number }>;
}

function createTap(): { tap: TapOnElement; adb: FakeAdbClient; dispatch: TapSpy } {
  const adb = new FakeAdbClient();
  const timer = new FakeTimer();
  timer.enableAutoAdvance();
  const tap = new TapOnElement(
    { name: "test-device", platform: "android", deviceId: "emulator-5554" } as any,
    adb as any,
    { timer },
  );

  const dispatch: TapSpy = { calls: [] };
  // Stub the CtrlProxy dispatchGesture seam: it "acknowledges" every tap with
  // success, exactly as DocumentsUI does on-device (the acknowledged-but-
  // ineffective dispatch of #6335).
  (tap as any).accessibilityService = {
    requestTapCoordinates: async (x: number, y: number) => {
      dispatch.calls.push({ x, y });
      return { success: true };
    },
  };
  return { tap, adb, dispatch };
}

const documentsUiRow: Element = {
  "resource-id": "com.android.documentsui:id/item_root",
  class: "android.widget.LinearLayout",
  clickable: true,
  bounds: { left: 0, top: 300, right: 1080, bottom: 460 },
} as Element;

const ordinaryRow: Element = {
  "resource-id": "com.example.app:id/row",
  class: "android.widget.LinearLayout",
  clickable: true,
  bounds: { left: 0, top: 300, right: 1080, bottom: 460 },
} as Element;

describe("executeAndroidTapWithCoordinates DocumentsUI routing (#6335)", () => {
  test("routes a DocumentsUI row tap through ADB input, skipping the ineffective dispatchGesture", async () => {
    const { tap, adb, dispatch } = createTap();

    await (tap as any).executeAndroidTapWithCoordinates("tap", 540, 380, 0, documentsUiRow);

    // dispatchGesture is NOT trusted for DocumentsUI: it must not be the sole
    // (acknowledged-but-ineffective) dispatch.
    expect(dispatch.calls).toHaveLength(0);
    expect(adb.getAllCommands()).toContain("shell input touchscreen tap 540 380");
  });

  test("uses dispatchGesture for an ordinary in-app row and does not fall back to ADB", async () => {
    const { tap, adb, dispatch } = createTap();

    await (tap as any).executeAndroidTapWithCoordinates("tap", 540, 380, 0, ordinaryRow);

    expect(dispatch.calls).toEqual([{ x: 540, y: 380 }]);
    expect(adb.getAllCommands()).not.toContain("shell input touchscreen tap 540 380");
  });

  test("routes both taps of a DocumentsUI doubleTap through ADB input", async () => {
    const { tap, adb, dispatch } = createTap();

    await (tap as any).executeAndroidTapWithCoordinates("doubleTap", 540, 380, 0, documentsUiRow);

    expect(dispatch.calls).toHaveLength(0);
    const taps = adb.getAllCommands().filter((c) => c === "shell input touchscreen tap 540 380");
    expect(taps).toHaveLength(2);
  });
});
