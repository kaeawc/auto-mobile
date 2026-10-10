import { describe, expect, test } from "bun:test";
import type { ObserveResult } from "../../../src/models";
import { CTRL_PROXY_PACKAGE } from "../../../src/ctrlProxy/constants";
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

  test("a focused highlight window is not the prototype, so the CtrlProxy package is kept (#11346)", () => {
    const observation = {
      activeWindow: { appId: CTRL_PROXY_PACKAGE },
      viewHierarchy: {
        packageName: CTRL_PROXY_PACKAGE,
        windows: [
          { id: 1, type: 1, isFocused: false },
          { id: 2, type: 4, isFocused: true, packageName: CTRL_PROXY_PACKAGE },
        ],
      },
    } as ObserveResult;

    expect(getLaunchObservationPackageNames(observation)).toEqual([CTRL_PROXY_PACKAGE]);
  });

  describe("while CtrlProxy's own prototype holds window focus (#10000)", () => {
    const prototypeWindows = [
      { id: 1, type: 1, isFocused: false },
      { id: 2, type: 4, isFocused: true, hierarchy: { node: [{}] } },
    ];

    test("drops the prototype package in favour of the app behind it", () => {
      const observation = {
        activeWindow: { appId: "com.expected" },
        viewHierarchy: { packageName: CTRL_PROXY_PACKAGE, windows: prototypeWindows },
      } as ObserveResult;

      expect(getLaunchObservationPackageNames(observation)).toEqual(["com.expected"]);
    });

    test("names the foreground task's package when only the prototype package is reported", () => {
      const observation = {
        activeWindow: { appId: CTRL_PROXY_PACKAGE },
        viewHierarchy: { packageName: CTRL_PROXY_PACKAGE, windows: prototypeWindows },
        backStack: {
          currentTaskId: 441,
          tasks: [
            { id: 347, packageName: "com.launcher" },
            { id: 441, packageName: "com.expected" },
          ],
        },
      } as ObserveResult;

      expect(getLaunchObservationPackageNames(observation)).toEqual(["com.expected"]);
    });

    test("keeps the prototype package when no app behind it can be named", () => {
      const observation = {
        activeWindow: { appId: CTRL_PROXY_PACKAGE },
        viewHierarchy: { packageName: CTRL_PROXY_PACKAGE, windows: prototypeWindows },
      } as ObserveResult;

      expect(getLaunchObservationPackageNames(observation)).toEqual([CTRL_PROXY_PACKAGE]);
    });

    test("a CtrlProxy-labelled capture without a prototype window is still reported as CtrlProxy", () => {
      const observation = {
        activeWindow: { appId: CTRL_PROXY_PACKAGE },
        viewHierarchy: {
          packageName: CTRL_PROXY_PACKAGE,
          windows: [{ id: 1, type: 1, isFocused: true }],
        },
        backStack: { currentTaskId: 441, tasks: [{ id: 441, packageName: "com.expected" }] },
      } as ObserveResult;

      expect(getLaunchObservationPackageNames(observation)).toEqual([CTRL_PROXY_PACKAGE]);
    });
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
