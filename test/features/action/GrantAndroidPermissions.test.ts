import { readFileSync } from "node:fs";
import { describe, expect, test } from "bun:test";
import { ActionableError, BootedDevice } from "../../../src/models";
import { GrantAndroidPermissions } from "../../../src/features/action/GrantAndroidPermissions";
import { NoOpPerformanceTracker } from "../../../src/utils/PerformanceTracker";
import { FakeAdbClientFactory } from "../../fakes/FakeAdbClientFactory";
import { FakeAdbExecutor } from "../../fakes/FakeAdbExecutor";
import { FakeRecordingPerformanceTracker } from "../../fakes/FakeRecordingPerformanceTracker";

const androidDevice: BootedDevice = {
  name: "emu",
  platform: "android",
  deviceId: "emulator-5554",
};

const egg = readFileSync(
  new URL(
    "../../fixtures/android-dumpsys-package/dumpsys-package-system-installed.txt",
    import.meta.url,
  ),
  "utf8",
);
function snapshots(action: "grant" | "revoke", userId: number) {
  // Keep the captured structure; derive the package/user and the single grant token.
  const capture = egg
    .replaceAll("com.android.egg", "com.example.app")
    .replaceAll("User 0:", `User ${userId}:`);
  const before = capture.replace(
    "android.permission.READ_EXTERNAL_STORAGE: granted=false",
    `android.permission.READ_EXTERNAL_STORAGE: granted=${action === "revoke"}`,
  );
  const after = capture.replace(
    "android.permission.READ_EXTERNAL_STORAGE: granted=false",
    `android.permission.READ_EXTERNAL_STORAGE: granted=${action === "grant"}`,
  );
  return [before, after];
}

describe("GrantAndroidPermissions", () => {
  test.each([
    { permissionAction: "grant", userId: 0 },
    { permissionAction: "grant", userId: 10 },
    { permissionAction: "revoke", userId: 0 },
    { permissionAction: "revoke", userId: 10 },
  ] as const)(
    "$permissionAction preserves explicit user $userId without install probes",
    async ({ permissionAction, userId }) => {
      const adb = new FakeAdbExecutor();
      adb.setForegroundApp({ packageName: "com.example.other", userId: 0 });
      adb.setUsers([
        { userId: 0, name: "Owner", flags: 0x13, running: true },
        { userId: 10, name: "Work", flags: 0x30, running: true },
      ]);
      adb.setCommandResponseSequence(
        "shell dumpsys package",
        snapshots(permissionAction, userId).map((stdout) => ({ stdout, stderr: "" })),
      );
      const action = new GrantAndroidPermissions(
        androidDevice,
        new FakeAdbClientFactory(adb),
        () => new NoOpPerformanceTracker(),
      );

      const result = await action.execute("com.example.app", {
        action: permissionAction,
        userId,
        permissions: ["android.permission.READ_EXTERNAL_STORAGE"],
      });

      expect(result.success).toBe(true);
      expect(result.userId).toBe(userId);
      expect(adb.getExecutedCommands()).toEqual([
        "shell dumpsys package 'com.example.app'",
        `shell pm ${permissionAction} --user ${userId} 'com.example.app' 'android.permission.READ_EXTERNAL_STORAGE'`,
        "shell dumpsys package 'com.example.app'",
      ]);
    },
  );

  test.each(["grant", "revoke"] as const)(
    "%s targets the owner for a personal-only app with a running work profile",
    async (permissionAction) => {
      const adb = new FakeAdbExecutor();
      adb.setForegroundApp({ packageName: "com.example.other", userId: 0 });
      adb.setUsers([
        { userId: 0, name: "Owner", flags: 0x13, running: true },
        { userId: 10, name: "Work", flags: 0x30, running: true },
      ]);
      adb.setCommandResponse("shell pm list packages --user 0", {
        stdout: "package:com.example.app",
        stderr: "",
      });
      adb.setCommandResponse("shell pm list packages --user 10", {
        stdout: "package:com.example.other",
        stderr: "",
      });
      adb.setCommandResponseSequence(
        "shell dumpsys package",
        snapshots(permissionAction, 0).map((stdout) => ({ stdout, stderr: "" })),
      );
      const action = new GrantAndroidPermissions(
        androidDevice,
        new FakeAdbClientFactory(adb),
        () => new NoOpPerformanceTracker(),
      );

      const result = await action.execute("com.example.app", {
        action: permissionAction,
        permissions: ["android.permission.READ_EXTERNAL_STORAGE"],
      });

      expect(result.success).toBe(true);
      expect(result.userId).toBe(0);
      expect(
        adb
          .getExecutedCommands()
          .filter((command) => command.startsWith(`shell pm ${permissionAction} `)),
      ).toEqual([
        `shell pm ${permissionAction} --user 0 'com.example.app' 'android.permission.READ_EXTERNAL_STORAGE'`,
      ]);
    },
  );

  test.each(["grant", "revoke"] as const)(
    "%s rejects an app installed for no user before changing permissions",
    async (permissionAction) => {
      const adb = new FakeAdbExecutor();
      adb.setForegroundApp({ packageName: "com.example.other", userId: 0 });
      adb.setUsers([
        { userId: 0, name: "Owner", flags: 0x13, running: true },
        { userId: 10, name: "Work", flags: 0x30, running: true },
      ]);
      for (const userId of [0, 10]) {
        adb.setCommandResponse(`shell pm list packages --user ${userId}`, {
          stdout: "package:com.example.other",
          stderr: "",
        });
      }
      const perf = new FakeRecordingPerformanceTracker();
      const action = new GrantAndroidPermissions(
        androidDevice,
        new FakeAdbClientFactory(adb),
        () => perf,
      );
      const execution = action.execute("com.example.app", {
        action: permissionAction,
        permissions: ["android.permission.READ_EXTERNAL_STORAGE"],
      });

      await expect(execution).rejects.toBeInstanceOf(ActionableError);
      await expect(execution).rejects.toThrow(
        "App com.example.app is not installed for Android user 10",
      );
      expect(
        adb
          .getExecutedCommands()
          .some((command) => command.startsWith(`shell pm ${permissionAction} `)),
      ).toBe(false);
      expect(perf.endCalls).toBe(1);
    },
  );

  test("ends the performance block exactly once when target-user resolution throws", async () => {
    const adb = new FakeAdbExecutor();
    const failure = new Error("adb offline during user resolution");
    adb.getForegroundApp = async () => {
      throw failure;
    };
    const perf = new FakeRecordingPerformanceTracker();
    const action = new GrantAndroidPermissions(
      androidDevice,
      new FakeAdbClientFactory(adb),
      () => perf,
    );

    await expect(
      action.execute("com.example.app", {
        permissions: ["android.permission.READ_EXTERNAL_STORAGE"],
      }),
    ).rejects.toBe(failure);

    expect(perf.serialNames).toEqual(["changeAndroidPermissions"]);
    expect(perf.endCalls).toBe(1);
    expect(adb.getExecutedCommands()).toEqual([]);
  });

  test("returns error on empty permissions", async () => {
    const factory = new FakeAdbClientFactory();
    const action = new GrantAndroidPermissions(androidDevice, factory);
    const result = await action.execute("com.example.app", { permissions: [] });

    expect(result.success).toBe(false);
    expect(result.error).toContain("at least one permission");
    expect(result.results).toHaveLength(0);
  });

  test("quotes unrequested permission and package safely without sending pm", async () => {
    const adb = new FakeAdbExecutor();
    const packageName = "com.example.app; id #";
    adb.setCommandResponse("shell dumpsys package", {
      stdout: egg.replaceAll("com.android.egg", packageName),
      stderr: "",
    });
    const action = new GrantAndroidPermissions(
      androidDevice,
      new FakeAdbClientFactory(adb),
      () => new NoOpPerformanceTracker(),
    );
    const result = await action.execute(packageName, {
      permissions: ["android.permission.CAMERA; id #"],
      userId: 0,
    });
    expect(result.success).toBe(false);
    expect(result.results[0].error).toContain("not requested");
    expect(adb.getExecutedCommands()).toEqual(["shell dumpsys package 'com.example.app; id #'"]);
  });

  test("expands a short permission name before the requested check", async () => {
    const adb = new FakeAdbExecutor();
    adb.setForegroundApp({ packageName: "com.example.other", userId: 0 });
    adb.setCommandResponseSequence(
      "shell dumpsys package",
      snapshots("grant", 0).map((stdout) => ({ stdout, stderr: "" })),
    );
    const action = new GrantAndroidPermissions(
      androidDevice,
      new FakeAdbClientFactory(adb),
      () => new NoOpPerformanceTracker(),
    );
    const result = await action.execute("com.example.app", {
      permissions: ["READ_EXTERNAL_STORAGE"],
      userId: 0,
    });
    expect(result.success).toBe(true);
    expect(result.results[0].permission).toBe("android.permission.READ_EXTERNAL_STORAGE");
    expect(adb.getExecutedCommands()).toContain(
      "shell pm grant --user 0 'com.example.app' 'android.permission.READ_EXTERNAL_STORAGE'",
    );
  });

  test("still refuses a short name the app does not request", async () => {
    const adb = new FakeAdbExecutor();
    adb.setCommandResponse("shell dumpsys package", {
      stdout: egg.replaceAll("com.android.egg", "com.example.app"),
      stderr: "",
    });
    const action = new GrantAndroidPermissions(
      androidDevice,
      new FakeAdbClientFactory(adb),
      () => new NoOpPerformanceTracker(),
    );
    const result = await action.execute("com.example.app", { permissions: ["CAMERA"], userId: 0 });
    expect(result.success).toBe(false);
    expect(result.results[0].error).toContain("android.permission.CAMERA is not requested");
    expect(adb.getExecutedCommands()).toEqual(["shell dumpsys package 'com.example.app'"]);
  });

  test("resets all Android runtime permissions through pm reset-permissions", async () => {
    const factory = new FakeAdbClientFactory();
    const client = factory.getFakeClient();
    client.setCommandResult("shell pm reset-permissions", "");

    const action = new GrantAndroidPermissions(androidDevice, factory);
    const result = await action.execute("com.example.app", {
      action: "reset",
      permissions: ["all"],
    });

    expect(result.success).toBe(true);
    expect(result.results).toEqual([
      {
        stepId: "pm_reset_permissions",
        success: true,
        countsTowardSuccess: true,
      },
    ]);
    expect(client.wasCommandExecuted("shell pm reset-permissions")).toBe(true);
  });

  test("rejects a whitespace-padded reset sentinel", async () => {
    const factory = new FakeAdbClientFactory();
    const client = factory.getFakeClient();
    const action = new GrantAndroidPermissions(androidDevice, factory);
    const result = await action.execute("com.example.app", {
      action: "reset",
      permissions: [" all "],
    });

    expect(result.success).toBe(false);
    expect(result.results[0].error).toContain("permissions=['all']");
    expect(client.wasCommandExecuted("shell pm reset-permissions")).toBe(false);
  });

  test("rejects reset scopes other than permissions=['all']", async () => {
    const factory = new FakeAdbClientFactory();
    const action = new GrantAndroidPermissions(androidDevice, factory);
    const result = await action.execute("com.example.app", {
      action: "reset",
      permissions: ["android.permission.READ_EXTERNAL_STORAGE"],
    });

    expect(result.success).toBe(false);
    expect(result.results).toEqual([
      {
        stepId: "pm_reset_permissions",
        success: false,
        countsTowardSuccess: true,
        error:
          "Android reset requires permissions=['all'] because pm reset-permissions is device-wide",
      },
    ]);
    expect(result.error).toContain("pm_reset_permissions");
  });

  test("rejects reset with a target user because it is device-wide", async () => {
    const factory = new FakeAdbClientFactory();
    const client = factory.getFakeClient();
    const action = new GrantAndroidPermissions(androidDevice, factory);

    const result = await action.execute("com.example.app", {
      action: "reset",
      permissions: ["all"],
      userId: 10,
    });

    expect(result.success).toBe(false);
    expect(result.userId).toBe(0);
    expect(result.results).toEqual([
      {
        stepId: "pm_reset_permissions",
        success: false,
        countsTowardSuccess: true,
        error: "Android reset is device-wide and does not support userId",
      },
    ]);
    expect(client.wasCommandExecuted("shell pm reset-permissions")).toBe(false);
  });

  test("reports a pm reset-permissions failure as a required operation failure", async () => {
    const factory = new FakeAdbClientFactory();
    const client = factory.getFakeClient();
    client.setCommandResult(
      "shell pm reset-permissions",
      "",
      "java.lang.SecurityException: Permission reset denied",
    );

    const action = new GrantAndroidPermissions(androidDevice, factory);
    const result = await action.execute("com.example.app", {
      action: "reset",
      permissions: ["all"],
    });

    expect(result.success).toBe(false);
    expect(result.results).toEqual([
      {
        stepId: "pm_reset_permissions",
        success: false,
        countsTowardSuccess: true,
        error: "java.lang.SecurityException: Permission reset denied",
      },
    ]);
    expect(result.error).toContain("pm_reset_permissions");
  });

  test("marks failure when stderr contains SecurityException", async () => {
    const factory = new FakeAdbClientFactory();
    const client = factory.getFakeClient();
    client.setCommandResult(
      "shell pm grant --user 0 'com.example.app' 'android.permission.READ_EXTERNAL_STORAGE'",
      "",
      "java.lang.SecurityException: Permission denial",
    );

    client.setCommandResult("shell dumpsys package 'com.example.app'", snapshots("grant", 0)[0]);
    const action = new GrantAndroidPermissions(androidDevice, factory);
    const result = await action.execute("com.example.app", {
      permissions: ["android.permission.READ_EXTERNAL_STORAGE"],
      userId: 0,
    });

    expect(result.success).toBe(false);
    expect(result.results).toHaveLength(1);
    expect(result.results[0].success).toBe(false);
    expect(result.results[0].error).toContain("SecurityException");
  });

  test("flags a blank permission name as an (empty) failure that fails the batch", async () => {
    const factory = new FakeAdbClientFactory();
    const client = factory.getFakeClient();
    client.setCommandResult(
      "shell pm grant --user 0 com.example.app android.permission.CAMERA",
      "",
    );

    client.setCommandResultSequence(
      "shell dumpsys package 'com.example.app'",
      snapshots("grant", 0),
    );
    const action = new GrantAndroidPermissions(androidDevice, factory);
    const result = await action.execute("com.example.app", {
      permissions: ["   ", "android.permission.READ_EXTERNAL_STORAGE"],
      userId: 0,
    });

    // The blank name never reaches adb but is recorded as a required failure.
    expect(result.results).toHaveLength(2);
    expect(result.results[0].stepId).toBe("pm_grant:(empty)");
    expect(result.results[0].success).toBe(false);
    expect(result.results[0].countsTowardSuccess).toBe(true);
    expect(result.results[0].error).toBe("empty permission name");
    expect(result.results[1].success).toBe(true);

    // One required step failed → batch fails and the aggregate names it.
    expect(result.success).toBe(false);
    expect(result.error).toBe("Failed step(s): pm_grant:(empty)");
  });

  test.each([
    ["grant", "android.permission.READ_EXTERNAL_STORAGE"],
    ["revoke", "android.permission.READ_EXTERNAL_STORAGE"],
  ] as const)(
    "reports the failed %s step ID when setting a permission fails",
    async (actionType, permission) => {
      const factory = new FakeAdbClientFactory();
      const client = factory.getFakeClient();
      client.setCommandError(
        `shell pm ${actionType} --user 0 'com.example.app' '${permission}'`,
        new Error("java.lang.SecurityException: Permission denial"),
      );

      client.setCommandResult(
        "shell dumpsys package 'com.example.app'",
        snapshots(actionType, 0)[0],
      );
      const action = new GrantAndroidPermissions(
        androidDevice,
        factory,
        () => new NoOpPerformanceTracker(),
      );
      const result = await action.execute("com.example.app", {
        action: actionType,
        permissions: [permission],
        userId: 0,
      });

      expect(result.success).toBe(false);
      expect(result.error).toBe(`Failed step(s): pm_${actionType}:${permission}`);
    },
  );

  test("non-Android device returns structured failure without adb", async () => {
    const factory = new FakeAdbClientFactory();
    const iosDevice: BootedDevice = {
      name: "sim",
      platform: "ios",
      deviceId: "ios-sim",
    };
    const action = new GrantAndroidPermissions(iosDevice, factory);
    const result = await action.execute("com.example.app", {
      permissions: ["android.permission.POST_NOTIFICATIONS"],
    });

    expect(result.success).toBe(false);
    expect(result.results).toHaveLength(0);
    expect(result.error).toContain("Android");
    expect(factory.getCallCount()).toBe(1);
  });
});
