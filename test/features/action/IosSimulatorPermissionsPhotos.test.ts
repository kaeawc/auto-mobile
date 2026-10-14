import { describe, expect, test } from "bun:test";
import {
  IosSimulatorPermissions,
  type TccPermissionReader,
} from "../../../src/features/action/IosSimulatorPermissions";
import type { TccPermissionRow } from "../../../src/utils/ios-cmdline-tools/SimulatorTccSqliteClient";
import { isDeviceReadinessLocked } from "../../../src/utils/deviceReadinessLock";
import type { BootedDevice } from "../../../src/models";
import { FakeSimCtlClient } from "../../fakes/FakeSimCtlClient";

const device: BootedDevice = {
  name: "iPhone 17",
  platform: "ios",
  deviceId: "12345678-1234-1234-1234-123456789ABC",
};
const appId = "com.example.app";
// This row mirrors issue #12316/#12317-reported values, not a real simctl/TCC capture.
// Decision logic is tested structurally with a fake TccPermissionReader and FakeSimCtlClient.
const photosRow: TccPermissionRow = {
  service: "kTCCServicePhotos",
  client: appId,
  auth_value: 2,
  allowed: null,
  prompt_count: null,
};

class FakeTccReader implements TccPermissionReader {
  calls: Array<{ deviceId: string; appId: string; permissions?: string[] }> = [];
  commandCounts: number[] = [];
  constructor(
    private readonly rows: TccPermissionRow[],
    private readonly simctl: FakeSimCtlClient,
    private readonly error?: Error,
    private readonly expectLock = false,
  ) {}
  async readPermissions(deviceId: string, appId: string, permissions?: string[]) {
    this.calls.push({ deviceId, appId, permissions });
    this.commandCounts.push(this.simctl.getMethodCalls("executeCommandArgs").length);
    if (this.expectLock) {
      expect(isDeviceReadinessLocked(`ios-privacy:${deviceId}`)).toBe(true);
    }
    if (this.error) {
      throw this.error;
    }
    return this.rows;
  }
}

function fixture(rows = [photosRow], error?: Error, expectLock = false) {
  const simctl = new FakeSimCtlClient();
  const reader = new FakeTccReader(rows, simctl, error, expectLock);
  return { simctl, reader, permissions: new IosSimulatorPermissions(device, simctl, reader) };
}
const command = (action: string, permission: string) => [
  "privacy",
  device.deviceId,
  action,
  permission,
  appId,
];

function expectUnverified(result: Awaited<ReturnType<IosSimulatorPermissions["setPermissions"]>>) {
  expect(result).toMatchObject({ success: false, changedCount: 0, failedCount: 1 });
  expect(result.error).toContain("Photos");
  expect(result.results[0]).toMatchObject({ success: false, applied: true, verified: false });
  expect(result.results[0].error).toContain("dispatched via simctl");
  expect(result.results[0].error).toContain("add-only is insufficient");
  expect(result.results[0].error).toContain(
    "PHPhotoLibrary authorizationStatusForAccessLevel:ReadWrite",
  );
}

describe("iOS simulator Photos permission honesty", () => {
  test.each([photosRow, { ...photosRow, auth_value: null, allowed: 1 }])(
    "stored Photos grant is unknown: %j",
    async (row) => {
      const { permissions, simctl } = fixture([row]);
      const result = await permissions.getPermissions(appId, ["photos"]);
      expect(result.success).toBe(true);
      expect(result.permissions[0]).toMatchObject({
        state: "unknown",
        verified: false,
        authValue: row.auth_value ?? row.allowed,
      });
      expect(result.permissions[0]).toHaveProperty(
        "reason",
        expect.stringContaining("native PHPhotoLibrary"),
      );
      expect(simctl.getMethodCalls("executeCommandArgs")).toEqual([]);
    },
  );

  test.each([
    { authValue: 0, state: "denied" },
    { authValue: 3, state: "limited" },
  ])("Photos preserves $state", async ({ authValue, state }) => {
    const { permissions } = fixture([{ ...photosRow, auth_value: authValue }]);
    const result = await permissions.getPermissions(appId, ["photos"]);
    expect(result.permissions[0].state).toBe(state);
    expect(result.permissions[0]).not.toHaveProperty("verified");
    expect(result.permissions[0]).not.toHaveProperty("reason");
  });

  test.each(["kTCCServicePhotosAdd", "kTCCServiceCamera"])(
    "%s grants remain unchanged",
    async (service) => {
      const { permissions } = fixture([{ ...photosRow, service }]);
      const result = await permissions.getPermissions(appId);
      expect(result.permissions[0].state).toBe("granted");
      expect(result.permissions[0]).not.toHaveProperty("verified");
      expect(result.permissions[0]).not.toHaveProperty("reason");
    },
  );

  test.each([
    { permission: "photos", error: undefined },
    { permission: "photos", error: new Error("TCC unavailable") },
    { permission: "all", error: undefined },
    { permission: "all", error: new Error("TCC unavailable") },
  ])("$permission grant remains unverified: $error", async ({ permission, error }) => {
    const { permissions, simctl, reader } = fixture([photosRow], error, true);
    simctl.setCommandArgsResult(command("grant", permission), "dispatched", "diagnostic");
    const result = await permissions.setPermissions("grant", appId, [permission]);
    expectUnverified(result);
    expect(result.results[0]).toMatchObject({
      permission,
      stdout: "dispatched",
      stderr: "diagnostic",
    });
    expect(simctl.getMethodCalls("executeCommandArgs")).toEqual([
      { args: command("grant", permission), timeoutMs: undefined },
    ]);
    expect(reader.calls).toEqual([{ deviceId: device.deviceId, appId, permissions: ["photos"] }]);
    expect(reader.commandCounts).toEqual([1]);
  });

  test.each([
    { action: "grant" as const, permission: "photos-add" },
    { action: "grant" as const, permission: "camera" },
    { action: "revoke" as const, permission: "photos" },
    { action: "reset" as const, permission: "photos" },
    { action: "revoke" as const, permission: "all" },
    { action: "reset" as const, permission: "all" },
  ])("$action $permission skips readback", async ({ action, permission }) => {
    const { permissions, simctl, reader } = fixture();
    const result = await permissions.setPermissions(action, appId, [permission]);
    expect(result).toMatchObject({ success: true, changedCount: 1, failedCount: 0 });
    expect(result.results[0]).not.toHaveProperty("applied");
    expect(result.results[0]).not.toHaveProperty("verified");
    expect(reader.calls).toEqual([]);
    expect(simctl.getMethodCalls("executeCommandArgs")).toEqual([
      { args: command(action, permission), timeoutMs: undefined },
    ]);
  });

  test("photos-add then all grants preserve dispatch and readback ordering", async () => {
    const { permissions, simctl, reader } = fixture([photosRow], undefined, true);
    const result = await permissions.setPermissions("grant", appId, ["photos-add", "all"]);
    expect(result).toMatchObject({ success: false, changedCount: 1, failedCount: 1 });
    expect(result.results).toMatchObject([
      { permission: "photos-add", success: true },
      { permission: "all", success: false, applied: true, verified: false },
    ]);
    expect(result.error).toBe(result.results[1].error);
    expect(simctl.getMethodCalls("executeCommandArgs").map((call) => call.args)).toEqual([
      command("grant", "photos-add"),
      command("grant", "all"),
    ]);
    expect(reader.calls).toEqual([{ deviceId: device.deviceId, appId, permissions: ["photos"] }]);
    expect(reader.commandCounts).toEqual([2]);
  });

  test.each([
    ["camera", "photos"],
    ["photos", "camera"],
  ])("real dispatch failure takes precedence for %j", async (...batch) => {
    const { permissions, simctl, reader } = fixture([photosRow], undefined, true);
    const cameraError = "camera simctl dispatch failed";
    simctl.setCommandArgsError(command("grant", "camera"), new Error(cameraError));
    const result = await permissions.setPermissions("grant", appId, batch);
    expect(result).toMatchObject({
      success: false,
      changedCount: 0,
      failedCount: 2,
      error: cameraError,
    });
    expect(result.results.find((item) => item.permission === "camera")).toMatchObject({
      success: false,
      error: cameraError,
    });
    expect(result.results.find((item) => item.permission === "photos")).toMatchObject({
      success: false,
      applied: true,
      verified: false,
      error: expect.stringContaining("Photos grant was dispatched via simctl"),
    });
    expect(simctl.getMethodCalls("executeCommandArgs").map((call) => call.args)).toEqual(
      batch.map((permission) => command("grant", permission)),
    );
    expect(reader.calls).toEqual([{ deviceId: device.deviceId, appId, permissions: ["photos"] }]);
    expect(reader.commandCounts).toEqual([batch.indexOf("photos") + 1]);
  });

  test("mixed grants preserve sequential dispatch and locked readback", async () => {
    const { permissions, simctl, reader } = fixture([photosRow], undefined, true);
    const result = await permissions.setPermissions("grant", appId, ["camera", "photos", "camera"]);
    expect(result).toMatchObject({ success: false, changedCount: 2, failedCount: 1 });
    expect(result.results).toMatchObject([
      { permission: "camera", success: true },
      { permission: "photos", success: false, applied: true, verified: false },
      { permission: "camera", success: true },
    ]);
    expect(simctl.getMethodCalls("executeCommandArgs").map((call) => call.args)).toEqual([
      command("grant", "camera"),
      command("grant", "photos"),
      command("grant", "camera"),
    ]);
    expect(reader.commandCounts).toEqual([2]);
  });
});
