import { describe, expect, test } from "bun:test";
import type { ObserveResult } from "../../../src/models";
import {
  getLaunchObservationPackageNames,
  isLaunchPermissionDialogObservation,
} from "../../../src/features/action/launchObservationPackages";

describe("getLaunchObservationPackageNames", () => {
  test("collects unique primary packages and ignores the fallback when they exist", () => {
    const observation = {
      activeWindow: { appId: "com.expected" },
      viewHierarchy: {
        packageName: "com.other",
        foregroundActivity: "com.stale/.MainActivity",
      },
    } as ObserveResult;

    expect(getLaunchObservationPackageNames(observation)).toEqual(["com.expected", "com.other"]);
  });

  test("uses the foreground activity package only when primary signals are absent", () => {
    const observation = {
      activeWindow: { appId: "" },
      viewHierarchy: { packageName: "", foregroundActivity: "com.fallback/.MainActivity" },
    } as ObserveResult;

    expect(getLaunchObservationPackageNames(observation)).toEqual(["com.fallback"]);
  });
});

describe("isLaunchPermissionDialogObservation", () => {
  test("accepts only the detected notification permission dialog surface", () => {
    expect(
      isLaunchPermissionDialogObservation({
        notificationPermissionDetected: true,
        activeWindow: { type: "notification_permission_dialog" },
      } as ObserveResult),
    ).toBe(true);
    expect(
      isLaunchPermissionDialogObservation({
        notificationPermissionDetected: false,
        activeWindow: { type: "notification_permission_dialog" },
      } as ObserveResult),
    ).toBe(false);
  });
});
