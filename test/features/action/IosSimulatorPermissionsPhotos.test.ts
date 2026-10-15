import {
  FixtureTccReader,
  loadPhotosTccCase,
  photosTccCases,
} from "../../helpers/iosTccPhotosFixtures";
import { describe, expect, test } from "bun:test";
import {
  IosSimulatorPermissions,
  classifyIosSimulatorPermission,
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
const photosRow = (await loadPhotosTccCase("full")).rows[0];
const addOnlyRow = (await loadPhotosTccCase("addonly")).rows[0];
const revokedRows = (await loadPhotosTccCase("revoked")).rows;

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
  expect(result).toMatchObject({ success: true, changedCount: 1, failedCount: 0 });
  expect(result).not.toHaveProperty("error");
  expect(result.results[0]).toMatchObject({ success: true, applied: true, verified: false });
  expect(result.results[0]).not.toHaveProperty("error");
  expect(result.warnings).toEqual([result.results[0].warning]);
  expect(result.results[0].warning).toContain("dispatched via simctl");
  expect(result.results[0].warning).toContain("add-only is insufficient");
  expect(result.results[0].warning).toContain(
    "PHPhotoLibrary authorizationStatusForAccessLevel:ReadWrite",
  );
}

describe("iOS simulator Photos permission honesty", () => {
  test.each([photosRow])("stored Photos grant is unknown: %j", async (row) => {
    const { permissions, simctl } = fixture([row]);
    const result = await permissions.getPermissions(appId, ["photos"]);
    expect(result.success).toBe(true);
    expect(result.permissions[0]).toMatchObject({
      state: "unknown",
      verified: false,
      accessLevel: "readWrite",
      evidence: "storedTccGrant",
      authValue: row.auth_value ?? row.allowed,
    });
    expect(result.permissions[0]).toHaveProperty(
      "reason",
      expect.stringContaining("native PHPhotoLibrary"),
    );
    expect(simctl.getMethodCalls("executeCommandArgs")).toEqual([]);
  });

  test("Photos preserves captured denial", async () => {
    const { permissions } = fixture(revokedRows);
    const result = await permissions.getPermissions(appId, ["photos"]);
    expect(result.permissions[0]).toMatchObject({ state: "denied", accessLevel: "readWrite" });
    expect(result.permissions[0]).not.toHaveProperty("evidence");
  });

  test.each([
    { auth_value: 3, state: "limited" },
    { auth_value: null, allowed: 1, state: "unknown" },
  ])("classifier handles schema values without a native capture: %j", ({ state, ...fields }) => {
    expect(
      classifyIosSimulatorPermission("kTCCServicePhotos", {
        service: "kTCCServicePhotos",
        client: appId,
        ...fields,
      }).state,
    ).toBe(state);
  });

  test("photos-add stays granted and identifies add-only access", async () => {
    const { permissions } = fixture([addOnlyRow]);
    const result = await permissions.getPermissions(appId);
    expect(result.permissions[0].state).toBe("granted");
    expect(result.permissions[0].accessLevel).toBe("addOnly");
    expect(result.permissions[0]).not.toHaveProperty("evidence");
    expect(result.permissions[0]).not.toHaveProperty("verified");
    expect(result.permissions[0]).not.toHaveProperty("reason");
  });

  test("camera has no Photos access metadata", async () => {
    const { permissions } = fixture([{ ...photosRow, service: "kTCCServiceCamera" }]);
    const result = await permissions.getPermissions(appId);
    expect(result.permissions[0]).not.toHaveProperty("accessLevel");
    expect(result.permissions[0]).not.toHaveProperty("evidence");
  });

  test.each([
    { permission: "photos", error: undefined },
    { permission: "photos", error: new Error("TCC unavailable") },
    { permission: "kTCCServicePhotos", error: undefined },
    { permission: "kTCCServicePhotos", error: new Error("TCC unavailable") },
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
    expect(reader.calls).toEqual([
      {
        deviceId: device.deviceId,
        appId,
        permissions: [permission === "all" ? "photos" : permission],
      },
    ]);
    expect(reader.commandCounts).toEqual([1]);
  });

  test.each([[], [{ ...photosRow, auth_value: 0 }], [{ ...photosRow, auth_value: 3 }]])(
    "unconfirmed Photos readback remains a successful dispatch: %j",
    async (...rows) => {
      const { permissions } = fixture(rows);
      expectUnverified(await permissions.setPermissions("grant", appId, ["photos"]));
    },
  );

  test("Photos dispatch failure skips verification and remains a failure", async () => {
    const { permissions, simctl, reader } = fixture();
    simctl.setCommandArgsError(command("grant", "photos"), new Error("dispatch failed"));
    const result = await permissions.setPermissions("grant", appId, ["photos"]);
    expect(result).toMatchObject({
      success: false,
      changedCount: 0,
      failedCount: 1,
      error: "dispatch failed",
    });
    expect(result.results[0]).toEqual({
      permission: "photos",
      success: false,
      error: "dispatch failed",
    });
    expect(result).not.toHaveProperty("warnings");
    expect(reader.calls).toEqual([]);
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
    expect(result).toMatchObject({ success: true, changedCount: 2, failedCount: 0 });
    expect(result.results).toMatchObject([
      { permission: "photos-add", success: true },
      { permission: "all", success: true, applied: true, verified: false },
    ]);
    expect(result).not.toHaveProperty("error");
    expect(result.results[1]).not.toHaveProperty("error");
    expect(result.warnings).toEqual([result.results[1].warning]);
    expect(result.results[1].warning).toContain("Photos grant was dispatched via simctl");
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
      changedCount: 1,
      failedCount: 1,
      error: cameraError,
    });
    expect(result.results.find((item) => item.permission === "camera")).toMatchObject({
      success: false,
      error: cameraError,
    });
    expect(result.results.find((item) => item.permission === "photos")).toMatchObject({
      success: true,
      applied: true,
      verified: false,
      warning: expect.stringContaining("Photos grant was dispatched via simctl"),
    });
    const photosResult = result.results.find((item) => item.permission === "photos");
    expect(photosResult).not.toHaveProperty("error");
    expect(result.warnings).toEqual([photosResult?.warning]);
    expect(simctl.getMethodCalls("executeCommandArgs").map((call) => call.args)).toEqual(
      batch.map((permission) => command("grant", permission)),
    );
    expect(reader.calls).toEqual([{ deviceId: device.deviceId, appId, permissions: ["photos"] }]);
    expect(reader.commandCounts).toEqual([batch.indexOf("photos") + 1]);
  });

  test("mixed grants preserve sequential dispatch and locked readback", async () => {
    const { permissions, simctl, reader } = fixture([photosRow], undefined, true);
    const result = await permissions.setPermissions("grant", appId, ["camera", "photos", "camera"]);
    expect(result).toMatchObject({ success: true, changedCount: 3, failedCount: 0 });
    expect(result.results).toMatchObject([
      { permission: "camera", success: true },
      { permission: "photos", success: true, applied: true, verified: false },
      { permission: "camera", success: true },
    ]);
    expect(simctl.getMethodCalls("executeCommandArgs").map((call) => call.args)).toEqual([
      command("grant", "camera"),
      command("grant", "photos"),
      command("grant", "camera"),
    ]);
    expect(reader.commandCounts).toEqual([2]);
    expect(result).not.toHaveProperty("error");
    expect(result.results[1]).not.toHaveProperty("error");
    expect(result.warnings).toEqual([result.results[1].warning]);
    expect(result.results[1].warning).toContain("Photos grant was dispatched via simctl");
  });
});

describe("captured Photos readback", () => {
  test("a captured add-only grant stays unchanged beside a full grant", () => {
    expect(classifyIosSimulatorPermission("kTCCServicePhotosAdd", addOnlyRow, photosRow)).toEqual({
      state: "granted",
      accessLevel: "addOnly",
    });
  });

  test.each([undefined, ...revokedRows.filter((row) => row.service === "kTCCServicePhotos")])(
    "missing or denied Photos cannot imply an add-only grant: %j",
    (row) => {
      expect(classifyIosSimulatorPermission("kTCCServicePhotosAdd", undefined, row)).toEqual({
        state: "unknown",
        accessLevel: "addOnly",
      });
    },
  );

  // No limited capture exists; exercise only the pure classifier's value semantics.
  test.each([1, 3])("non-full Photos auth_value %i cannot imply add-only", (auth_value) => {
    expect(
      classifyIosSimulatorPermission("kTCCServicePhotosAdd", undefined, {
        service: "kTCCServicePhotos",
        client: appId,
        auth_value,
      }),
    ).toEqual({ state: "unknown", accessLevel: "addOnly" });
  });

  test.each(
    [undefined, ["photos-add"], ["photos", "photos-add"], ["kTCCServicePhotosAdd"]].map(
      (query) => ({ query }),
    ),
  )("full2 overrides stale PhotosAdd for %j", async ({ query }) => {
    const reader = new FixtureTccReader("full2");
    const permissions = new IosSimulatorPermissions(device, new FakeSimCtlClient(), reader);
    const result = await permissions.getPermissions(appId, query);
    const stored = (await loadPhotosTccCase("full2")).rows.find(
      (row) => row.service === "kTCCServicePhotosAdd",
    );
    expect(result.success).toBe(true);
    const reason = result.permissions.find((row) => row.permission === "photos-add")?.reason;
    expect(reason).toContain("stale");
    expect(result.permissions.find((row) => row.permission === "photos-add")).toMatchObject({
      state: "granted",
      verified: false,
      accessLevel: "addOnly",
      evidence: "impliedByFullPhotosGrant",
      reason: expect.stringContaining("implied by the full kTCCServicePhotos grant"),
      authValue: 0,
      raw: stored,
    });
    if (query) {
      expect(result.permissions.map((row) => row.service)).toEqual(
        query.map((permission) =>
          permission === "photos" ? "kTCCServicePhotos" : "kTCCServicePhotosAdd",
        ),
      );
      expect(reader.calls[0].permissions).toEqual(
        query.length === 1 ? [...query, "photos"] : query,
      );
    }
  });

  test.each(photosTccCases)("native probe agrees with add-only readback: %s", async (name) => {
    const reader = new FixtureTccReader(name);
    const permissions = new IosSimulatorPermissions(device, new FakeSimCtlClient(), reader);
    const { probe } = await loadPhotosTccCase(name);
    const result = await permissions.getPermissions(appId, ["photos", "photos-add"]);
    const [photos, add] = result.permissions;
    const nativeStates = { authorized: "granted", denied: "denied", notDetermined: "unknown" };
    expect(add.state).toBe(nativeStates[probe.addOnly.name]);
    expect(photos.state).toBe(name === "revoked" ? "denied" : "unknown");
    if (name === "full" || name === "full2") {
      expect(add.evidence).toBe("impliedByFullPhotosGrant");
      expect(photos).toMatchObject({ evidence: "storedTccGrant", verified: false });
      expect(probe.readWrite.name).toBe("authorized");
    } else {
      expect(add).not.toHaveProperty("evidence");
      expect(photos).not.toHaveProperty("evidence");
    }
  });
});
