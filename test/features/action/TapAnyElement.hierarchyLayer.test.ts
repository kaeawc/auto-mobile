import { afterEach, describe, expect, mock, spyOn, test } from "bun:test";
import { TapAnyElement } from "../../../src/features/action/TapAnyElement";
import { AndroidCtrlProxyClient } from "../../../src/features/observe/android";
import { recordObservationRead } from "../../../src/features/observe/observationReadScope";
import type { ViewHierarchyResult } from "../../../src/models/ViewHierarchyResult";
import { FakeAccessibilityDetector } from "../../fakes/FakeAccessibilityDetector";
import { FakeAdbExecutor } from "../../fakes/FakeAdbExecutor";
import { FakeCtrlProxy } from "../../fakes/FakeCtrlProxy";
import { FakeTimer } from "../../fakes/FakeTimer";
import {
  OVERLAY_CAPTURE,
  capturedOverlayHierarchy,
  capturedTwoWindowHierarchy,
  observationOf,
} from "../../helpers/overlayWindowCapture";

// Captured Recents overview with its floating window relabelled as the CtrlProxy
// overlay; see test/helpers/overlayWindowCapture.ts.
function createCommand(viewHierarchy: ViewHierarchyResult) {
  const timer = new FakeTimer();
  timer.enableAutoAdvance();
  const service = new FakeCtrlProxy(timer);
  spyOn(AndroidCtrlProxyClient, "getInstance").mockReturnValue(service);
  const detector = new FakeAccessibilityDetector();
  detector.setDefaultResult(false);
  const command = new TapAnyElement(
    { name: "Fake Android", deviceId: "fake-android", platform: "android" },
    new FakeAdbExecutor(),
    { timer, accessibilityDetector: detector },
  );
  command.setRefreshViewHierarchyForTesting(async () => null);
  command.observedInteraction = (action) =>
    action(recordObservationRead(observationOf(viewHierarchy)));
  return { command, service };
}

function overlayBounds(hierarchy: ViewHierarchyResult) {
  return hierarchy.windows!.find((window) => window.id === OVERLAY_CAPTURE.overlayWindowId)!
    .bounds!;
}

afterEach(() => {
  mock.restore();
});

describe("tapAny layer (#9305)", () => {
  test("picks a clickable in the overlay by default and in the app for app", async () => {
    const hierarchy = capturedOverlayHierarchy();
    const byDefault = createCommand(hierarchy);
    const forApp = createCommand(capturedOverlayHierarchy());

    expect((await byDefault.command.execute({ action: "tap" })).success).toBe(true);
    expect((await forApp.command.execute({ action: "tap", layer: "app" })).success).toBe(true);

    const top = overlayBounds(hierarchy).top;
    expect(byDefault.service.getTapHistory()[0].y).toBeGreaterThanOrEqual(top);
    expect(forApp.service.getTapHistory()[0].y).toBeLessThan(top);
  });

  test('"app" refuses before dispatch when a full-screen overlay covers the pick', async () => {
    const { command, service } = createCommand(capturedOverlayHierarchy({ fullScreen: true }));
    const result = await command.execute({ action: "tap", layer: "app" });

    expect(result.success).toBe(false);
    expect(result.error).toContain("an AutoMobile overlay window covers that point");
    expect(service.getTapHistory()).toEqual([]);
  });

  test('"overlay" with no overlay showing is an actionable error', async () => {
    const { command, service } = createCommand(capturedTwoWindowHierarchy());
    const result = await command.execute({ action: "tap", layer: "overlay" });

    expect(result.success).toBe(false);
    expect(result.error).toContain("no AutoMobile overlay is showing");
    expect(service.getTapHistory()).toEqual([]);
  });
});
