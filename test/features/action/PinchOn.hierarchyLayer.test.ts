import { afterEach, describe, expect, mock, spyOn, test } from "bun:test";
import { PinchOn } from "../../../src/features/action/PinchOn";
import { AndroidCtrlProxyManager } from "../../../src/ctrlProxy/CtrlProxyManager";
import { AndroidCtrlProxyClient } from "../../../src/features/observe/android";
import type { BootedDevice, PinchOnOptions } from "../../../src/models";
import type { ViewHierarchyResult } from "../../../src/models/ViewHierarchyResult";
import { FakeCtrlProxy } from "../../fakes/FakeCtrlProxy";
import { FakeHierarchyCapture } from "../../fakes/FakeHierarchyCapture";
import { FakeObserveScreen } from "../../fakes/FakeObserveScreen";
import { FakeTimer } from "../../fakes/FakeTimer";
import {
  capturedFloatingCoverHierarchy,
  capturedTwoWindowHierarchy,
  observationOf,
} from "../../helpers/overlayWindowCapture";

const device: BootedDevice = {
  name: "Android test device",
  platform: "android",
  deviceId: "emulator-5600",
};

// Device capture: a floating prototype window 170 [525,1565][1011,1723] (node `coverBox`) over
// the Playground Tap screen, whose `button_elevated` [550,1589][996,1715] lies under it and whose
// scrollable `tap_screen_content` [0,652][1080,2064] is centred outside it. See
// test/fixtures/android-overlay-window/README.txt.
const OVERLAY_BOUNDS = { left: 525, top: 1565, right: 1011, bottom: 1723 };

function createPinch(hierarchy: ViewHierarchyResult) {
  const timer = new FakeTimer();
  timer.enableAutoAdvance();
  const service = new FakeCtrlProxy(timer);
  spyOn(AndroidCtrlProxyClient, "getInstance").mockReturnValue(service);
  spyOn(AndroidCtrlProxyManager, "getInstance").mockReturnValue({
    isAvailable: async () => true,
  } as unknown as AndroidCtrlProxyManager);
  const observation = { ...observationOf(hierarchy), screenSize: { width: 1080, height: 2400 } };
  const observeScreen = new FakeObserveScreen();
  observeScreen.setObserveResult(observation);
  const pinchOn = new PinchOn(device, null, {
    timer,
    capture: new FakeHierarchyCapture(() => hierarchy),
  });
  pinchOn.observeScreen = observeScreen;
  pinchOn.observedInteraction = (action) => action(observation);
  return { pinchOn, service };
}

const pinch = (elementId: string, layer?: PinchOnOptions["layer"]): PinchOnOptions => ({
  direction: "out",
  container: { elementId },
  layer,
});

afterEach(() => {
  mock.restore();
});

describe("pinchOn layer (#9305)", () => {
  test('"overlay" resolves the container among overlay nodes and pinches inside the overlay', async () => {
    const { pinchOn, service } = createPinch(capturedFloatingCoverHierarchy());
    const result = await pinchOn.execute(pinch("coverBox", "overlay"));

    expect(result.error).toBeUndefined();
    const [call] = service.getPinchHistory();
    expect(call.centerX - call.distanceStart / 2).toBeGreaterThanOrEqual(OVERLAY_BOUNDS.left);
    expect(call.centerX + call.distanceStart / 2).toBeLessThan(OVERLAY_BOUNDS.right);
    expect(call.centerY).toBeGreaterThanOrEqual(OVERLAY_BOUNDS.top);
  });

  test('"app" excludes overlay nodes from container resolution', async () => {
    const { pinchOn, service } = createPinch(capturedFloatingCoverHierarchy());
    const result = await pinchOn.execute(pinch("coverBox", "app"));

    expect(result.error).toContain("Container element not found for pinchOn");
    expect(service.getPinchHistory()).toEqual([]);
  });

  test('"app" refuses before dispatch when the overlay covers a finger start point', async () => {
    const { pinchOn, service } = createPinch(capturedFloatingCoverHierarchy());
    const result = await pinchOn.execute(pinch("button_elevated", "app"));

    expect(result.success).toBe(false);
    expect(result.error).toContain("Cannot pinch at");
    expect(result.error).toContain('with layer "app"');
    expect(service.getPinchHistory()).toEqual([]);
  });

  test('"app" pinches an app container whose fingers land outside the overlay', async () => {
    const { pinchOn, service } = createPinch(capturedFloatingCoverHierarchy());
    const result = await pinchOn.execute(pinch("tap_screen_content", "app"));

    expect(result.error).toBeUndefined();
    expect(service.getPinchHistory()).toHaveLength(1);
  });

  test('"overlay" excludes app nodes from container resolution', async () => {
    const { pinchOn, service } = createPinch(capturedFloatingCoverHierarchy());
    const result = await pinchOn.execute(pinch("tap_screen_content", "overlay"));

    expect(result.error).toContain("Container element not found for pinchOn");
    expect(service.getPinchHistory()).toEqual([]);
  });

  test('"overlay" with no overlay showing is an actionable error', async () => {
    const { pinchOn, service } = createPinch(capturedTwoWindowHierarchy());
    const result = await pinchOn.execute({ direction: "in", layer: "overlay" });

    expect(result.success).toBe(false);
    expect(result.error).toContain("no AutoMobile overlay is showing");
    expect(service.getPinchHistory()).toEqual([]);
  });

  test("omitting layer keeps today's behaviour for the covered app container", async () => {
    const { pinchOn, service } = createPinch(capturedFloatingCoverHierarchy());
    const result = await pinchOn.execute(pinch("button_elevated"));

    expect(result.error).toBeUndefined();
    expect(service.getPinchHistory()).toHaveLength(1);
  });
});
