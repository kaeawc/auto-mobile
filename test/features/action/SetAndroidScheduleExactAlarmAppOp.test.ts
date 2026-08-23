import { describe, expect, test } from "bun:test";
import { BootedDevice } from "../../../src/models";
import { SetAndroidScheduleExactAlarmAppOp } from "../../../src/features/action/SetAndroidScheduleExactAlarmAppOp";
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

  test("non-Android returns error", async () => {
    const factory = new FakeAdbClientFactory();
    const ios: BootedDevice = { name: "s", platform: "ios", deviceId: "ios" };
    const action = new SetAndroidScheduleExactAlarmAppOp(ios, factory);
    const result = await action.execute("com.example.app", { mode: "allow" });
    expect(result.success).toBe(false);
  });
});
