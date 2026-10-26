import { runBlockWith } from "../../helpers/observedInteractionStub";
import { recordObservationRead } from "../../../src/features/observe/observationReadScope";
import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import { TapOnElement } from "../../../src/features/action/TapOnElement";
import { AndroidCtrlProxyClient } from "../../../src/features/observe/android";
import type { ElementBounds } from "../../../src/models/ElementBounds";
import type { ViewHierarchyNode } from "../../../src/models/ViewHierarchyResult";
import { PROTOTYPE_DISMISS_ID } from "../../../src/features/prototype/prototypeHostControls";
import { FakeAccessibilityDetector } from "../../fakes/FakeAccessibilityDetector";
import { FakeAdbExecutor } from "../../fakes/FakeAdbExecutor";
import { FakeCtrlProxy } from "../../fakes/FakeCtrlProxy";
import { FakeTimer } from "../../fakes/FakeTimer";
import { androidControlObservation } from "../../helpers/androidDisabledControlCapture";

let clientSpy: ReturnType<typeof spyOn<typeof AndroidCtrlProxyClient, "getInstance">>;
beforeEach(() => {
  clientSpy = spyOn(AndroidCtrlProxyClient, "getInstance");
});
afterEach(() => {
  mock.restore();
});

// The captured "Disabled" text spans [440,1455][595,1504] and is tapped at its centre (517, 1479).
/** An AutoMobile host dismiss control drawn over part of the captured target. */
function dismissControl(bounds: ElementBounds): ViewHierarchyNode {
  return {
    "resource-id": PROTOTYPE_DISMISS_ID,
    "content-desc": "Dismiss AutoMobile prototype",
    clickable: "true",
    "visible-to-user": true,
    "view-id": "s2-host-dismiss",
    bounds,
  } as ViewHierarchyNode;
}

function createCommand(control: ElementBounds | undefined) {
  const observation = androidControlObservation("enabled");
  const hierarchy = observation.viewHierarchy;
  if (!hierarchy) {
    throw new Error("Expected converted captured hierarchy");
  }
  hierarchy.screenWidth = 1080;
  hierarchy.screenHeight = 2400;
  if (control) {
    // The host control is a sibling of the captured controls, drawn over part of the target.
    hierarchy.hierarchy.node = [hierarchy.hierarchy.node, dismissControl(control)]
      .flat()
      .filter((node): node is ViewHierarchyNode => node !== undefined);
  }
  const timer = new FakeTimer();
  timer.enableAutoAdvance();
  const service = new FakeCtrlProxy(timer);
  clientSpy.mockReturnValue(service);
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
  command.observedInteraction = runBlockWith(() => recordObservationRead(observation));
  return { command, service };
}

describe("tapOn keeps off AutoMobile's host dismiss controls (#15120)", () => {
  test("without a host control the target is tapped at its centre", async () => {
    const { command, service } = createCommand(undefined);
    const result = await command.execute({ action: "tap", text: "Disabled" });
    expect(result.success).toBe(true);
    expect(service.getTapHistory()).toEqual([{ x: 517, y: 1479, duration: 10 }]);
  });

  test("a control over the centre moves the tap to the target's largest part outside it", async () => {
    const { command, service } = createCommand({ left: 500, top: 1400, right: 700, bottom: 1560 });
    const result = await command.execute({ action: "tap", text: "Disabled" });
    expect(result.success).toBe(true);
    const [tap] = service.getTapHistory();
    expect(tap.x).toBeGreaterThanOrEqual(440);
    expect(tap.x).toBeLessThan(500);
    expect(tap.y).toBe(1479);
  });

  test("a control over the whole target fails with a message naming the control", async () => {
    const { command, service } = createCommand({ left: 400, top: 1400, right: 700, bottom: 1560 });
    const result = await command.execute({ action: "tap", text: "Disabled" });
    expect(result.success).toBe(false);
    expect(result.error).toContain(PROTOTYPE_DISMISS_ID);
    expect(service.getTapHistory()).toEqual([]);
  });

  test("a control away from the tap point leaves the point alone", async () => {
    const { command, service } = createCommand({ left: 800, top: 100, right: 1000, bottom: 250 });
    const result = await command.execute({ action: "tap", text: "Disabled" });
    expect(result.success).toBe(true);
    expect(service.getTapHistory()).toEqual([{ x: 517, y: 1479, duration: 10 }]);
  });
});
