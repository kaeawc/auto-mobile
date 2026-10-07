import { afterEach, describe, expect, mock, spyOn, test } from "bun:test";
import { DragAndDrop } from "../../../src/features/action/DragAndDrop";
import { AndroidCtrlProxyManager } from "../../../src/ctrlProxy/CtrlProxyManager";
import { AndroidCtrlProxyClient } from "../../../src/features/observe/android";
import type { DragAndDropOptions } from "../../../src/models";
import type { ViewHierarchyResult } from "../../../src/models/ViewHierarchyResult";
import { FakeAdbExecutor } from "../../fakes/FakeAdbExecutor";
import { FakeCtrlProxy } from "../../fakes/FakeCtrlProxy";
import { FakeHierarchyCapture } from "../../fakes/FakeHierarchyCapture";
import { FakeTimer } from "../../fakes/FakeTimer";
import {
  OVERLAY_CAPTURE,
  capturedOverlayHierarchy,
  capturedTwoWindowHierarchy,
  observationOf,
} from "../../helpers/overlayWindowCapture";

// Captured Recents overview with its floating window relabelled as the CtrlProxy
// overlay; see test/helpers/overlayWindowCapture.ts. "Settings" is in both
// windows, "YouTube" is overlay-only and "Screenshot" is app-only.
function createCommand(viewHierarchy: ViewHierarchyResult) {
  const timer = new FakeTimer();
  timer.enableAutoAdvance();
  const service = new FakeCtrlProxy(timer);
  service.setDragResult({ success: true, totalTimeMs: 1, gestureTimeMs: 1 });
  spyOn(AndroidCtrlProxyClient, "getInstance").mockReturnValue(service);
  spyOn(AndroidCtrlProxyManager, "getInstance").mockReturnValue({
    isAvailable: async () => true,
  } as unknown as AndroidCtrlProxyManager);
  const command = new DragAndDrop(
    { name: "Fake Android", deviceId: "fake-android", platform: "android" },
    new FakeAdbExecutor(),
    timer,
    { hierarchyCapture: new FakeHierarchyCapture(() => viewHierarchy) },
  );
  command.observedInteraction = (action) => action(observationOf(viewHierarchy));
  return { command, service };
}

function overlayTop(hierarchy: ViewHierarchyResult) {
  return hierarchy.windows!.find((window) => window.id === OVERLAY_CAPTURE.overlayWindowId)!.bounds!
    .top;
}

const drag = (
  source: string,
  target: string,
  layer?: DragAndDropOptions["layer"],
): DragAndDropOptions => ({ source: { text: source }, target: { text: target }, layer });

afterEach(() => {
  mock.restore();
});

describe("dragAndDrop layer (#9305)", () => {
  test('"app" resolves both endpoints outside the overlay window', async () => {
    const hierarchy = capturedOverlayHierarchy();
    const { command, service } = createCommand(hierarchy);
    const result = await command.execute(drag("Settings", "Screenshot", "app"));

    expect(result.error).toBeUndefined();
    const [call] = service.getDragHistory();
    expect(call.y1).toBeLessThan(overlayTop(hierarchy));
    expect(call.y2).toBeLessThan(overlayTop(hierarchy));
  });

  test('"overlay" resolves both endpoints inside the overlay window', async () => {
    const hierarchy = capturedOverlayHierarchy();
    const { command, service } = createCommand(hierarchy);
    const result = await command.execute(drag("Settings", "YouTube", "overlay"));

    expect(result.error).toBeUndefined();
    const [call] = service.getDragHistory();
    expect(call.y1).toBeGreaterThanOrEqual(overlayTop(hierarchy));
    expect(call.y2).toBeGreaterThanOrEqual(overlayTop(hierarchy));
  });

  test('"overlay" scopes the drop target too: an app-only drop target is not found', async () => {
    const { command, service } = createCommand(capturedOverlayHierarchy());
    const result = await command.execute(drag("Settings", "Screenshot", "overlay"));

    expect(result.success).toBe(false);
    expect(service.getDragHistory()).toEqual([]);
  });

  test('"app" refuses before dispatch when a full-screen overlay covers the endpoint', async () => {
    const { command, service } = createCommand(capturedOverlayHierarchy({ fullScreen: true }));
    const result = await command.execute(drag("Settings", "Screenshot", "app"));

    expect(result.success).toBe(false);
    expect(result.error).toContain("an AutoMobile overlay window covers that point");
    expect(service.getDragHistory()).toEqual([]);
  });

  test('"overlay" with no overlay showing is an actionable error', async () => {
    const { command, service } = createCommand(capturedTwoWindowHierarchy());
    const result = await command.execute(drag("Settings", "Screenshot", "overlay"));

    expect(result.success).toBe(false);
    expect(result.error).toContain("no AutoMobile overlay is showing");
    expect(service.getDragHistory()).toEqual([]);
  });
});
