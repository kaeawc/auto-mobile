import { beforeEach, describe, expect, spyOn, test } from "bun:test";
import { TapOnElement } from "../../../src/features/action/TapOnElement";
import { CtrlProxyClient } from "../../../src/features/observe/android";
import { FakeAdbClient } from "../../fakes/FakeAdbClient";
import { FakeAccessibilityDetector } from "../../fakes/FakeAccessibilityDetector";
import { FakeTimer } from "../../fakes/FakeTimer";
import type { Element } from "../../../src/models";

/**
 * AlertDialog list rows expose `android:id/text1`. Semantic ACTION_CLICK can succeed without
 * firing the list selection listener; coordinate taps must run first for those nodes.
 */
describe("TapOnElement Android tap order (framework vs app resource-id)", () => {
  let fakeAdb: FakeAdbClient;
  let tapOn: TapOnElement;
  let trySemantic: ReturnType<typeof spyOn>;
  let tryCoord: ReturnType<typeof spyOn>;

  beforeEach(() => {
    fakeAdb = new FakeAdbClient();
    const fakeTimer = new FakeTimer();
    fakeTimer.enableAutoAdvance();
    tapOn = new TapOnElement(
      { name: "d", platform: "android", id: "emulator-5554" } as any,
      fakeAdb as any,
      {
        accessibilityDetector: new FakeAccessibilityDetector(),
        timer: fakeTimer
      }
    );
    trySemantic = spyOn(tapOn as any, "tryAndroidSemanticClick");
    tryCoord = spyOn(tapOn as any, "tryAndroidCtrlProxyCoordinateTap");
  });

  test("skips semantic click for android:id/* and uses coordinate tap first", async () => {
    tryCoord.mockResolvedValue({ success: true });
    const attempts: { method: string; success: boolean; error?: string }[] = [];
    const el: Element = {
      "bounds": { left: 0, top: 0, right: 100, bottom: 50 },
      "resource-id": "android:id/text1",
      "text": "https://api.reclients.com/v1/"
    } as Element;

    await (tapOn as any).executeAndroidTapWithCoordinates("tap", 50, 25, 0, el, undefined, attempts);

    expect(trySemantic).not.toHaveBeenCalled();
    expect(tryCoord).toHaveBeenCalledWith(50, 25, undefined);
    expect(attempts.map(a => a.method)).toEqual(["android-ctrl-proxy-dispatch-gesture"]);
  });

  test("tries semantic first for app package resource-id", async () => {
    trySemantic.mockResolvedValue({ success: true });
    tryCoord.mockResolvedValue({ success: true });
    const attempts: { method: string; success: boolean; error?: string }[] = [];
    const el: Element = {
      "bounds": { left: 0, top: 0, right: 100, bottom: 50 },
      "resource-id": "com.example:id/row"
    } as Element;

    await (tapOn as any).executeAndroidTapWithCoordinates("tap", 50, 25, 0, el, undefined, attempts);

    expect(trySemantic).toHaveBeenCalled();
    expect(tryCoord).not.toHaveBeenCalled();
    expect(attempts.map(a => a.method)).toEqual(["android-ctrl-proxy-action-click-bounds"]);
  });

  test("tapClickableParent with android:id/* tries semantic before ADB and gestures", async () => {
    trySemantic.mockResolvedValue({ success: false, error: "No clickable node within disambiguation bounds" });
    spyOn(fakeAdb, "executeCommand").mockResolvedValue(undefined as any);
    tryCoord.mockResolvedValue({ success: true });
    const attempts: { method: string; success: boolean; error?: string }[] = [];
    const el: Element = {
      "bounds": { left: 0, top: 0, right: 100, bottom: 50 },
      "resource-id": "android:id/text1",
      "text": "Dan Corkill"
    } as Element;

    await (tapOn as any).executeAndroidTapWithCoordinates(
      "tap",
      50,
      25,
      0,
      el,
      undefined,
      attempts,
      { tapClickableParent: true, action: "tap" }
    );

    expect(trySemantic).toHaveBeenCalledTimes(1);
    expect(trySemantic).toHaveBeenCalledWith(
      el,
      undefined,
      undefined,
      expect.objectContaining({ omitFrameworkResourceId: true })
    );
    expect(tryCoord).toHaveBeenCalledWith(50, 25, undefined);
    expect(attempts.map(a => a.method)).toEqual([
      "android-ctrl-proxy-action-click-bounds",
      "android-adb-shell-input-tap",
      "android-ctrl-proxy-dispatch-gesture"
    ]);
  });

  test("tapClickableParent runs ADB then dispatchGesture when semantic fails", async () => {
    trySemantic.mockResolvedValue({ success: false, error: "No clickable node within disambiguation bounds" });
    const adbSpy = spyOn(fakeAdb, "executeCommand").mockResolvedValue(undefined as any);
    tryCoord.mockResolvedValue({ success: true });
    const attempts: { method: string; success: boolean; error?: string }[] = [];
    const el: Element = {
      "bounds": { left: 0, top: 0, right: 100, bottom: 50 },
      "resource-id": "com.example:id/row"
    } as Element;

    await (tapOn as any).executeAndroidTapWithCoordinates(
      "tap",
      50,
      25,
      0,
      el,
      undefined,
      attempts,
      { tapClickableParent: true, action: "tap" }
    );

    expect(trySemantic).toHaveBeenCalled();
    expect(adbSpy).toHaveBeenCalled();
    expect(tryCoord).toHaveBeenCalledWith(50, 25, undefined);
    expect(attempts.map(a => a.method)).toEqual([
      "android-ctrl-proxy-action-click-bounds",
      "android-adb-shell-input-tap",
      "android-ctrl-proxy-dispatch-gesture"
    ]);
  });

  test("tapClickableParent does not throw when ADB succeeds but dispatchGesture fails", async () => {
    trySemantic.mockResolvedValue({ success: false, error: "No clickable node within disambiguation bounds" });
    spyOn(fakeAdb, "executeCommand").mockResolvedValue(undefined as any);
    tryCoord.mockResolvedValue({ success: false, error: "gesture rejected" });
    const attempts: { method: string; success: boolean; error?: string }[] = [];
    const el: Element = {
      "bounds": { left: 0, top: 0, right: 100, bottom: 50 },
      "resource-id": "com.example:id/row"
    } as Element;

    await (tapOn as any).executeAndroidTapWithCoordinates(
      "tap",
      50,
      25,
      0,
      el,
      undefined,
      attempts,
      { tapClickableParent: true, action: "tap" }
    );

    expect(attempts.map(a => a.method)).toEqual([
      "android-ctrl-proxy-action-click-bounds",
      "android-adb-shell-input-tap",
      "android-ctrl-proxy-dispatch-gesture"
    ]);
    expect(attempts[2].success).toBe(false);
  });

  test("semantic click without resource-id calls requestAction with bounds only", async () => {
    const requestSpy = spyOn(CtrlProxyClient.prototype, "requestAction").mockResolvedValue({
      success: true,
      action: "click",
      totalTimeMs: 1
    } as any);
    try {
      const fakeTimer = new FakeTimer();
      fakeTimer.enableAutoAdvance();
      const tap = new TapOnElement(
        { name: "d", platform: "android", id: "emulator-5554" } as any,
        new FakeAdbClient() as any,
        {
          accessibilityDetector: new FakeAccessibilityDetector(),
          timer: fakeTimer
        }
      );
      const el: Element = {
        bounds: { left: 10, top: 20, right: 110, bottom: 70 }
      } as Element;

      const result = await (tap as any).tryAndroidSemanticClick(el);

      expect(result.success).toBe(true);
      expect(requestSpy).toHaveBeenCalledWith(
        "click",
        undefined,
        5000,
        expect.anything(),
        { left: 10, top: 20, right: 110, bottom: 70 }
      );
    } finally {
      requestSpy.mockRestore();
    }
  });

  test("omitFrameworkResourceId sends bounds-only click for android:id/text1 rows", async () => {
    const requestSpy = spyOn(CtrlProxyClient.prototype, "requestAction").mockResolvedValue({
      success: true,
      action: "click",
      totalTimeMs: 1
    } as any);
    try {
      const fakeTimer = new FakeTimer();
      fakeTimer.enableAutoAdvance();
      const tap = new TapOnElement(
        { name: "d", platform: "android", id: "emulator-5554" } as any,
        new FakeAdbClient() as any,
        {
          accessibilityDetector: new FakeAccessibilityDetector(),
          timer: fakeTimer
        }
      );
      const el: Element = {
        "bounds": { left: 10, top: 700, right: 1080, bottom: 780 },
        "resource-id": "android:id/text1",
        "text": "Dan Corkill"
      } as Element;

      const result = await (tap as any).tryAndroidSemanticClick(el, undefined, undefined, {
        omitFrameworkResourceId: true
      });

      expect(result.success).toBe(true);
      expect(requestSpy).toHaveBeenCalledWith(
        "click",
        undefined,
        5000,
        expect.anything(),
        { left: 10, top: 700, right: 1080, bottom: 780 }
      );
    } finally {
      requestSpy.mockRestore();
    }
  });

  test("semantic click can use disambiguation bounds override (label overlap)", async () => {
    const requestSpy = spyOn(CtrlProxyClient.prototype, "requestAction").mockResolvedValue({
      success: true,
      action: "click",
      totalTimeMs: 1
    } as any);
    try {
      const fakeTimer = new FakeTimer();
      fakeTimer.enableAutoAdvance();
      const tap = new TapOnElement(
        { name: "d", platform: "android", id: "emulator-5554" } as any,
        new FakeAdbClient() as any,
        {
          accessibilityDetector: new FakeAccessibilityDetector(),
          timer: fakeTimer
        }
      );
      const el: Element = {
        bounds: { left: 0, top: 700, right: 1080, bottom: 800 }
      } as Element;

      const result = await (tap as any).tryAndroidSemanticClick(el, undefined, {
        left: 48,
        top: 715,
        right: 300,
        bottom: 785
      });

      expect(result.success).toBe(true);
      expect(requestSpy).toHaveBeenCalledWith(
        "click",
        undefined,
        5000,
        expect.anything(),
        { left: 48, top: 715, right: 300, bottom: 785 }
      );
    } finally {
      requestSpy.mockRestore();
    }
  });
});
