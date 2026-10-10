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
  RELABELLED_CAPTURE,
  capturedPrototypeHierarchy,
  capturedTwoWindowHierarchy,
  observationOf,
} from "../../helpers/prototypeWindowCapture";

// Captured Recents overview with its floating window relabelled as the CtrlProxy
// prototype; see test/helpers/prototypeWindowCapture.ts.
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

function prototypeBounds(hierarchy: ViewHierarchyResult) {
  return hierarchy.windows!.find((window) => window.id === RELABELLED_CAPTURE.prototypeWindowId)!
    .bounds!;
}

afterEach(() => {
  mock.restore();
});

describe("tapAny layer (#9305)", () => {
  test("picks a clickable in the prototype by default and in the app for app", async () => {
    const hierarchy = capturedPrototypeHierarchy();
    const byDefault = createCommand(hierarchy);
    const forApp = createCommand(capturedPrototypeHierarchy());

    expect((await byDefault.command.execute({ action: "tap" })).success).toBe(true);
    expect((await forApp.command.execute({ action: "tap", layer: "app" })).success).toBe(true);

    const top = prototypeBounds(hierarchy).top;
    expect(byDefault.service.getTapHistory()[0].y).toBeGreaterThanOrEqual(top);
    expect(forApp.service.getTapHistory()[0].y).toBeLessThan(top);
  });

  test('"app" refuses before dispatch when a full-screen prototype covers the pick', async () => {
    const { command, service } = createCommand(capturedPrototypeHierarchy({ fullScreen: true }));
    const result = await command.execute({ action: "tap", layer: "app" });

    expect(result.success).toBe(false);
    expect(result.error).toContain("an AutoMobile prototype window covers that point");
    expect(service.getTapHistory()).toEqual([]);
  });

  test("default layer refuses an app pick a full-screen prototype covers, before dispatch (#10715)", async () => {
    const { command, service } = createCommand(capturedPrototypeHierarchy({ fullScreen: true }));
    const result = await command.execute({
      action: "tap",
      // App-only container: the overview action buttons sit in the app window under the prototype.
      container: { elementId: "com.google.android.apps.nexuslauncher:id/action_buttons" },
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain("covered by an AutoMobile prototype window");
    expect(service.getTapHistory()).toEqual([]);
  });

  test('"prototype" with no prototype showing is an actionable error', async () => {
    const { command, service } = createCommand(capturedTwoWindowHierarchy());
    const result = await command.execute({ action: "tap", layer: "prototype" });

    expect(result.success).toBe(false);
    expect(result.error).toContain("no AutoMobile prototype is showing");
    expect(service.getTapHistory()).toEqual([]);
  });
});
