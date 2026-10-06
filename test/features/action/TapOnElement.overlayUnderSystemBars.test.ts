import { recordObservationRead } from "../../../src/features/observe/observationReadScope";
import { afterEach, describe, expect, mock, spyOn, test } from "bun:test";
import { CTRL_PROXY_PACKAGE } from "../../../src/ctrlProxy/constants";
import { TapOnElement } from "../../../src/features/action/TapOnElement";
import { AndroidCtrlProxyClient } from "../../../src/features/observe/android";
import type { ObservationInsets } from "../../../src/models/ObservationInsets";
import { FakeAccessibilityDetector } from "../../fakes/FakeAccessibilityDetector";
import { FakeAdbExecutor } from "../../fakes/FakeAdbExecutor";
import { FakeCtrlProxy } from "../../fakes/FakeCtrlProxy";
import { FakeTimer } from "../../fakes/FakeTimer";
import { androidControlObservation } from "../../helpers/androidDisabledControlCapture";

// The captured control is tapped at (517, 1479). Raising the status bar inset above that
// point stands in for a control drawn under the bar (#10086).
const screen = { left: 0, top: 0, right: 1080, bottom: 2400 };

function barInsets(visibleTop: number, stableTop: number = visibleTop): ObservationInsets {
  return {
    available: true,
    source: "android-window-metrics",
    units: "physical-pixels",
    systemBars: {
      visible: { top: visibleTop, bottom: 63, left: 0, right: 0 },
      stable: { top: stableTop, bottom: 63, left: 0, right: 0 },
    },
  };
}

interface Scenario {
  /** The captured control is rendered by the overlay window (otherwise by the app). */
  overlayOwnsControl: boolean;
  /** An own overlay window is on screen at all. */
  overlayShown?: boolean;
  /** Typed insets; omitted means the capture carries no per-bar visibility. */
  insets?: ObservationInsets;
  /** The gesture-merged stable alias the host has always kept. */
  legacyTop: number;
}

function createCommand(scenario: Scenario) {
  const observation = androidControlObservation("enabled");
  const hierarchy = observation.viewHierarchy;
  if (!hierarchy) {
    throw new Error("Expected converted captured hierarchy");
  }
  hierarchy.screenWidth = 1080;
  hierarchy.screenHeight = 2400;
  hierarchy.systemInsets = { top: scenario.legacyTop, bottom: 63, left: 0, right: 0 };
  hierarchy.insets = scenario.insets;
  const shown = scenario.overlayShown ?? scenario.overlayOwnsControl;
  const capturedRoot = hierarchy.hierarchy;
  hierarchy.windows = shown
    ? [
        {
          id: 2,
          type: 4,
          packageName: CTRL_PROXY_PACKAGE,
          bounds: screen,
          ...(scenario.overlayOwnsControl ? { hierarchy: capturedRoot } : {}),
        },
      ]
    : [];
  if (scenario.overlayOwnsControl) {
    // The overlay window renders the control; the main (app) tree no longer does.
    hierarchy.hierarchy = {};
  }
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
    const { command, service } = createCommand({
      overlayOwnsControl: true,
      insets: barInsets(2000),
      legacyTop: 2000,
    });
    const result = await command.execute({ action: "tap", text: "Disabled" });
    expect(result.success).toBe(false);
    expect(result.error).toContain("under the status bar");
    expect(result.error).toContain("safeAreaPadding");
    expect(service.getTapHistory()).toEqual([]);
  });

  test("a control that is not the overlay's is never refused, whatever the overlay covers", async () => {
    const { command, service } = createCommand({
      overlayOwnsControl: false,
      overlayShown: true,
      insets: barInsets(1500),
      legacyTop: 1500,
    });
    const result = await command.execute({ action: "tap", text: "Disabled" });
    expect(result.success).toBe(true);
    expect(service.getTapHistory()).toEqual([{ x: 517, y: 1479, duration: 10 }]);
  });

  test("the same point taps normally when no own overlay window is shown", async () => {
    const { command, service } = createCommand({
      overlayOwnsControl: false,
      overlayShown: false,
      insets: barInsets(1500),
      legacyTop: 1500,
    });
    const result = await command.execute({ action: "tap", text: "Disabled" });
    expect(result.success).toBe(true);
    expect(service.getTapHistory()).toEqual([{ x: 517, y: 1479, duration: 10 }]);
  });

  test("an overlay control inside the safe area taps normally", async () => {
    const { command, service } = createCommand({
      overlayOwnsControl: true,
      insets: barInsets(136),
      legacyTop: 168,
    });
    const result = await command.execute({ action: "tap", text: "Disabled" });
    expect(result.success).toBe(true);
    expect(result.warnings).toBeUndefined();
    expect(service.getTapHistory()).toEqual([{ x: 517, y: 1479, duration: 10 }]);
  });

  test("hidden bars do not refuse: only the visible insets count, not the stable ones", async () => {
    const { command, service } = createCommand({
      overlayOwnsControl: true,
      insets: barInsets(0, 2000),
      legacyTop: 2000,
    });
    const result = await command.execute({ action: "tap", text: "Disabled" });
    expect(result.success).toBe(true);
    expect(service.getTapHistory()).toEqual([{ x: 517, y: 1479, duration: 10 }]);
  });

  test("without per-bar visibility the tap proceeds with a warning instead of a refusal", async () => {
    const { command, service } = createCommand({ overlayOwnsControl: true, legacyTop: 2000 });
    const result = await command.execute({ action: "tap", text: "Disabled" });
    expect(result.success).toBe(true);
    expect(result.warnings?.join(" ")).toContain("does not say whether the bars are showing");
    expect(service.getTapHistory()).toEqual([{ x: 517, y: 1479, duration: 10 }]);
  });

  test("a control partly under the bar is tapped in its reachable part", async () => {
    // The bar ends inside the control, below its centre.
    const probe = createCommand({
      overlayOwnsControl: true,
      insets: barInsets(136),
      legacyTop: 136,
    });
    const bounds = (await probe.command.execute({ action: "tap", text: "Disabled" })).element
      ?.bounds;
    if (!bounds) {
      throw new Error("Expected the captured control bounds");
    }
    const barEnd = bounds.bottom - 5;
    mock.restore();

    const { command, service } = createCommand({
      overlayOwnsControl: true,
      insets: barInsets(barEnd),
      legacyTop: barEnd,
    });
    const result = await command.execute({ action: "tap", text: "Disabled" });
    expect(result.success).toBe(true);
    expect(service.getTapHistory()).toEqual([
      { x: 517, y: Math.floor((barEnd + bounds.bottom) / 2), duration: 10 },
    ]);
  });
});
