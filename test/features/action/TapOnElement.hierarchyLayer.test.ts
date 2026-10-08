import { afterEach, describe, expect, mock, spyOn, test } from "bun:test";
import { TapOnElement } from "../../../src/features/action/TapOnElement";
import { AndroidCtrlProxyClient } from "../../../src/features/observe/android";
import { recordObservationRead } from "../../../src/features/observe/observationReadScope";
import type { ViewHierarchyResult } from "../../../src/models/ViewHierarchyResult";
import { FakeAccessibilityDetector } from "../../fakes/FakeAccessibilityDetector";
import { FakeAdbExecutor } from "../../fakes/FakeAdbExecutor";
import { FakeCtrlProxy } from "../../fakes/FakeCtrlProxy";
import { FakeTimer } from "../../fakes/FakeTimer";
import {
  OVERLAY_CAPTURE,
  capturedFloatingCoverHierarchy,
  capturedOverlayHierarchy,
  capturedTwoWindowHierarchy,
  observationOf,
} from "../../helpers/overlayWindowCapture";

// Captured Recents overview with its floating window relabelled as the CtrlProxy
// overlay; see test/helpers/overlayWindowCapture.ts.
function createCommand(viewHierarchy: ViewHierarchyResult) {
  const observation = observationOf(viewHierarchy);
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
  return { command, service, viewHierarchy };
}

function overlayBounds(hierarchy: ViewHierarchyResult) {
  return hierarchy.windows!.find((window) => window.id === OVERLAY_CAPTURE.overlayWindowId)!
    .bounds!;
}

afterEach(() => {
  mock.restore();
});

describe("tapOn layer (#9305)", () => {
  test("text in both windows taps the overlay by default", async () => {
    const { command, service, viewHierarchy } = createCommand(capturedOverlayHierarchy());
    const result = await command.execute({ action: "tap", text: "Settings" });

    expect(result.success).toBe(true);
    const [tap] = service.getTapHistory();
    expect(tap.y).toBeGreaterThanOrEqual(overlayBounds(viewHierarchy).top);
  });

  test('layer "overlay" taps the overlay\'s match', async () => {
    const { command, service, viewHierarchy } = createCommand(capturedOverlayHierarchy());
    const result = await command.execute({ action: "tap", text: "Settings", layer: "overlay" });

    expect(result.success).toBe(true);
    const [tap] = service.getTapHistory();
    expect(tap.y).toBeGreaterThanOrEqual(overlayBounds(viewHierarchy).top);
  });

  test('layer "app" taps the app\'s match outside the overlay window', async () => {
    const { command, service, viewHierarchy } = createCommand(capturedOverlayHierarchy());
    const result = await command.execute({ action: "tap", text: "Settings", layer: "app" });

    expect(result.success).toBe(true);
    const [tap] = service.getTapHistory();
    expect(tap.y).toBeLessThan(overlayBounds(viewHierarchy).top);
  });

  test('layer "app" refuses before dispatch when a full-screen overlay covers the match', async () => {
    const { command, service } = createCommand(capturedOverlayHierarchy({ fullScreen: true }));
    const result = await command.execute({ action: "tap", text: "Settings", layer: "app" });

    expect(result.success).toBe(false);
    expect(result.error).toContain("an AutoMobile overlay window covers that point");
    expect(service.getTapHistory()).toEqual([]);
  });

  test("default layer refuses an app row a captured floating overlay covers, before dispatch", async () => {
    // Device capture: a floating system-layer prototype over the Playground "Elevated" button,
    // which the device hierarchy keeps under the overlay (own-overlay occlusion exemption).
    const { command, service } = createCommand(capturedFloatingCoverHierarchy());
    const result = await command.execute({ action: "tap", elementId: "button_elevated" });

    expect(result.success).toBe(false);
    expect(result.error).toContain("AutoMobile overlay");
    expect(service.getTapHistory()).toEqual([]);
  });

  test("default layer refuses an app-only match under a full-screen overlay, before dispatch", async () => {
    const { command, service } = createCommand(capturedOverlayHierarchy({ fullScreen: true }));
    const result = await command.execute({ action: "tap", text: "Screenshot" });

    expect(result.success).toBe(false);
    expect(result.error).toContain("AutoMobile overlay");
    expect(service.getTapHistory()).toEqual([]);
  });

  test('layer "app" cannot reach an overlay-only element', async () => {
    const { command, service } = createCommand(capturedOverlayHierarchy());
    const result = await command.execute({ action: "tap", text: "YouTube", layer: "app" });

    expect(result.success).toBe(false);
    expect(service.getTapHistory()).toEqual([]);
  });

  test('layer "overlay" with no overlay showing is an actionable error', async () => {
    const { command, service } = createCommand(capturedTwoWindowHierarchy());
    const result = await command.execute({ action: "tap", text: "Settings", layer: "overlay" });

    expect(result.success).toBe(false);
    expect(result.error).toContain("no AutoMobile overlay is showing");
    expect(service.getTapHistory()).toEqual([]);
  });

  test("layer cannot be combined with a device-resolved semantic link", async () => {
    const { command, service } = createCommand(capturedOverlayHierarchy());
    const result = await command.execute({
      action: "tap",
      accessibilityLink: "Settings",
      layer: "app",
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain("layer cannot be used with accessibilityLink or subtext");
    expect(service.getTapHistory()).toEqual([]);
  });
});
