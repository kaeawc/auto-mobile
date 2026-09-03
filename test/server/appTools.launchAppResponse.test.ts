import { describe, expect, test } from "bun:test";
import { buildLaunchAppResponse } from "../../src/server/appTools";
import { ActionableError, type LaunchAppResult, type ObserveResult } from "../../src/models";

const observationForApp = (appId: string | undefined): ObserveResult =>
  ({
    activeWindow: appId ? { appId, activityName: "MainActivity", layoutSeqSum: 1 } : undefined,
  }) as ObserveResult;

describe("buildLaunchAppResponse", () => {
  // AC1: launchApp must return a real error when the package is not installed,
  // instead of a flat "Launched app X" success string (#5868).
  test("throws the underlying error when the app is not installed", () => {
    const result: LaunchAppResult = {
      success: false,
      packageName: "com.android.contacts",
      error: "App is not installed",
    };

    expect(() => buildLaunchAppResponse("com.android.contacts", result)).toThrow(ActionableError);
    expect(() => buildLaunchAppResponse("com.android.contacts", result)).toThrow(
      "App is not installed",
    );
  });

  // AC2: when the launch observation reports a different foreground app, execute()
  // returns success:false with a descriptive error; the handler must surface it.
  test("throws the foreground-mismatch error rather than reporting success", () => {
    const result: LaunchAppResult = {
      success: false,
      packageName: "com.android.settings",
      error:
        "Timed out waiting for launch observation to show com.android.settings; last observation reported com.google.android.calendar",
    };

    expect(() => buildLaunchAppResponse("com.android.settings", result)).toThrow(
      "com.google.android.calendar",
    );
  });

  test("falls back to a generic error message when success is false without an error", () => {
    const result: LaunchAppResult = {
      success: false,
      packageName: "com.example.app",
    };

    expect(() => buildLaunchAppResponse("com.example.app", result)).toThrow(
      "Failed to launch app com.example.app",
    );
  });

  // AC2: on success, surface the verified foreground appId so the client does not
  // have to burn a round-trip on observe to confirm the launch.
  test("reports verified foreground when the observation matches the requested app", () => {
    const result: LaunchAppResult = {
      success: true,
      packageName: "com.android.settings",
      observation: observationForApp("com.android.settings"),
    };

    const payload = buildLaunchAppResponse("com.android.settings", result);

    expect(payload.verified).toBe(true);
    expect(payload.observedAppId).toBe("com.android.settings");
    expect(payload.message).toBe("Launched app com.android.settings (foreground verified)");
    expect(payload.success).toBe(true);
  });

  test("omits verification when a matching observation is marked unverified", () => {
    const result: LaunchAppResult = {
      success: true,
      packageName: "com.android.settings",
      observation: {
        ...observationForApp("com.android.settings"),
        freshness: {
          isFresh: false,
          verified: false,
          warning: "Observed hierarchy contains only Android status-bar content",
        },
      },
    };

    const payload = buildLaunchAppResponse("com.android.settings", result);

    expect(payload.verified).toBeUndefined();
    expect(payload.message).toBe("Launched app com.android.settings");
  });

  // A successful launch that lands on an accepted surface (e.g. a notification
  // permission dialog, whose foreground is the permission controller) must not
  // emit a misleading verified:false — execute already returns success:false for a
  // genuine wrong-app landing. It still reports the observed appId.
  test("omits verification (never false) on a successful launch with a differing foreground", () => {
    const result: LaunchAppResult = {
      success: true,
      packageName: "com.android.settings",
      observation: observationForApp("com.google.android.permissioncontroller"),
    };

    const payload = buildLaunchAppResponse("com.android.settings", result);

    expect(payload.verified).toBeUndefined();
    expect(payload.observedAppId).toBe("com.google.android.permissioncontroller");
    expect(payload.message).toBe("Launched app com.android.settings");
  });

  // LaunchApp reconciles a launch via viewHierarchy.packageName when the active
  // window is absent; the response must report that verified app rather than
  // dropping the signal and forcing the client to re-observe.
  test("falls back to viewHierarchy.packageName when the active window is absent", () => {
    const result: LaunchAppResult = {
      success: true,
      packageName: "com.android.settings",
      observation: {
        viewHierarchy: { packageName: "com.android.settings" },
      } as ObserveResult,
    };

    const payload = buildLaunchAppResponse("com.android.settings", result);

    expect(payload.observedAppId).toBe("com.android.settings");
    expect(payload.verified).toBe(true);
    expect(payload.message).toBe("Launched app com.android.settings (foreground verified)");
  });

  test("omits verification when no observation is available", () => {
    const result: LaunchAppResult = {
      success: true,
      packageName: "com.android.settings",
    };

    const payload = buildLaunchAppResponse("com.android.settings", result);

    expect(payload.verified).toBeUndefined();
    expect(payload.observedAppId).toBeUndefined();
    expect(payload.message).toBe("Launched app com.android.settings");
  });
});
