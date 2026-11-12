import { expect, test } from "bun:test";
import { buildLaunchAppResponse } from "../../src/server/appTools";
import {
  removeSpatialPanelPackageWindows,
  spatialPanelObservation,
} from "../helpers/xrSpatialPanelFixture";
import { getLaunchObservationPackageNames } from "../../src/features/action/launchObservationPackages";

test("launch verifies the captured SpatialPanel app despite lower-layer SystemUI windows", () => {
  const observation = spatialPanelObservation();
  const appId = observation.activeWindow!.appId;
  const windows = observation.viewHierarchy!.windows!;
  const active = windows.find((window) => window.id === 92)!;
  const panel = windows.find((window) => window.id === 93)!;
  expect(active.packageName).toBe(appId);
  expect(
    windows.some(
      (window) =>
        window.packageName === "com.android.systemui" && window.windowLayer! < panel.windowLayer!,
    ),
  ).toBe(true);
  const response = buildLaunchAppResponse(appId, {
    success: true,
    packageName: appId,
    observation,
  });
  expect(response.verified).toBe(true);
  expect(response.observedAppId).toBe(appId);
  expect(response.verifyFailureReason).toBeUndefined();
  expect(response.message).toContain("foreground verified");
});

test("launch verifies the captured XR app when no window has focus and SystemUI labels the hierarchy", () => {
  const observation = spatialPanelObservation(true);
  const appId = observation.activeWindow!.appId;
  const hierarchy = observation.viewHierarchy!;
  expect(hierarchy.packageName).toBe("com.android.systemui");
  expect(hierarchy.foregroundActivity).toBeNull();
  expect(hierarchy.windows!.some((window) => window.isActive || window.isFocused)).toBe(false);
  expect(
    hierarchy
      .windows!.filter((window) => window.packageName === appId && window.type === 1)
      .map((window) => window.id),
  ).toEqual([98, 97]);
  expect(getLaunchObservationPackageNames(observation)).toEqual([appId]);
  const response = buildLaunchAppResponse(appId, {
    success: true,
    packageName: appId,
    observation,
  });
  expect(response.verified).toBe(true);
  expect(response.observedAppId).toBe(appId);
  expect(response.verifyFailureReason).toBeUndefined();
  expect(response.message).toContain("foreground verified");
});

test("phone-style SystemUI capture without app windows still fails launch verification", () => {
  const observation = spatialPanelObservation(true);
  const appId = observation.activeWindow!.appId;
  removeSpatialPanelPackageWindows(observation, appId);
  const response = buildLaunchAppResponse(appId, {
    success: true,
    packageName: appId,
    observation,
  });
  expect(response.verified).toBe(false);
  expect(response.verifyFailureReason).toBe(
    `foreground signals disagree: activeWindow=${appId}, hierarchy=com.android.systemui`,
  );
  expect(response.message).toContain("verification failed");
});

test("phone-style SystemUI capture with background app windows keeps conflicting signals", () => {
  const observation = spatialPanelObservation(true);
  const appId = observation.activeWindow!.appId;
  removeSpatialPanelPackageWindows(observation, "com.android.systemui.xrhomeenv");
  const response = buildLaunchAppResponse(appId, {
    success: true,
    packageName: appId,
    observation,
  });
  expect(response.verified).toBe(false);
  expect(response.verifyFailureReason).toBe(
    `foreground signals disagree: activeWindow=${appId}, hierarchy=com.android.systemui`,
  );
});

test("XR SystemUI reconciliation still requires the requested app and fresh observation", () => {
  const observation = spatialPanelObservation(true);
  const appId = observation.activeWindow!.appId;
  const wrongApp = buildLaunchAppResponse("com.example.other", {
    success: true,
    packageName: "com.example.other",
    observation,
  });
  expect(wrongApp.verified).toBe(false);
  expect(wrongApp.verifyFailureReason).toBe(
    `foreground package ${appId} does not match requested com.example.other`,
  );
  observation.freshness = { isFresh: false, verified: false };
  const stale = buildLaunchAppResponse(appId, { success: true, packageName: appId, observation });
  expect(stale.verified).toBeUndefined();
  expect(stale.verifyFailureReason).toBeUndefined();
});

test("launch verifies the capture containing only the unfocused app panel without its host", () => {
  const observation = spatialPanelObservation("host-missing");
  const appId = observation.activeWindow!.appId;
  const hierarchy = observation.viewHierarchy!;
  expect(hierarchy.packageName).toBe("com.android.systemui");
  const appWindows = hierarchy.windows!.filter(
    (window) => window.type === 1 && window.packageName === appId,
  );
  expect(appWindows).toMatchObject([
    { id: 105, bounds: [0, 0, 2768, 2400], isActive: false, isFocused: false, windowLayer: 3 },
  ]);
  expect(appWindows).toHaveLength(1);
  expect(getLaunchObservationPackageNames(observation)).toEqual([appId]);
  const response = buildLaunchAppResponse(appId, {
    success: true,
    packageName: appId,
    observation,
  });
  expect(response.verified).toBe(true);
  expect(response.observedAppId).toBe(appId);
  expect(response.verifyFailureReason).toBeUndefined();
  expect(response.message).toContain("foreground verified");
});
