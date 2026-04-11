import { describe, expect, test } from "bun:test";
import { BootedDevice } from "../../../src/models";
import { GrantAndroidPermissions } from "../../../src/features/action/GrantAndroidPermissions";
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
      "shell pm grant --user 0 com.example.app android.permission.POST_NOTIFICATIONS",
      ""
    );
    client.setCommandResult(
      "shell pm grant --user 0 com.example.app android.permission.CAMERA",
      ""
    );

    const action = new GrantAndroidPermissions(androidDevice, factory);
    const result = await action.execute("com.example.app", {
      permissions: ["android.permission.POST_NOTIFICATIONS", "android.permission.CAMERA"],
      userId: 0,
    });

    expect(result.success).toBe(true);
    expect(result.userId).toBe(0);
    expect(result.results).toHaveLength(2);
    expect(result.results.every(r => r.success && r.countsTowardSuccess)).toBe(true);
    expect(result.results.map(r => r.operationId)).toEqual([
      "pm_grant:android.permission.POST_NOTIFICATIONS",
      "pm_grant:android.permission.CAMERA",
    ]);

    const calls = client.getCommandCalls().map(c => c.command);
    expect(calls).toContain("shell pm grant --user 0 com.example.app android.permission.POST_NOTIFICATIONS");
    expect(calls).toContain("shell pm grant --user 0 com.example.app android.permission.CAMERA");
  });

  test("marks failure when stderr contains SecurityException", async () => {
    const factory = new FakeAdbClientFactory();
    const client = factory.getFakeClient();
    client.setCommandResult(
      "shell pm grant --user 0 com.example.app android.permission.SEND_SMS",
      "",
      "java.lang.SecurityException: Permission denial"
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
