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
  RELABELLED_CAPTURE,
  capturedFloatingCoverHierarchy,
  capturedPrototypeHierarchy,
  capturedTwoWindowHierarchy,
  observationOf,
} from "../../helpers/prototypeWindowCapture";

// Captured Recents overview with its floating window relabelled as the CtrlProxy
// prototype; see test/helpers/prototypeWindowCapture.ts. "Settings" is in both
// windows, "YouTube" is prototype-only and "Screenshot" is app-only.
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

function prototypeTop(hierarchy: ViewHierarchyResult) {
  return hierarchy.windows!.find((window) => window.id === RELABELLED_CAPTURE.prototypeWindowId)!
    .bounds!.top;
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
  test('"app" resolves both endpoints outside the prototype window', async () => {
    const hierarchy = capturedPrototypeHierarchy();
    const { command, service } = createCommand(hierarchy);
    const result = await command.execute(drag("Settings", "Screenshot", "app"));

    expect(result.error).toBeUndefined();
    const [call] = service.getDragHistory();
    expect(call.y1).toBeLessThan(prototypeTop(hierarchy));
    expect(call.y2).toBeLessThan(prototypeTop(hierarchy));
  });

  test('"prototype" resolves both endpoints inside the prototype window', async () => {
    const hierarchy = capturedPrototypeHierarchy();
    const { command, service } = createCommand(hierarchy);
    const result = await command.execute(drag("Settings", "YouTube", "prototype"));

    expect(result.error).toBeUndefined();
    const [call] = service.getDragHistory();
    expect(call.y1).toBeGreaterThanOrEqual(prototypeTop(hierarchy));
    expect(call.y2).toBeGreaterThanOrEqual(prototypeTop(hierarchy));
  });

  test('"prototype" scopes the drop target too: an app-only drop target is not found', async () => {
    const { command, service } = createCommand(capturedPrototypeHierarchy());
    const result = await command.execute(drag("Settings", "Screenshot", "prototype"));

    expect(result.success).toBe(false);
    expect(service.getDragHistory()).toEqual([]);
  });

  test('"app" refuses before dispatch when a full-screen prototype covers the endpoint', async () => {
    const { command, service } = createCommand(capturedPrototypeHierarchy({ fullScreen: true }));
    const result = await command.execute(drag("Settings", "Screenshot", "app"));

    expect(result.success).toBe(false);
    expect(result.error).toContain("an AutoMobile prototype window covers that point");
    expect(service.getDragHistory()).toEqual([]);
  });

  test("default layer refuses a drag from an app row a captured floating prototype covers (#10715)", async () => {
    // Device capture: a floating system-layer prototype over the Playground "Elevated" button.
    const { command, service } = createCommand(capturedFloatingCoverHierarchy());
    const result = await command.execute({
      source: { elementId: "button_elevated" },
      target: { elementId: "button_elevated" },
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain(
      "dragAndDrop source is covered by an AutoMobile prototype window",
    );
    expect(service.getDragHistory()).toEqual([]);
  });

  test('"prototype" with no prototype showing is an actionable error', async () => {
    const { command, service } = createCommand(capturedTwoWindowHierarchy());
    const result = await command.execute(drag("Settings", "Screenshot", "prototype"));

    expect(result.success).toBe(false);
    expect(result.error).toContain("no AutoMobile prototype is showing");
    expect(service.getDragHistory()).toEqual([]);
  });
});
