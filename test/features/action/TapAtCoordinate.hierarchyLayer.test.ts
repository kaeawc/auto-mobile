import { describe, expect, test } from "bun:test";
import type { BootedDevice, ObserveResult } from "../../../src/models";
import type { ViewHierarchyResult } from "../../../src/models/ViewHierarchyResult";
import { createTapAt } from "../../helpers/tapAtCoordinate";
import {
  capturedAppLayerOverlayHierarchy,
  capturedFloatingCoverHierarchy,
  capturedTwoWindowHierarchy,
  observationOf,
} from "../../helpers/overlayWindowCapture";

const androidDevice = {
  name: "Android test device",
  platform: "android",
  deviceId: "emulator-5600",
} as BootedDevice;

// Device captures (API 36, 1080x2400): see test/fixtures/android-overlay-window/README.txt.
// The floating prototype window 170 spans [525,1565][1011,1723]; the app-layer one 174 spans
// [370,1063][710,1337].
const INSIDE_FLOATING = { x: 768, y: 1644 };
const INSIDE_APP_LAYER = { x: 540, y: 1200 };
const APP_ONLY = { x: 100, y: 400 };

function deviceObservation(hierarchy: ViewHierarchyResult): ObserveResult {
  return { ...observationOf(hierarchy), screenSize: { width: 1080, height: 2400 } };
}

function tapAtOver(hierarchy: ViewHierarchyResult) {
  const harness = createTapAt(androidDevice, 1080, 2400);
  harness.observeScreen.setObserveResult(deviceObservation(hierarchy));
  return harness;
}

describe("tapAt layer (#9305)", () => {
  test('"app" refuses before dispatch when the captured floating overlay covers the point', async () => {
    const { tapAt, androidDispatches } = tapAtOver(capturedFloatingCoverHierarchy());
    const result = await tapAt.execute({ ...INSIDE_FLOATING, layer: "app" });

    expect(result.success).toBe(false);
    expect(result.error).toContain('Cannot tap at (768, 1644) with layer "app"');
    expect(androidDispatches).toEqual([]);
  });

  test('"app" refuses a long press under the captured app-layer overlay window too', async () => {
    const { tapAt, androidDispatches } = tapAtOver(capturedAppLayerOverlayHierarchy());
    const result = await tapAt.execute({
      ...INSIDE_APP_LAYER,
      action: "longPress",
      layer: "app",
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain("Cannot long press at (540, 1200)");
    expect(androidDispatches).toEqual([]);
  });

  test('"app" dispatches a point outside the overlay window', async () => {
    const { tapAt, androidDispatches } = tapAtOver(capturedFloatingCoverHierarchy());
    const result = await tapAt.execute({ ...APP_ONLY, layer: "app" });

    expect(result.error).toBeUndefined();
    expect(androidDispatches.map(({ x, y }) => ({ x, y }))).toEqual([APP_ONLY]);
  });

  test('"overlay" dispatches a point inside the overlay window', async () => {
    const { tapAt, androidDispatches } = tapAtOver(capturedFloatingCoverHierarchy());
    const result = await tapAt.execute({ ...INSIDE_FLOATING, layer: "overlay" });

    expect(result.error).toBeUndefined();
    expect(androidDispatches.map(({ x, y }) => ({ x, y }))).toEqual([INSIDE_FLOATING]);
  });

  test('"overlay" refuses a point the overlay does not cover, which would reach the app', async () => {
    const { tapAt, androidDispatches } = tapAtOver(capturedFloatingCoverHierarchy());
    const result = await tapAt.execute({ ...APP_ONLY, layer: "overlay" });

    expect(result.success).toBe(false);
    expect(result.error).toContain("no AutoMobile overlay window covers that point");
    expect(androidDispatches).toEqual([]);
  });

  test('"overlay" with no overlay showing is an actionable error', async () => {
    const { tapAt, androidDispatches } = tapAtOver(capturedTwoWindowHierarchy());
    const result = await tapAt.execute({ ...APP_ONLY, layer: "overlay" });

    expect(result.success).toBe(false);
    expect(result.error).toContain("no AutoMobile overlay is showing");
    expect(androidDispatches).toEqual([]);
  });

  test("omitting layer keeps today's behaviour: the overlay point is dispatched", async () => {
    const { tapAt, androidDispatches } = tapAtOver(capturedFloatingCoverHierarchy());
    const result = await tapAt.execute({ ...INSIDE_FLOATING });

    expect(result.error).toBeUndefined();
    expect(androidDispatches).toHaveLength(1);
  });
});
