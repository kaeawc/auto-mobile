import { describe, expect, test } from "bun:test";
import {
  iosDisplayPointSize,
  isFloatingIosWindow,
  restoreTargetIosOrientation,
  verifyIosRotation,
} from "../../../src/features/action/iosRotateVerification";
import { resolveIosObserveRotation } from "../../../src/features/observe/iosObserveRotation";
import type { ObserveResult, RotateResult } from "../../../src/models";

// Captured on an iPad Pro 13-inch (M5) simulator, iOS 26.5, Files floating in Windowed Apps
// (#18829): the window stays 997x782 points across the rotation, the full screenshot raster is
// 2064x2752 and the screen behind is 1376x1032 points in landscape, so the native scale is 2.
const FLOATING_WINDOW = { width: 997, height: 782 };
const RASTER = { width: 2064, height: 2752 };
const NATIVE_SCALE = RASTER.width / 1032;
const IPAD_LANDSCAPE_POINTS = { width: 1376, height: 1032 };

// `runnerRotation` is the runner's raw hierarchy rotation; the observation's own rotation goes
// through the same normalization as IosObservationCollector, which synthesizes an axis from the
// window's shape when the runner reports none.
const ipadObservation = (
  runnerRotation: number | undefined,
  screenSize: { width: number; height: number },
  overrides: Partial<ObserveResult> = {},
): ObserveResult => ({
  updatedAt: 1000,
  observationId: "ipad-observation",
  display: { key: "default", role: "unknown", posture: "unknown", generation: 0 },
  rotation: resolveIosObserveRotation(runnerRotation, screenSize),
  screenSize,
  screenshotImageSize: RASTER,
  viewHierarchy: { hierarchy: {}, nativeScale: NATIVE_SCALE, rotation: runnerRotation },
  systemInsets: { top: 0, bottom: 0, left: 0, right: 0 },
  ...overrides,
});

const runnerRotation = (observation: ObserveResult, success = true): RotateResult => ({
  success,
  orientation: "landscape",
  value: 1,
  currentOrientation: "landscape",
  previousOrientation: "portrait",
  rotationPerformed: true,
  observation,
  ...(success ? {} : { error: "Failed to rotate iOS device" }),
});

const UNCHANGED_SIZE_ERROR =
  "The foreground app or screen does not rotate on this display (the screen size did not change). The runner reported a rotation but the screen size is unchanged.";

describe("iPad floating window rotate verification (#18829)", () => {
  test("derives the display in points from the raster and native scale", () => {
    expect(iosDisplayPointSize(ipadObservation(1, FLOATING_WINDOW))).toEqual({
      width: 1032,
      height: 1376,
    });
    expect(
      iosDisplayPointSize(ipadObservation(1, FLOATING_WINDOW, { viewHierarchy: undefined })),
    ).toBeUndefined();
  });

  test("a window smaller than the display floats; a screen-sized one does not", () => {
    expect(isFloatingIosWindow(ipadObservation(0, FLOATING_WINDOW))).toBe(true);
    expect(isFloatingIosWindow(ipadObservation(1, IPAD_LANDSCAPE_POINTS))).toBe(false);
    expect(isFloatingIosWindow(ipadObservation(0, { width: 1032, height: 1376 }))).toBe(false);
    expect(
      isFloatingIosWindow(ipadObservation(0, FLOATING_WINDOW, { screenshotImageSize: undefined })),
    ).toBe(false);
  });

  test("confirms the captured rotation from the observed rotation although the size is unchanged", () => {
    const previous = ipadObservation(0, FLOATING_WINDOW);
    const after = ipadObservation(1, FLOATING_WINDOW);
    const result = verifyIosRotation(runnerRotation(after), "landscape", previous);
    expect(result).toMatchObject({
      success: true,
      rotationPerformed: true,
      previousOrientation: "portrait",
      currentOrientation: "landscape",
      message: "Successfully rotated from portrait to landscape",
    });
    expect(result.error).toBeUndefined();
    expect(result.observation?.rotation).toBe(1);
  });

  test("a runner failure the observed rotation contradicts still counts for a floating window", () => {
    const previous = ipadObservation(0, FLOATING_WINDOW);
    const after = ipadObservation(1, FLOATING_WINDOW);
    const result = verifyIosRotation(runnerRotation(after, false), "landscape", previous);
    expect(result).toMatchObject({ success: true, rotationPerformed: true });
    expect(result.warning).toContain("changed from portrait to landscape");
  });

  test("keeps the size refusal when the runner reports no rotation after the rotate", () => {
    const previous = ipadObservation(0, FLOATING_WINDOW);
    const unknownAfter = ipadObservation(undefined, FLOATING_WINDOW);
    // The normalized observation reads the 997x782 window's shape as landscape; that is no evidence.
    expect(unknownAfter.rotation).toBe(1);
    const result = verifyIosRotation(runnerRotation(unknownAfter), "landscape", previous);
    expect(result).toMatchObject({ success: false, rotationPerformed: false });
    expect(result.error).toBe(UNCHANGED_SIZE_ERROR);
  });

  test("keeps the size refusal for a screen-sized app whose size did not change", () => {
    const fullScreen = { width: 1032, height: 1376 };
    const result = verifyIosRotation(
      runnerRotation(ipadObservation(1, fullScreen)),
      "landscape",
      ipadObservation(0, fullScreen),
    );
    // Normalization reconciles landscape on a portrait-shaped root to 0, so this is refused as a
    // mismatch before the size check; either way a screen-sized app gets no floating bypass.
    expect(result).toMatchObject({ success: false, rotationPerformed: false });
    expect(result.currentOrientation).toBe("portrait");
  });

  test("never treats a Duo panel as floating, so its refusals stay size-based", () => {
    for (const role of ["cover", "inner"] as const) {
      const display = { key: "panel", role, posture: "unknown" as const, generation: 0 };
      const previous = ipadObservation(0, FLOATING_WINDOW, { display });
      expect(isFloatingIosWindow(previous)).toBe(false);
      const result = verifyIosRotation(
        runnerRotation(ipadObservation(1, FLOATING_WINDOW, { display })),
        "landscape",
        previous,
      );
      expect(result.success).toBe(false);
    }
  });

  test("restores a floating window from its observed rotation, not its shape", () => {
    expect(restoreTargetIosOrientation(ipadObservation(0, FLOATING_WINDOW))).toBe("portrait");
    expect(restoreTargetIosOrientation(ipadObservation(undefined, FLOATING_WINDOW))).toBe(
      "unknown",
    );
  });
});
