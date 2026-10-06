import { recordObservationRead } from "../../../src/features/observe/observationReadScope";
import { afterEach, describe, expect, mock, spyOn, test } from "bun:test";
import { CTRL_PROXY_PACKAGE } from "../../../src/ctrlProxy/constants";
import { TapOnElement } from "../../../src/features/action/TapOnElement";
import { AndroidCtrlProxyClient } from "../../../src/features/observe/android";
import { FakeAccessibilityDetector } from "../../fakes/FakeAccessibilityDetector";
import { FakeAdbExecutor } from "../../fakes/FakeAdbExecutor";
import { FakeCtrlProxy } from "../../fakes/FakeCtrlProxy";
import { FakeTimer } from "../../fakes/FakeTimer";
import { androidControlObservation } from "../../helpers/androidDisabledControlCapture";

// The captured control is tapped at (517, 1479). Raising the status bar inset above that
// point stands in for an overlay control drawn under the bar (#10086).
const screen = { left: 0, top: 0, right: 1080, bottom: 2400 };

function createCommand(options: { overlay: boolean; statusBarHeight: number }) {
  const observation = androidControlObservation("enabled");
  const hierarchy = observation.viewHierarchy;
  if (!hierarchy) {
    throw new Error("Expected converted captured hierarchy");
  }
  hierarchy.screenWidth = 1080;
  hierarchy.screenHeight = 2400;
  hierarchy.systemInsets = { top: options.statusBarHeight, bottom: 63, left: 0, right: 0 };
  hierarchy.windows = options.overlay
    ? [{ id: 2, type: 4, packageName: CTRL_PROXY_PACKAGE, bounds: screen }]
    : [];
  const timer = new FakeTimer();
  timer.enableAutoAdvance();
  const service = new FakeCtrlProxy(timer);
  spyOn(AndroidCtrlProxyClient, "getInstance").mockReturnValue(service);
  const detector = new FakeAccessibilityDetector();
  detector.setDefaultResult(false);
  const command = new TapOnElement(
    { name: "Fake Android", deviceId: "fake-android", platform: "android" },
    new FakeAdbExecutor(),
    {
      timer,
      accessibilityDetector: detector,
      selectionStateTracker: { prepare: async () => null, finalize: async () => [] },
    },
  );
  spyOn(command, "observedInteraction").mockImplementation(async (block) =>
    block(recordObservationRead(observation)),
  );
  return { command, service };
}

afterEach(() => {
  mock.restore();
});

describe("Android tapOn under a system bar while an AutoMobile overlay is shown (#10086)", () => {
  test("fails instead of reporting a tap the overlay control cannot receive", async () => {
    const { command, service } = createCommand({ overlay: true, statusBarHeight: 1500 });
    const result = await command.execute({ action: "tap", text: "Disabled" });
    expect(result.success).toBe(false);
    expect(result.error).toContain("under the status bar");
    expect(result.error).toContain("safeAreaPadding");
    expect(service.getTapHistory()).toEqual([]);
  });

  test("the same point taps normally when no own overlay window is shown", async () => {
    const { command, service } = createCommand({ overlay: false, statusBarHeight: 1500 });
    const result = await command.execute({ action: "tap", text: "Disabled" });
    expect(result.success).toBe(true);
    expect(service.getTapHistory()).toEqual([{ x: 517, y: 1479, duration: 10 }]);
  });

  test("an overlay control inside the safe area taps normally", async () => {
    const { command, service } = createCommand({ overlay: true, statusBarHeight: 136 });
    const result = await command.execute({ action: "tap", text: "Disabled" });
    expect(result.success).toBe(true);
    expect(service.getTapHistory()).toEqual([{ x: 517, y: 1479, duration: 10 }]);
  });
});
