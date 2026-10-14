import { describe, expect, spyOn, test } from "bun:test";
import type {
  HierarchyCapture,
  HierarchyCaptureRequest,
  HierarchySnapshot,
} from "../../../src/features/observe/HierarchyCapture";
import {
  confirmPrototypeAppLayerVisibility,
  prototypeAppLayerVisibilityOutput,
} from "../../../src/features/prototype/prototypeAppLayerVisibility";
import { logger } from "../../../src/utils/logger";
import { FakeTimer } from "../../fakes/FakeTimer";
import {
  capturedAppLayerPrototypeHierarchy,
  capturedTwoWindowHierarchy,
} from "../../helpers/prototypeWindowCapture";

const absent = capturedTwoWindowHierarchy();
const present = capturedAppLayerPrototypeHierarchy();
function fixture(
  frames: Array<typeof absent | Error>,
  signal?: AbortSignal,
  hiddenReason?: "app_layer_window_hidden" | "device_blocked",
) {
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
    run: () => confirmPrototypeAppLayerVisibility(capture, timer, 7, signal, hiddenReason),
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

for (const reason of ["app_layer_window_hidden", "device_blocked"] as const) {
  test(`capture hidden reason ${reason} wins over show hint and lacks window evidence`, async () => {
    const frame = { ...absent, windows: [], prototypeHiddenReason: reason };
    const f = fixture([absent, absent, frame], undefined, "app_layer_window_hidden");
    expect(await f.run()).toMatchObject({ visible: false, notVisibleReason: reason });
  });
  test(`show hidden reason ${reason} is fallback; visible wins`, async () => {
    expect(await fixture([absent, absent, absent], undefined, reason).run()).toMatchObject({
      visible: false,
      notVisibleReason: reason,
    });
    expect(
      await fixture([{ ...present, prototypeHiddenReason: reason }], undefined, reason).run(),
    ).toBeUndefined();
  });
}
test("blocked system-layer output skips capture and superseded shows add nothing", async () => {
  const request = {
    android: true,
    action: "show",
    success: true,
    spec: { id: "panel", root: { type: "text" as const, text: "Hello" } },
    hiddenReason: "device_blocked" as const,
    superseded: () => false,
    capture: () => {
      throw new Error("capture must not be requested");
    },
  };
  expect(await prototypeAppLayerVisibilityOutput(request)).toEqual({
    visible: false,
    notVisibleReason: "device_blocked",
    warning:
      "The AutoMobile prototype is hidden: the device is locked or its screen is off. Wake and unlock the device (the prototype returns with its state).",
  });
  expect(await prototypeAppLayerVisibilityOutput({ ...request, superseded: () => true })).toEqual(
    {},
  );
});
test("older-device output is byte-identical", async () => {
  expect(await fixture([absent, absent, absent]).run()).toEqual({
    visible: false,
    notVisibleReason: "no_prototype_window_on_screen",
    warning: `The prototype was shown with window.layer "app" but no prototype window is on screen. The app in front (${absent.packageName}) most likely hides app-layer windows drawn over it (system apps such as Settings do); a locked device hides it too. Until it is visible, layer "prototype" calls will report that no prototype is showing. Show it again without window.layer (the default layer draws over every app) or over a different app, or dismiss it.`,
  });
});

test("only the last capture supplies a hidden reason; show fallback names the foreground package", async () => {
  const f = fixture(
    [{ ...absent, prototypeHiddenReason: "device_blocked" }, absent, absent],
    undefined,
    "app_layer_window_hidden",
  );
  expect(await f.run()).toEqual({
    visible: false,
    notVisibleReason: "app_layer_window_hidden",
    warning: `The AutoMobile prototype is hidden: it was shown with window.layer "app" and the app in front (${absent.packageName}) hides app-layer windows drawn over it (system apps such as Settings do). Show it again without window.layer (the default layer draws over every app) or over a different app.`,
  });
});
