import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import type { BootedDevice } from "../../src/models";
import { AndroidDeviceMutationResetPort } from "../../src/daemon/sessionBroker/androidDeviceMutationResetPort";
import { androidBaselineCleanCovers } from "../../src/daemon/sessionBroker/androidKeepBootedCleanup";
import { SessionMutationRecorder } from "../../src/daemon/sessionBroker/mutations/recorder";
import type { DeviceBaseline } from "../../src/daemon/sessionBroker/mutations/types";
import {
  androidPermissionMutations,
  deviceToolMutations,
} from "../../src/server/deviceMutationAdapters";
import { FamilyMutationPriorReader } from "../../src/server/deviceMutationFamilyPriorReader";
import {
  PermissionMutationPriorReader,
  readAndroidPermissionTarget,
  withoutBaselineCoveredPermissions,
} from "../../src/server/deviceMutationPermissionPriorReader";
import {
  createDefaultMutationArtifactReader,
  SessionDeviceMutationRecording,
} from "../../src/server/deviceMutationRecording";
import { createExecResult } from "../../src/utils/execResult";
import { logger } from "../../src/utils/logger";
import { FakeAdbExecutor } from "../fakes/FakeAdbExecutor";
import { FakeDeviceMutationJournal } from "../fakes/FakeDeviceMutationJournal";
import { FakeTimer } from "../fakes/FakeTimer";

const DEVICE: BootedDevice = { deviceId: "emulator-5554", platform: "android", name: "Pixel" };
const SCOPE = { sessionUuid: "session", deviceId: DEVICE.deviceId, incarnation: "native-1" };
const APP = "com.example.app";
const CAMERA = "android.permission.CAMERA";
const NOTIFY = "android.permission.POST_NOTIFICATIONS";
const TARGET = { userId: 0, notificationsAreRuntime: true };

function dump(grants: Record<string, boolean>, user = 0): string {
  return [
    "Packages:",
    `  Package [${APP}] (abc123):`,
    "    requested permissions:",
    ...Object.keys(grants).map((permission) => `      ${permission}`),
    `    User ${user}: ceDataInode=1 installed=true`,
    "      runtime permissions:",
    ...Object.entries(grants).map(
      ([permission, granted]) => `        ${permission}: granted=${granted}, flags=[ ]`,
    ),
    "",
  ].join("\n");
}

function baseline(apps: string[]): DeviceBaseline {
  return {
    completeKinds: ["installed-app"],
    observations: apps.map((app) => ({
      kind: "installed-app",
      key: `user:0:${app}`,
      value: { state: "present", value: true },
    })),
    unobservable: [],
  };
}

describe("setAppPermissions runtime permission journaling", () => {
  let warn: ReturnType<typeof spyOn>;

  beforeEach(() => {
    warn = spyOn(logger, "warn").mockImplementation(() => {});
  });

  afterEach(() => warn.mockRestore());

  test("a resolved target journals runtime keys; app-ops and reset keep escalating keys", () => {
    expect(
      androidPermissionMutations(
        {
          appId: APP,
          permissions: ["CAMERA", CAMERA, "POST_NOTIFICATIONS"],
          notificationsEnabled: true,
          notificationPolicyAccess: true,
          scheduleExactAlarm: "allow",
        },
        TARGET,
      ),
    ).toEqual([
      { kind: "permission", key: `runtime:0:${APP}:${CAMERA}` },
      { kind: "permission", key: `runtime:0:${APP}:${NOTIFY}` },
      { kind: "permission", key: `["${APP}","default","notificationPolicyAccess"]` },
      { kind: "permission", key: `["${APP}","default","scheduleExactAlarm"]` },
    ]);
    expect(
      androidPermissionMutations(
        { appId: APP, notificationsEnabled: false },
        { userId: 10, notificationsAreRuntime: false },
      ),
    ).toEqual([{ kind: "permission", key: `["${APP}","default","notificationsEnabled"]` }]);
    expect(androidPermissionMutations({ appId: "bad app", permissions: [CAMERA] }, TARGET)).toEqual(
      [{ kind: "permission", key: `["bad app","default","${CAMERA}"]` }],
    );
    expect(
      androidPermissionMutations({ appId: APP, action: "reset", permissions: ["all"] }, TARGET),
    ).toEqual([{ kind: "permission", key: "device" }]);
    // Without host resolution the adapters cannot name the user.
    expect(deviceToolMutations("setAppPermissions", { appId: APP, permissions: [CAMERA] })).toEqual(
      [{ kind: "permission", key: `["${APP}","default","${CAMERA}"]` }],
    );
  });

  test("the target is the explicit user or the sole running primary user", async () => {
    const adb = new FakeAdbExecutor();
    expect(await readAndroidPermissionTarget(adb, { userId: 10 })).toEqual({
      userId: 10,
      notificationsAreRuntime: false,
    });
    expect(await readAndroidPermissionTarget(adb, {})).toEqual({
      userId: 0,
      notificationsAreRuntime: false,
    });
    expect(await readAndroidPermissionTarget(adb, { action: "reset" })).toBeUndefined();
    expect(await readAndroidPermissionTarget(adb, { userId: -1 })).toBeUndefined();
    adb.setUsers([
      { userId: 0, name: "Owner", flags: 13, running: true },
      { userId: 10, name: "Work", flags: 0x30, running: true },
    ]);
    expect(await readAndroidPermissionTarget(adb, {})).toBeUndefined();
    adb.setUsers([{ userId: 10, name: "Guest", flags: 0x400, running: true }]);
    expect(await readAndroidPermissionTarget(adb, {})).toBeUndefined();
    expect(adb.getApiLevelCalls()).toHaveLength(0);
  });

  test.each([
    [34, true],
    [33, true],
    [32, false],
    // The tool takes the permission path on an unknown level, but the app-op path is possible.
    [null, false],
  ] as const)(
    "notificationsEnabled on API %p is a runtime permission: %p",
    async (level, runtime) => {
      const adb = new FakeAdbExecutor();
      adb.setAndroidApiLevel(level);
      expect(
        await readAndroidPermissionTarget(
          adb,
          { notificationsEnabled: true },
          undefined,
          async () => level,
        ),
      ).toEqual({ userId: 0, notificationsAreRuntime: runtime });
    },
  );

  test("priors come from the target user's runtime permissions", async () => {
    const adb = new FakeAdbExecutor();
    adb.setCommandResponse(
      `shell dumpsys package '${APP}'`,
      createExecResult(dump({ [CAMERA]: false, [NOTIFY]: true }), ""),
    );
    const reader = new PermissionMutationPriorReader(() => adb);
    expect(
      await reader.read(DEVICE, [
        { kind: "permission", key: `runtime:0:${APP}:${CAMERA}` },
        { kind: "permission", key: `runtime:0:${APP}:${NOTIFY}` },
        { kind: "permission", key: `runtime:0:${APP}:android.permission.READ_CONTACTS` },
        { kind: "permission", key: `runtime:10:${APP}:${CAMERA}` },
        { kind: "permission", key: `["${APP}","default","${CAMERA}"]` },
      ]),
    ).toEqual([
      { state: "present", value: false },
      { state: "present", value: true },
      { state: "unobservable" },
      { state: "unobservable" },
      { state: "unobservable" },
    ]);
    expect(adb.getExecutedCommands()).toEqual([`shell dumpsys package '${APP}'`]);
    expect(
      await reader.read({ ...DEVICE, platform: "ios" }, [
        { kind: "permission", key: `runtime:0:${APP}:${CAMERA}` },
      ]),
    ).toEqual([{ state: "unobservable" }]);
    expect(adb.getExecutedCommands()).toHaveLength(1);
  });

  test("an unreadable package dump leaves the prior unobservable", async () => {
    const adb = new FakeAdbExecutor();
    adb.setCommandResponse("shell dumpsys package", createExecResult("", "Error: boom"));
    const reader = new PermissionMutationPriorReader(() => adb);
    expect(
      await reader.read(DEVICE, [{ kind: "permission", key: `runtime:0:${APP}:${CAMERA}` }]),
    ).toEqual([{ state: "unobservable" }]);
  });

  test("a package the baseline never held is covered by the clean's uninstall", () => {
    const rows = [
      { kind: "permission", key: `runtime:0:${APP}:${CAMERA}` },
      { kind: "permission", key: `runtime:0:held.app:${CAMERA}` },
      { kind: "permission", key: `["${APP}","default","notificationPolicyAccess"]` },
    ];
    expect(withoutBaselineCoveredPermissions(rows, baseline(["held.app"]))).toEqual(rows.slice(1));
    expect(withoutBaselineCoveredPermissions(rows, null)).toEqual(rows);
  });

  test("a recorded grant reverts in place through the Android port", async () => {
    const adb = new FakeAdbExecutor();
    adb.setCommandResponse(
      `shell dumpsys package '${APP}'`,
      createExecResult(dump({ [CAMERA]: false }), ""),
    );
    const journal = new FakeDeviceMutationJournal(new FakeTimer());
    await journal.captureBaseline(SCOPE, baseline([APP]));
    const recorder = new SessionMutationRecorder(journal, SCOPE);
    const recording = new SessionDeviceMutationRecording(
      () => recorder,
      new FamilyMutationPriorReader([new PermissionMutationPriorReader(() => adb)]),
      createDefaultMutationArtifactReader(undefined, undefined, () => adb),
    );
    await recording.beforeToolCall(
      "setAppPermissions",
      { appId: APP, permissions: ["CAMERA"], notificationPolicyAccess: true },
      DEVICE,
      SCOPE.sessionUuid,
    );
    const rows = await journal.list(SCOPE);
    expect(rows).toMatchObject([
      {
        kind: "permission",
        key: `runtime:0:${APP}:${CAMERA}`,
        priorValue: { state: "present", value: false },
      },
      { kind: "permission", key: `["${APP}","default","notificationPolicyAccess"]` },
    ]);
    const port = new AndroidDeviceMutationResetPort(adb);
    expect(rows.map((row) => port.canRevert(row) || androidBaselineCleanCovers(row))).toEqual([
      true,
      false,
    ]);
    await port.revert(rows[0]!, {
      scope: SCOPE,
      signal: new AbortController().signal,
      assertOwned: async () => {},
    });
    expect(adb.getExecutedCommands().at(-1)).toBe(`shell pm revoke --user 0 '${APP}' '${CAMERA}'`);
  });

  test("a grant on an app the baseline never held is left to the clean", async () => {
    const adb = new FakeAdbExecutor();
    const journal = new FakeDeviceMutationJournal(new FakeTimer());
    await journal.captureBaseline(SCOPE, baseline(["held.app"]));
    const recording = new SessionDeviceMutationRecording(
      () => new SessionMutationRecorder(journal, SCOPE),
      new FamilyMutationPriorReader([new PermissionMutationPriorReader(() => adb)]),
      createDefaultMutationArtifactReader(undefined, undefined, () => adb),
    );
    await recording.beforeToolCall(
      "setAppPermissions",
      { appId: APP, permissions: [CAMERA] },
      DEVICE,
      SCOPE.sessionUuid,
    );
    expect(await journal.list(SCOPE)).toEqual([]);
    expect(adb.getExecutedCommands()).toEqual([]);
  });

  test("an unresolvable user keeps the escalating row", async () => {
    const adb = new FakeAdbExecutor();
    adb.setUsers([
      { userId: 0, name: "Owner", flags: 13, running: true },
      { userId: 11, name: "Guest", flags: 0x400, running: true },
    ]);
    const journal = new FakeDeviceMutationJournal(new FakeTimer());
    await journal.captureBaseline(SCOPE, baseline([APP]));
    const recording = new SessionDeviceMutationRecording(
      () => new SessionMutationRecorder(journal, SCOPE),
      new FamilyMutationPriorReader([new PermissionMutationPriorReader(() => adb)]),
      createDefaultMutationArtifactReader(undefined, undefined, () => adb),
    );
    await recording.beforeToolCall(
      "setAppPermissions",
      { appId: APP, permissions: [CAMERA] },
      DEVICE,
      SCOPE.sessionUuid,
    );
    expect(await journal.list(SCOPE)).toMatchObject([
      { key: `["${APP}","default","${CAMERA}"]`, priorValue: { state: "unobservable" } },
    ]);
  });
});
