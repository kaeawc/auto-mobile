import { expect, test } from "bun:test";
import { DefaultActiveWindowAttributionReconciler } from "../../../src/features/observe/ActiveWindowAttribution";
import { FakeViewHierarchy } from "../../fakes/FakeViewHierarchy";
import { createHierarchyForTest, createObserveResultForTest } from "./observeScreenTestBuilders";

test.each(["overlay", "backStack"] as const)(
  "%s recapture preserves the original observation when hierarchy capture throws",
  async (path) => {
    const viewHierarchy = new FakeViewHierarchy();
    viewHierarchy.setFailure(new Error("hierarchy unavailable"));
    let sideReads = 0;
    const reconciler = new DefaultActiveWindowAttributionReconciler({
      viewHierarchy: () => viewHierarchy,
      device: () => ({ platform: "android" }),
      platformValidator: () => ({ validate: () => ({ valid: true }) }),
      deviceStateCollector: () => ({
        collectForegroundIdentity: async () => {
          sideReads++;
          return undefined;
        },
        collectFocusedSystemUiSurface: async () => {
          sideReads++;
          return false;
        },
        collectDeviceLock: async () => {
          sideReads++;
        },
        collectBackStack: async () => {
          sideReads++;
        },
        collectActiveWindow: async () => {
          sideReads++;
        },
      }),
      resolveObservationTimestampMs: (result) => result.viewHierarchy?.updatedAt,
      extractScreenSizeFromHierarchy: () => null,
    });
    const hierarchy = createHierarchyForTest({
      hierarchy: {},
      updatedAt: 1000,
      fresh: true,
      packageName: "com.example.app",
    });
    const result = createObserveResultForTest({ viewHierarchy: hierarchy });
    result.activeWindow = { appId: "com.example.app", activityName: "", layoutSeqSum: 42 };
    result.deviceLock = { locked: false, keyguardShowing: false };
    const before = structuredClone(result);

    const recaptured =
      path === "overlay"
        ? await reconciler.recaptureHierarchyForSystemUiOverlay(result)
        : await reconciler.recaptureHierarchyForBackStackAttribution(result, {
            packageName: "com.example.app",
            activityName: "com.example.app.MainActivity",
          });

    expect(recaptured).toBe(false);
    expect(result).toEqual(before);
    expect(result.viewHierarchy).toBe(hierarchy);
    expect(sideReads).toBe(0);
  },
);
