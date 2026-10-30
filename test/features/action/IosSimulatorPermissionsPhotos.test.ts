import {
  FixtureTccReader,
  loadPhotosTccCase,
  photosTccCases,
  photosTccCases265,
} from "../../helpers/iosTccPhotosFixtures";
import { describe, expect, test } from "bun:test";
import {
  IosSimulatorPermissions,
  classifyIosSimulatorPermission,
  type PhotosAuthorizationVerifier,
  type TccPermissionReader,
} from "../../../src/features/action/IosSimulatorPermissions";
import type { TccPermissionRow } from "../../../src/utils/ios-cmdline-tools/SimulatorTccSqliteClient";
import { isDeviceReadinessLocked } from "../../../src/utils/deviceReadinessLock";
import type { BootedDevice } from "../../../src/models";
import { FakeSimctl } from "../../fakes/FakeSimctl";
import { FakePhotosAuthorizationVerifier } from "../../fakes/FakePhotosAuthorizationVerifier";
import { parseIosMajorVersion } from "../../../src/utils/ios-cmdline-tools/iosVersion";

const device: BootedDevice = {
  name: "iPhone 17",
  platform: "ios",
  deviceId: "12345678-1234-1234-1234-123456789ABC",
};
const appId = "com.example.app";
const device27: BootedDevice = { ...device, iosVersion: "27.0" };
const photosRow = (await loadPhotosTccCase("full")).rows[0];
const addOnlyRow = (await loadPhotosTccCase("addonly")).rows[0];
const revokedRows = (await loadPhotosTccCase("revoked")).rows;

class FakeTccReader implements TccPermissionReader {
  calls: Array<{ deviceId: string; appId: string; permissions?: string[] }> = [];
  commandCounts: number[] = [];
  constructor(
    private readonly rows: TccPermissionRow[],
    private readonly simctl: FakeSimctl,
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

function fixture(
  rows = [photosRow],
  error?: Error,
  expectLock = false,
  verifier?: PhotosAuthorizationVerifier,
) {
  const simctl = new FakeSimctl();
  const reader = new FakeTccReader(rows, simctl, error, expectLock);
  return {
    simctl,
    reader,
    permissions: new IosSimulatorPermissions(device, {
      simctl,
      tccReader: reader,
      photosVerifier: verifier,
    }),
  };
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
  expect(result.results[0]).toMatchObject({
    success: true,
    applied: true,
    verified: false,
    code: "PHOTOS_FULL_ACCESS_UNVERIFIED",
    accessLevel: "readWrite",
  });
  expect(result).not.toHaveProperty("error");
  expect(result.results[0]).not.toHaveProperty("error");
  if (typeof result.results[0].warning !== "string") {
    throw new Error("Expected warning");
  }
  expect(result.warnings).toEqual([result.results[0].warning]);
  expect(result.results[0].warning).toContain("dispatched via simctl");
  expect(result.results[0].warning).toContain(
    "effective full read/write Photos access could not be verified",
  );
  expect(result.results[0].warning).toContain("add-only is insufficient");
  expect(result.results[0].warning).toContain("verify by launching the app and checking");
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
      ...(error ? {} : { evidence: "storedTccGrant" }),
    });
    if (error) {
      expect(result.results[0]).not.toHaveProperty("evidence");
    }
    expect(simctl.getMethodCalls("executeCommandArgs")).toEqual([
      { args: command("grant", permission), timeoutMs: undefined },
    ]);
    expect(reader.calls).toEqual([
      {
        deviceId: device.deviceId,
        appId,
        permissions: ["photos"],
      },
    ]);
    expect(reader.commandCounts).toEqual([1]);
  });

  test.each([
    { name: "fresh", rows: [] },
    { name: "add-only", rows: [addOnlyRow] },
    { name: "denied", rows: [{ ...photosRow, auth_value: 0 }] },
    { name: "limited", rows: [{ ...photosRow, auth_value: 3 }] },
  ])(
    "$name stored state cannot establish full access and leaves add-only dispatch unchanged",
    async ({ rows }) => {
      const { permissions } = fixture([...rows]);
      const result = await permissions.setPermissions("grant", appId, ["photos"]);
      expectUnverified(result);
      expect(result.results[0]).not.toHaveProperty("evidence");
      const addResult = await permissions.setPermissions("grant", appId, ["photos-add"]);
      expect(addResult).toMatchObject({ success: true, changedCount: 1, failedCount: 0 });
      expect(addResult.results[0]).toMatchObject({ success: true, accessLevel: "addOnly" });
      expect(addResult.results[0]).not.toHaveProperty("verified");
    },
  );

  test.each(["photos", "kTCCServicePhotos", "all"])(
    "authorized native read/write status verifies %s after locked readback",
    async (permission) => {
      const verifier = new FakePhotosAuthorizationVerifier("authorized");
      const { permissions, reader } = fixture([photosRow], undefined, true, verifier);
      const result = await permissions.setPermissions("grant", appId, [permission]);
      expect(result).toMatchObject({ success: true, changedCount: 1, failedCount: 0 });
      expect(result.results[0]).toMatchObject({
        permission,
        success: true,
        applied: true,
        verified: true,
        accessLevel: "readWrite",
        evidence: "storedTccGrant",
      });
      expect(result).not.toHaveProperty("error");
      expect(result).not.toHaveProperty("warnings");
      expect(result.results[0]).not.toHaveProperty("error");
      expect(result.results[0]).not.toHaveProperty("code");
      expect(result.results[0]).not.toHaveProperty("warning");
      expect(reader.commandCounts).toEqual([1]);
      expect(reader.calls).toEqual([{ deviceId: device.deviceId, appId, permissions: ["photos"] }]);
      expect(verifier.calls).toEqual([{ deviceId: device.deviceId, appId }]);
    },
  );

  test("a TCC readback exception does not hide an authorized native status", async () => {
    const verifier = new FakePhotosAuthorizationVerifier("authorized");
    const { permissions } = fixture([photosRow], new Error("TCC unavailable"), true, verifier);
    const result = await permissions.setPermissions("grant", appId, ["photos"]);
    expect(result).toMatchObject({ success: true, failedCount: 0 });
    expect(result.results[0]).toMatchObject({ applied: true, verified: true });
    expect(result.results[0]).not.toHaveProperty("evidence");
    expect(verifier.calls).toHaveLength(1);
  });

  test("a TCC readback exception with an unobservable verifier stays non-fatal unverified", async () => {
    const { permissions } = fixture([photosRow], new Error("TCC unavailable"), true);
    expectUnverified(await permissions.setPermissions("grant", appId, ["photos"]));
  });

  test.each(
    (["limited", "denied", "notDetermined", "addOnly"] as const).flatMap((status) =>
      ["photos", "kTCCServicePhotos", "all"].map((permission) => ({ status, permission })),
    ),
  )(
    "native read/write status $status does not establish full access for $permission",
    async ({ status, permission }) => {
      const verifier = new FakePhotosAuthorizationVerifier(status);
      const { permissions } = fixture([photosRow], undefined, true, verifier);
      const result = await permissions.setPermissions("grant", appId, [permission]);
      expect(result).toMatchObject({
        success: false,
        changedCount: permission === "all" ? 1 : 0,
        failedCount: 1,
      });
      const failedResult = result.results[permission === "all" ? 1 : 0];
      expect(failedResult).toMatchObject({
        permission: permission === "all" ? "photos" : permission,
        success: false,
        applied: true,
        verified: false,
        code: "PHOTOS_FULL_ACCESS_NOT_ESTABLISHED",
        accessLevel: "readWrite",
        evidence: "storedTccGrant",
      });
      expect(result.error).toBe(failedResult.error);
      expect(result.error).toContain(`was not established (observed ${status})`);
      expect(result.error).toContain("dispatched via simctl");
      expect(result.error).toContain("add-only is insufficient");
      expect(result.error).toContain("PHPhotoLibrary authorizationStatusForAccessLevel:ReadWrite");
      expect(result).not.toHaveProperty("warnings");
      expect(failedResult).not.toHaveProperty("warning");
      if (permission === "all") {
        expect(result.results[0]).toMatchObject({
          permission: "all",
          success: true,
          applied: true,
        });
        expect(result.results[0]).not.toHaveProperty("error");
        expect(result.results[0]).not.toHaveProperty("code");
        expect(result.results[0]).not.toHaveProperty("verified");
      }
      expect(verifier.calls).toEqual([{ deviceId: device.deviceId, appId }]);
    },
  );

  test.each([undefined, new Error("probe unavailable")])(
    "unobservable or throwing verifier leaves full access unverified: %j",
    async (error) => {
      const verifier = new FakePhotosAuthorizationVerifier("unobservable", error);
      const { permissions } = fixture([photosRow], undefined, true, verifier);
      const result = await permissions.setPermissions("grant", appId, ["photos"]);
      expectUnverified(result);
      expect(result.results[0].evidence).toBe("storedTccGrant");
      expect(verifier.calls).toEqual([{ deviceId: device.deviceId, appId }]);
    },
  );

  test.each(["photos", "all"])(
    "%s dispatch failure skips verification and remains a failure",
    async (permission) => {
      const verifier = new FakePhotosAuthorizationVerifier("authorized");
      const { permissions, simctl, reader } = fixture([photosRow], undefined, true, verifier);
      simctl.setCommandArgsError(command("grant", permission), new Error("dispatch failed"));
      const result = await permissions.setPermissions("grant", appId, [permission]);
      expect(result).toMatchObject({
        success: false,
        changedCount: 0,
        failedCount: 1,
        error: "dispatch failed",
      });
      expect(result.results[0]).toEqual({
        permission,
        success: false,
        error: "dispatch failed",
      });
      expect(result).not.toHaveProperty("warnings");
      expect(reader.calls).toEqual([]);
      expect(verifier.calls).toEqual([]);
    },
  );

  test("an unverified Photos warning survives a different permission's dispatch failure", async () => {
    const { permissions, simctl } = fixture();
    simctl.setCommandArgsError(command("grant", "camera"), new Error("camera failed"));
    const result = await permissions.setPermissions("grant", appId, ["photos", "camera"]);
    expect(result).toMatchObject({
      success: false,
      changedCount: 1,
      failedCount: 1,
      error: "camera failed",
    });
    expect(result.results[0]).toMatchObject({
      success: true,
      code: "PHOTOS_FULL_ACCESS_UNVERIFIED",
    });
    if (typeof result.results[0].warning !== "string") {
      throw new Error("Expected warning");
    }
    expect(result.warnings).toEqual([result.results[0].warning]);
  });

  test.each([
    { action: "grant" as const, permission: "photos-add" },
    { action: "grant" as const, permission: "camera" },
    { action: "revoke" as const, permission: "photos" },
    { action: "reset" as const, permission: "photos" },
    { action: "revoke" as const, permission: "all" },
    { action: "reset" as const, permission: "all" },
  ])(
    "$action $permission skips readback and native verification",
    async ({ action, permission }) => {
      const verifier = new FakePhotosAuthorizationVerifier("authorized");
      const { permissions, simctl, reader } = fixture([photosRow], undefined, false, verifier);
      const result = await permissions.setPermissions(action, appId, [permission]);
      expect(result).toMatchObject({ success: true, changedCount: 1, failedCount: 0 });
      expect(result.results[0]).not.toHaveProperty("applied");
      expect(result.results[0]).not.toHaveProperty("verified");
      if (permission === "photos-add") {
        expect(result.results[0].accessLevel).toBe("addOnly");
      }
      expect(reader.calls).toEqual([]);
      expect(verifier.calls).toEqual([]);
      expect(simctl.getMethodCalls("executeCommandArgs")).toEqual([
        { args: command(action, permission), timeoutMs: undefined },
      ]);
    },
  );

  test.each(["unobservable", "limited"] as const)(
    "photos-add then all grants preserve dispatch and readback ordering: %s",
    async (status) => {
      const verifier = new FakePhotosAuthorizationVerifier(status);
      const { permissions, simctl, reader } = fixture([photosRow], undefined, true, verifier);
      const result = await permissions.setPermissions("grant", appId, ["photos-add", "all"]);
      expect(result).toMatchObject({
        success: status === "unobservable",
        changedCount: 2,
        failedCount: status === "unobservable" ? 0 : 1,
      });
      expect(result.results).toMatchObject([
        { permission: "photos-add", success: true, accessLevel: "addOnly" },
        { permission: "all", success: true, applied: true },
        ...(status === "unobservable"
          ? []
          : [
              {
                permission: "photos",
                success: false,
                applied: true,
                verified: false,
                code: "PHOTOS_FULL_ACCESS_NOT_ESTABLISHED",
                accessLevel: "readWrite",
              },
            ]),
      ]);
      if (status === "unobservable") {
        expect(result.results[1]).toMatchObject({
          verified: false,
          code: "PHOTOS_FULL_ACCESS_UNVERIFIED",
          accessLevel: "readWrite",
        });
        if (typeof result.results[1].warning !== "string") {
          throw new Error("Expected warning");
        }
        expect(result.warnings).toEqual([result.results[1].warning]);
        expect(result).not.toHaveProperty("error");
      } else {
        expect(result.error).toBe(result.results[2].error);
        expect(result).not.toHaveProperty("warnings");
        expect(result.results[1]).not.toHaveProperty("code");
        expect(result.results[1]).not.toHaveProperty("error");
      }
      expect(simctl.getMethodCalls("executeCommandArgs").map((call) => call.args)).toEqual([
        command("grant", "photos-add"),
        command("grant", "all"),
      ]);
      expect(reader.calls).toEqual([{ deviceId: device.deviceId, appId, permissions: ["photos"] }]);
      expect(reader.commandCounts).toEqual([2]);
    },
  );

  test.each([{ batch: ["camera", "photos"] }, { batch: ["photos", "camera"] }])(
    "first failure supplies the batch error for %j",
    async ({ batch }) => {
      const { permissions, simctl, reader } = fixture(
        [photosRow],
        undefined,
        true,
        new FakePhotosAuthorizationVerifier("denied"),
      );
      const cameraError = "camera simctl dispatch failed";
      simctl.setCommandArgsError(command("grant", "camera"), new Error(cameraError));
      const result = await permissions.setPermissions("grant", appId, [...batch]);
      expect(result).toMatchObject({
        success: false,
        changedCount: 0,
        failedCount: 2,
      });
      expect(result.error).toBe(result.results[0].error);
      if (batch[0] === "camera") {
        expect(result.error).toBe(cameraError);
      } else {
        expect(result.error).toContain("Photos grant was dispatched via simctl");
      }
      expect(result.results.find((item) => item.permission === "camera")).toMatchObject({
        success: false,
        error: cameraError,
      });
      expect(result.results.find((item) => item.permission === "photos")).toMatchObject({
        success: false,
        applied: true,
        verified: false,
        code: "PHOTOS_FULL_ACCESS_NOT_ESTABLISHED",
        error: expect.stringContaining("Photos grant was dispatched via simctl"),
      });
      expect(result).not.toHaveProperty("warnings");
      expect(simctl.getMethodCalls("executeCommandArgs").map((call) => call.args)).toEqual(
        batch.map((permission) => command("grant", permission)),
      );
      expect(reader.calls).toEqual([{ deviceId: device.deviceId, appId, permissions: ["photos"] }]);
      expect(reader.commandCounts).toEqual([batch.indexOf("photos") + 1]);
    },
  );

  test("mixed grants preserve sequential dispatch and locked readback", async () => {
    const { permissions, simctl, reader } = fixture(
      [photosRow],
      undefined,
      true,
      new FakePhotosAuthorizationVerifier("limited"),
    );
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
    expect(result.error).toBe(result.results[1].error);
    expect(result).not.toHaveProperty("warnings");
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

  test.each([
    ["27.0", true],
    ["27.1", true],
    ["28.0", true],
    ["26.99", false],
    ["26", false],
    [undefined, false],
    ["beta", false],
  ] as const)("implied full Photos grant is gated by runtime %s", (version, inferred) => {
    const result = classifyIosSimulatorPermission(
      "kTCCServicePhotosAdd",
      { service: "kTCCServicePhotosAdd", client: appId, auth_value: 0 },
      photosRow,
      parseIosMajorVersion(version),
    );
    expect(result.state).toBe(inferred ? "granted" : "denied");
    if (inferred) {
      expect(result.evidence).toBe("impliedByFullPhotosGrant");
    } else {
      expect(result).toEqual({ state: "denied", accessLevel: "addOnly" });
    }
  });

  test.each(
    [undefined, ["photos-add"], ["photos", "photos-add"], ["kTCCServicePhotosAdd"]].map(
      (query) => ({ query }),
    ),
  )("full2 overrides stale PhotosAdd for %j", async ({ query }) => {
    const reader = new FixtureTccReader("full2");
    const permissions = new IosSimulatorPermissions(device27, {
      simctl: new FakeSimctl(),
      tccReader: reader,
    });
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

  test.each([...photosTccCases])("native probe agrees with add-only readback: %s", async (name) => {
    const reader = new FixtureTccReader(name);
    const permissions = new IosSimulatorPermissions(device27, {
      simctl: new FakeSimctl(),
      tccReader: reader,
    });
    const { probe } = await loadPhotosTccCase(name);
    const result = await permissions.getPermissions(appId, ["photos", "photos-add"]);
    const [photos, add] = result.permissions;
    const nativeStates = {
      authorized: "granted",
      denied: "denied",
      notDetermined: "unknown",
    } as const;
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

describe("iOS 26.5 Photos captures", () => {
  test.each([...photosTccCases265])("reports PhotoKit add-only probe for %s", async (name) => {
    const reader = new FixtureTccReader(name, "ios26.5");
    const permissions = new IosSimulatorPermissions(
      { ...device, iosVersion: "26.5" },
      { simctl: new FakeSimctl(), tccReader: reader },
    );
    const { probe, rows } = await loadPhotosTccCase(name, "ios26.5");
    const result = await permissions.getPermissions(appId, ["photos", "photos-add"]);
    const [photos, add] = result.permissions;
    const nativeStates = {
      authorized: "granted",
      denied: "denied",
      notDetermined: "unknown",
    } as const;
    expect(add.state).toBe(nativeStates[probe.addOnly.name]);
    expect(add).not.toHaveProperty("evidence");
    expect(add).not.toHaveProperty("verified");
    expect(add).not.toHaveProperty("reason");
    expect(photos.state).toBe(name === "revoked" ? "denied" : "unknown");
    if (rows.some((row) => row.service === "kTCCServicePhotos" && row.auth_value === 2)) {
      expect(photos).toMatchObject({
        state: "unknown",
        verified: false,
        evidence: "storedTccGrant",
      });
    }
    if (name === "full") {
      expect(add).toMatchObject({ state: "denied", authValue: 0 });
    }
    if (name === "fullclean") {
      expect(add.state).toBe("unknown");
    }
  });
});
