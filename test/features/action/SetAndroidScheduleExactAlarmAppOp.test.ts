import { describe, expect, test } from "bun:test";
import { BootedDevice, type ExecResult } from "../../../src/models";
import { SetAndroidScheduleExactAlarmAppOp } from "../../../src/features/action/SetAndroidScheduleExactAlarmAppOp";
import { runWithAbortSignal } from "../../../src/utils/AbortContext";
import { OPERATION_CANCELLED_MESSAGE } from "../../../src/utils/constants";
import { FakeAdbExecutor } from "../../fakes/FakeAdbExecutor";
import { FakeAdbClientFactory } from "../../fakes/FakeAdbClientFactory";

const androidDevice: BootedDevice = {
  name: "emu",
  platform: "android",
  deviceId: "emulator-5554",
};

describe("SetAndroidScheduleExactAlarmAppOp", () => {
  test("allow runs appops allow", async () => {
    const factory = new FakeAdbClientFactory();
    const client = factory.getFakeClient();
    client.setCommandResult(
      "shell appops set --uid 'com.example.app' SCHEDULE_EXACT_ALARM allow",
      "",
    );

    const action = new SetAndroidScheduleExactAlarmAppOp(androidDevice, factory);
    const result = await action.execute("com.example.app", { mode: "allow" });

    expect(result.success).toBe(true);
    expect(result.skipped).toBeUndefined();
    expect(
      client.wasCommandExecuted(
        "shell appops set --uid 'com.example.app' SCHEDULE_EXACT_ALARM allow",
      ),
    ).toBe(true);
  });

  test("quotes package names before passing them to the device shell", async () => {
    const factory = new FakeAdbClientFactory();
    const client = factory.getFakeClient();
    const packageName = "com.example.app; id #";
    const command = "shell appops set --uid 'com.example.app; id #' SCHEDULE_EXACT_ALARM allow";
    client.setCommandResult(command, "");

    const action = new SetAndroidScheduleExactAlarmAppOp(androidDevice, factory);
    const result = await action.execute(packageName, { mode: "allow" });

    expect(result.success).toBe(true);
    expect(client.getAllCommands()).toContain(command);
  });

  test("deny skipped below API 31", async () => {
    const factory = new FakeAdbClientFactory();
    const client = factory.getFakeClient();
    client.setCommandResult("shell getprop ro.build.version.sdk", "30\n");

    const action = new SetAndroidScheduleExactAlarmAppOp(androidDevice, factory);
    const result = await action.execute("com.example.app", { mode: "deny" });

    expect(result.success).toBe(true);
    expect(result.skipped).toBe(true);
    expect(result.skipReason).toContain("API 30");
    expect(client.wasCommandExecuted("SCHEDULE_EXACT_ALARM deny")).toBe(false);
  });

  test("deny runs on API 34", async () => {
    const factory = new FakeAdbClientFactory();
    const client = factory.getFakeClient();
    client.setCommandResult("shell getprop ro.build.version.sdk", "34\n");
    client.setCommandResult(
      "shell appops set --uid 'com.example.app' SCHEDULE_EXACT_ALARM deny",
      "",
    );

    const action = new SetAndroidScheduleExactAlarmAppOp(androidDevice, factory);
    const result = await action.execute("com.example.app", { mode: "deny" });

    expect(result.success).toBe(true);
    expect(result.skipped).toBeUndefined();
    expect(
      client.wasCommandExecuted(
        "shell appops set --uid 'com.example.app' SCHEDULE_EXACT_ALARM deny",
      ),
    ).toBe(true);
  });

  test("allow fails on error output", async () => {
    const factory = new FakeAdbClientFactory();
    const client = factory.getFakeClient();
    client.setCommandResult(
      "shell appops set --uid 'com.example.app' SCHEDULE_EXACT_ALARM allow",
      "",
      "Error: bad",
    );

    const action = new SetAndroidScheduleExactAlarmAppOp(androidDevice, factory);
    const result = await action.execute("com.example.app", { mode: "allow" });

    expect(result.success).toBe(false);
  });

  test.each(["deny", "allow"] as const)(
    "adb rejection returns failure for mode %s",
    async (mode) => {
      const client = new FakeAdbExecutor();
      client.setAndroidApiLevel(34);
      client.setCommandError(`SCHEDULE_EXACT_ALARM ${mode}`, new Error("device offline"));
      const action = new SetAndroidScheduleExactAlarmAppOp(
        androidDevice,
        new FakeAdbClientFactory(client),
      );

      const result = await action.execute("com.example.app", { mode });

      expect(result).toEqual({ success: false, appId: "com.example.app", error: "device offline" });
    },
  );

  test.each(["deny", "allow"] as const)(
    "already cancelled request rejects for mode %s",
    async (mode) => {
      const client = new FakeAdbExecutor();
      client.setAndroidApiLevel(34);
      const action = new SetAndroidScheduleExactAlarmAppOp(
        androidDevice,
        new FakeAdbClientFactory(client),
      );
      const controller = new AbortController();
      controller.abort();

      await expect(
        runWithAbortSignal(controller.signal, () => action.execute("com.example.app", { mode })),
      ).rejects.toThrow(OPERATION_CANCELLED_MESSAGE);
      expect(client.getExecutedCommands()).toEqual([]);
    },
  );

  test.each(["deny", "allow"] as const)(
    "cancellation as the command completes rejects for mode %s",
    async (mode) => {
      const client = new FakeAdbExecutor();
      client.setAndroidApiLevel(34);
      const controller = new AbortController();
      client.abortAfterCommand(`SCHEDULE_EXACT_ALARM ${mode}`, controller);
      const action = new SetAndroidScheduleExactAlarmAppOp(
        androidDevice,
        new FakeAdbClientFactory(client),
      );

      await expect(
        runWithAbortSignal(controller.signal, () => action.execute("com.example.app", { mode })),
      ).rejects.toThrow(OPERATION_CANCELLED_MESSAGE);
    },
  );

  test("deny tolerates SecurityException output", async () => {
    const factory = new FakeAdbClientFactory();
    const client = factory.getFakeClient();
    client.setCommandResult("shell getprop ro.build.version.sdk", "34\n");
    client.setCommandResult(
      "SCHEDULE_EXACT_ALARM deny",
      "",
      "java.lang.SecurityException: ignored",
    );
    const action = new SetAndroidScheduleExactAlarmAppOp(androidDevice, factory);

    expect((await action.execute("com.example.app", { mode: "deny" })).success).toBe(true);
  });

  test.each(["deny", "allow"] as const)(
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
      client.setAndroidApiLevel(34);
      client.setCommandError(`SCHEDULE_EXACT_ALARM ${mode}`, new Error("device offline"));
      const action = new SetAndroidScheduleExactAlarmAppOp(
        androidDevice,
        new FakeAdbClientFactory(client),
      );

      await expect(
        runWithAbortSignal(controller.signal, () => action.execute("com.example.app", { mode })),
      ).rejects.toThrow(OPERATION_CANCELLED_MESSAGE);
    },
  );

  test("cancellation during API discovery cannot become a skipped deny", async () => {
    const client = new FakeAdbExecutor();
    const controller = new AbortController();
    client.abortAfterApiLevel(controller);
    const action = new SetAndroidScheduleExactAlarmAppOp(
      androidDevice,
      new FakeAdbClientFactory(client),
    );

    await expect(
      runWithAbortSignal(controller.signal, () =>
        action.execute("com.example.app", { mode: "deny" }),
      ),
    ).rejects.toThrow(OPERATION_CANCELLED_MESSAGE);
    expect(client.getExecutedCommands()).toEqual([]);
  });

  test("non-Android returns error", async () => {
    const factory = new FakeAdbClientFactory();
    const ios: BootedDevice = { name: "s", platform: "ios", deviceId: "ios" };
    const action = new SetAndroidScheduleExactAlarmAppOp(ios, factory);
    const result = await action.execute("com.example.app", { mode: "allow" });
    expect(result.success).toBe(false);
  });
});
