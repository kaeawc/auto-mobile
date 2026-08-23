import { describe, expect, test } from "bun:test";
import { BootedDevice } from "../../../src/models";
import { GrantAndroidPermissions } from "../../../src/features/action/GrantAndroidPermissions";
import { NoOpPerformanceTracker } from "../../../src/utils/PerformanceTracker";
import { FakeAdbClientFactory } from "../../fakes/FakeAdbClientFactory";

const androidDevice: BootedDevice = {
  name: "emu",
  platform: "android",
  deviceId: "emulator-5554",
};

describe("GrantAndroidPermissions", () => {
  test("returns error on empty permissions", async () => {
    const factory = new FakeAdbClientFactory();
    const action = new GrantAndroidPermissions(androidDevice, factory);
    const result = await action.execute("com.example.app", { permissions: [] });

    expect(result.success).toBe(false);
    expect(result.error).toContain("at least one permission");
    expect(result.results).toHaveLength(0);
  });

  test("runs pm grant for each permission with explicit userId", async () => {
    const factory = new FakeAdbClientFactory();
    const client = factory.getFakeClient();
    client.setCommandResult(
      "shell pm grant --user 0 'com.example.app' 'android.permission.POST_NOTIFICATIONS'",
      "",
    );
    client.setCommandResult(
      "shell pm grant --user 0 'com.example.app' 'android.permission.CAMERA'",
      "",
    );

    const action = new GrantAndroidPermissions(androidDevice, factory);
    const result = await action.execute("com.example.app", {
      permissions: ["android.permission.POST_NOTIFICATIONS", "android.permission.CAMERA"],
      userId: 0,
    });

    expect(result.success).toBe(true);
    expect(result.userId).toBe(0);
    expect(result.results).toHaveLength(2);
    expect(result.results.every((r) => r.success && r.countsTowardSuccess)).toBe(true);
    expect(result.results.map((r) => r.operationId)).toEqual([
      "pm_grant:android.permission.POST_NOTIFICATIONS",
      "pm_grant:android.permission.CAMERA",
    ]);

    const calls = client.getCommandCalls().map((c) => c.command);
    expect(calls).toContain(
      "shell pm grant --user 0 'com.example.app' 'android.permission.POST_NOTIFICATIONS'",
    );
    expect(calls).toContain(
      "shell pm grant --user 0 'com.example.app' 'android.permission.CAMERA'",
    );
  });

  test("runs pm revoke for each permission with the resolved target user", async () => {
    const factory = new FakeAdbClientFactory();
    const client = factory.getFakeClient();
    client.setCommandResult(
      "shell pm revoke --user 12 'com.example.app' 'android.permission.POST_NOTIFICATIONS'",
      "",
    );

    const action = new GrantAndroidPermissions(androidDevice, factory);
    const result = await action.execute("com.example.app", {
      action: "revoke",
      permissions: ["android.permission.POST_NOTIFICATIONS"],
      userId: 12,
    });

    expect(result.success).toBe(true);
    expect(result.userId).toBe(12);
    expect(result.results).toEqual([
      {
        operationId: "pm_revoke:android.permission.POST_NOTIFICATIONS",
        permission: "android.permission.POST_NOTIFICATIONS",
        success: true,
        countsTowardSuccess: true,
      },
    ]);
    expect(
      client.wasCommandExecuted(
        "shell pm revoke --user 12 'com.example.app' 'android.permission.POST_NOTIFICATIONS'",
      ),
    ).toBe(true);
  });

  test("quotes package and permission values before passing them to the device shell", async () => {
    const factory = new FakeAdbClientFactory();
    const client = factory.getFakeClient();
    const packageName = "com.example.app; id #";
    const permission = "android.permission.CAMERA; id #";
    const command =
      "shell pm revoke --user 0 'com.example.app; id #' 'android.permission.CAMERA; id #'";
    client.setCommandResult(command, "");

    const action = new GrantAndroidPermissions(androidDevice, factory);
    const result = await action.execute(packageName, {
      action: "revoke",
      permissions: [permission],
      userId: 0,
    });

    expect(result.success).toBe(true);
    expect(client.getAllCommands()).toContain(command);
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
        operationId: "pm_reset_permissions",
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
      permissions: ["android.permission.CAMERA"],
    });

    expect(result.success).toBe(false);
    expect(result.results).toEqual([
      {
        operationId: "pm_reset_permissions",
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
        operationId: "pm_reset_permissions",
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
        operationId: "pm_reset_permissions",
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
      "shell pm grant --user 0 'com.example.app' 'android.permission.SEND_SMS'",
      "",
      "java.lang.SecurityException: Permission denial",
    );

    const action = new GrantAndroidPermissions(androidDevice, factory);
    const result = await action.execute("com.example.app", {
      permissions: ["android.permission.SEND_SMS"],
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

    const action = new GrantAndroidPermissions(androidDevice, factory);
    const result = await action.execute("com.example.app", {
      permissions: ["   ", "android.permission.CAMERA"],
      userId: 0,
    });

    // The blank name never reaches adb but is recorded as a required failure.
    expect(result.results).toHaveLength(2);
    expect(result.results[0].operationId).toBe("pm_grant:(empty)");
    expect(result.results[0].success).toBe(false);
    expect(result.results[0].countsTowardSuccess).toBe(true);
    expect(result.results[0].error).toBe("empty permission name");
    expect(result.results[1].success).toBe(true);

    // One required step failed → batch fails and the aggregate names it.
    expect(result.success).toBe(false);
    expect(result.error).toBe("Failed step(s): pm_grant:(empty)");
  });

  test.each([
    ["grant", "android.permission.SEND_SMS"],
    ["revoke", "android.permission.CAMERA"],
  ] as const)(
    "reports the failed %s operation ID when setting a permission fails",
    async (actionType, permission) => {
      const factory = new FakeAdbClientFactory();
      const client = factory.getFakeClient();
      client.setCommandError(
        `shell pm ${actionType} --user 0 'com.example.app' '${permission}'`,
        new Error("java.lang.SecurityException: Permission denial"),
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
