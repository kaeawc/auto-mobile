import { describe, expect, test } from "bun:test";
import { BootedDevice } from "../../../src/models";
import { SetAndroidNotificationPolicyAccess } from "../../../src/features/action/SetAndroidNotificationPolicyAccess";
import { FakeAdbClientFactory } from "../../fakes/FakeAdbClientFactory";

const androidDevice: BootedDevice = {
  name: "emu",
  platform: "android",
  deviceId: "emulator-5554",
};

describe("SetAndroidNotificationPolicyAccess", () => {
  test("allow_dnd on success", async () => {
    const factory = new FakeAdbClientFactory();
    const client = factory.getFakeClient();
    client.setCommandResult("shell cmd notification allow_dnd 'com.example.app'", "");

    const action = new SetAndroidNotificationPolicyAccess(androidDevice, factory);
    const result = await action.execute("com.example.app", { allowed: true });

    expect(result.success).toBe(true);
    expect(client.wasCommandExecuted("shell cmd notification allow_dnd 'com.example.app'")).toBe(
      true,
    );
  });

  test("quotes package names before passing them to the device shell", async () => {
    const factory = new FakeAdbClientFactory();
    const client = factory.getFakeClient();
    const packageName = "com.example.app; id #";
    const command = "shell cmd notification allow_dnd 'com.example.app; id #'";
    client.setCommandResult(command, "");

    const action = new SetAndroidNotificationPolicyAccess(androidDevice, factory);
    const result = await action.execute(packageName, { allowed: true });

    expect(result.success).toBe(true);
    expect(client.getAllCommands()).toContain(command);
  });

  test("allow_dnd fails on SecurityException output", async () => {
    const factory = new FakeAdbClientFactory();
    const client = factory.getFakeClient();
    client.setCommandResult(
      "shell cmd notification allow_dnd 'com.example.app'",
      "",
      "java.lang.SecurityException: nope",
    );

    const action = new SetAndroidNotificationPolicyAccess(androidDevice, factory);
    const result = await action.execute("com.example.app", { allowed: true });

    expect(result.success).toBe(false);
    expect(result.error).toContain("SecurityException");
  });

  test("disallow_dnd succeeds despite error-looking stderr (best-effort)", async () => {
    const factory = new FakeAdbClientFactory();
    const client = factory.getFakeClient();
    client.setCommandResult(
      "shell cmd notification disallow_dnd 'com.example.app'",
      "",
      "java.lang.SecurityException: ignored",
    );

    const action = new SetAndroidNotificationPolicyAccess(androidDevice, factory);
    const result = await action.execute("com.example.app", { allowed: false });

    expect(result.success).toBe(true);
  });

  test("non-Android returns error", async () => {
    const factory = new FakeAdbClientFactory();
    const ios: BootedDevice = { name: "s", platform: "ios", deviceId: "ios" };
    const action = new SetAndroidNotificationPolicyAccess(ios, factory);
    const result = await action.execute("com.example.app", { allowed: true });
    expect(result.success).toBe(false);
    expect(result.error).toContain("Android");
  });
});
