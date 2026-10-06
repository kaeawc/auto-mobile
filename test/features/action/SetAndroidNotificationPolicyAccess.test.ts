import { describe, expect, test } from "bun:test";
import { BootedDevice, type ExecResult } from "../../../src/models";
import { SetAndroidNotificationPolicyAccess } from "../../../src/features/action/SetAndroidNotificationPolicyAccess";
import { runWithAbortSignal } from "../../../src/utils/AbortContext";
import { OPERATION_CANCELLED_MESSAGE } from "../../../src/utils/constants";
import { FakeAdbExecutor } from "../../fakes/FakeAdbExecutor";
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

  test("disallow_dnd fails on SecurityException output (no longer best-effort, #10011)", async () => {
    const factory = new FakeAdbClientFactory();
    const client = factory.getFakeClient();
    client.setCommandResult(
      "shell cmd notification disallow_dnd 'com.example.app'",
      "",
      "java.lang.SecurityException: denied",
    );

    const action = new SetAndroidNotificationPolicyAccess(androidDevice, factory);
    const result = await action.execute("com.example.app", { allowed: false });

    expect(result.success).toBe(false);
    expect(result.error).toContain("SecurityException");
  });

  test("disallow_dnd succeeds on clean output", async () => {
    const factory = new FakeAdbClientFactory();
    factory
      .getFakeClient()
      .setCommandResult("shell cmd notification disallow_dnd 'com.example.app'", "");

    const result = await new SetAndroidNotificationPolicyAccess(androidDevice, factory).execute(
      "com.example.app",
      { allowed: false },
    );

    expect(result).toEqual({ success: true, appId: "com.example.app" });
  });

  test.each([false, true])("adb rejection returns failure for mode %s", async (mode) => {
    const client = new FakeAdbExecutor();
    client.setCommandError(
      `cmd notification ${mode ? "allow_dnd" : "disallow_dnd"}`,
      new Error("device offline"),
    );
    const action = new SetAndroidNotificationPolicyAccess(
      androidDevice,
      new FakeAdbClientFactory(client),
    );

    const result = await action.execute("com.example.app", { allowed: mode });

    expect(result).toEqual({ success: false, appId: "com.example.app", error: "device offline" });
  });

  test.each([false, true])("already cancelled request rejects for mode %s", async (mode) => {
    const client = new FakeAdbExecutor();
    const action = new SetAndroidNotificationPolicyAccess(
      androidDevice,
      new FakeAdbClientFactory(client),
    );
    const controller = new AbortController();
    controller.abort();

    await expect(
      runWithAbortSignal(controller.signal, () =>
        action.execute("com.example.app", { allowed: mode }),
      ),
    ).rejects.toThrow(OPERATION_CANCELLED_MESSAGE);
    expect(client.getExecutedCommands()).toEqual([]);
  });

  test.each([false, true])(
    "cancellation as the command completes rejects for mode %s",
    async (mode) => {
      const client = new FakeAdbExecutor();
      const controller = new AbortController();
      client.abortAfterCommand(
        `cmd notification ${mode ? "allow_dnd" : "disallow_dnd"}`,
        controller,
      );
      const action = new SetAndroidNotificationPolicyAccess(
        androidDevice,
        new FakeAdbClientFactory(client),
      );

      await expect(
        runWithAbortSignal(controller.signal, () =>
          action.execute("com.example.app", { allowed: mode }),
        ),
      ).rejects.toThrow(OPERATION_CANCELLED_MESSAGE);
    },
  );

  test.each([false, true])(
    "cancellation during an adb rejection propagates for mode %s",
    async (mode) => {
      const controller = new AbortController();
      class CancellingAdbExecutor extends FakeAdbExecutor {
        override async executeCommand(command: string): Promise<ExecResult> {
          controller.abort();
          return super.executeCommand(command);
        }
      }
      const client = new CancellingAdbExecutor();
      client.setCommandError(
        `cmd notification ${mode ? "allow_dnd" : "disallow_dnd"}`,
        new Error("device offline"),
      );
      const action = new SetAndroidNotificationPolicyAccess(
        androidDevice,
        new FakeAdbClientFactory(client),
      );

      await expect(
        runWithAbortSignal(controller.signal, () =>
          action.execute("com.example.app", { allowed: mode }),
        ),
      ).rejects.toThrow(OPERATION_CANCELLED_MESSAGE);
    },
  );

  test("non-Android returns error", async () => {
    const factory = new FakeAdbClientFactory();
    const ios: BootedDevice = { name: "s", platform: "ios", deviceId: "ios" };
    const action = new SetAndroidNotificationPolicyAccess(ios, factory);
    const result = await action.execute("com.example.app", { allowed: true });
    expect(result.success).toBe(false);
    expect(result.error).toContain("Android");
  });
});
