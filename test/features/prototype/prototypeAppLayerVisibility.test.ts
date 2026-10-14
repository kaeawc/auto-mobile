import { describe, expect, spyOn, test } from "bun:test";
import type {
  HierarchyCapture,
  HierarchyCaptureRequest,
  HierarchySnapshot,
} from "../../../src/features/observe/HierarchyCapture";
import { confirmPrototypeAppLayerVisibility } from "../../../src/features/prototype/prototypeAppLayerVisibility";
import { logger } from "../../../src/utils/logger";
import { FakeTimer } from "../../fakes/FakeTimer";
import {
  capturedAppLayerPrototypeHierarchy,
  capturedTwoWindowHierarchy,
} from "../../helpers/prototypeWindowCapture";

const absent = capturedTwoWindowHierarchy();
const present = capturedAppLayerPrototypeHierarchy();
function fixture(frames: Array<typeof absent | Error>, signal?: AbortSignal) {
  const requests: HierarchyCaptureRequest[] = [];
  const timer = new FakeTimer();
  timer.enableAutoAdvance();
  const capture: HierarchyCapture = {
    async capture(request): Promise<HierarchySnapshot> {
      requests.push(request);
      const frame = frames[requests.length - 1];
      if (frame instanceof Error) {
        throw frame;
      }
      return {
        captureId: "capture",
        platform: "android",
        requestedFreshness: "fresh",
        receivedAt: 0,
        hierarchy: frame,
        nodes: [],
      };
    },
  };
  return {
    requests,
    timer,
    run: () => confirmPrototypeAppLayerVisibility(capture, timer, 7, signal),
  };
}
describe("app-layer visibility confirmation", () => {
  test("first visible capture stops without a wait", async () => {
    const f = fixture([present]);
    expect(await f.run()).toBeUndefined();
    expect(f.requests).toEqual([
      { freshness: "fresh", displayId: 7, timeoutMs: 1000, signal: undefined },
    ]);
    expect(f.timer.getSleepHistory()).toEqual([]);
  });
  test("second capture can observe delayed addView", async () => {
    const f = fixture([absent, present]);
    expect(await f.run()).toBeUndefined();
    expect(f.requests).toHaveLength(2);
    expect(f.timer.getSleepHistory()).toEqual([250]);
  });
  test("three absent captures report the last foreground package", async () => {
    const f = fixture([absent, absent, { ...absent, packageName: "com.android.settings" }]);
    expect(await f.run()).toMatchObject({
      visible: false,
      notVisibleReason: "no_prototype_window_on_screen",
      warning:
        'The prototype was shown with window.layer "app" but no prototype window is on screen. The app in front (com.android.settings) most likely hides app-layer windows drawn over it (system apps such as Settings do); a locked device hides it too. Until it is visible, layer "prototype" calls will report that no prototype is showing. Show it again without window.layer (the default layer draws over every app) or over a different app, or dismiss it.',
    });
    expect(f.requests).toHaveLength(3);
    expect(f.timer.getSleepHistory()).toEqual([250, 250]);
  });
  test("missing package uses the app in front", async () => {
    const frame = { ...absent, packageName: undefined };
    expect(await fixture([frame, frame, frame]).run()).toMatchObject({
      visible: false,
      notVisibleReason: "no_prototype_window_on_screen",
      warning:
        'The prototype was shown with window.layer "app" but no prototype window is on screen. The app in front most likely hides app-layer windows drawn over it (system apps such as Settings do); a locked device hides it too. Until it is visible, layer "prototype" calls will report that no prototype is showing. Show it again without window.layer (the default layer draws over every app) or over a different app, or dismiss it.',
    });
  });
  test("last capture without windows makes no visibility claim", async () => {
    const frame = { ...absent };
    delete frame.windows;
    expect(await fixture([absent, absent, frame]).run()).toBeUndefined();
  });
  test("last capture with empty windows makes no visibility claim", async () => {
    expect(await fixture([absent, absent, { ...absent, windows: [] }]).run()).toBeUndefined();
  });
  test("last incomplete capture makes no visibility claim", async () => {
    expect(
      await fixture([absent, absent, { ...absent, ctrlProxyIncomplete: true }]).run(),
    ).toBeUndefined();
  });
  test("last capture with a hierarchy error makes no visibility claim", async () => {
    expect(
      await fixture([
        absent,
        absent,
        { ...absent, hierarchy: { ...absent.hierarchy, error: "capture failed" } },
      ]).run(),
    ).toBeUndefined();
  });
  test("last suspended frame makes no visibility claim", async () => {
    expect(
      await fixture([absent, absent, { ...absent, prototypeSuspended: true }]).run(),
    ).toBeUndefined();
  });
  test("capture failure logs and stops", async () => {
    const warn = spyOn(logger, "warn").mockImplementation(() => {});
    try {
      const f = fixture([new Error("capture timed out")]);
      expect(await f.run()).toBeUndefined();
      expect(f.requests).toHaveLength(1);
      expect(warn).toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });
  test("abort makes no claim about the dispatched show", async () => {
    const controller = new AbortController();
    controller.abort(new Error("cancelled"));
    const f = fixture([absent], controller.signal);
    expect(await f.run()).toBeUndefined();
    expect(f.requests).toHaveLength(0);
  });
});
