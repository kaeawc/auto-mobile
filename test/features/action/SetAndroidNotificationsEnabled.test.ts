import { readFileSync } from "node:fs";
import { describe, expect, test } from "bun:test";
import {
  parseNotificationAppOpMode,
  SetAndroidNotificationsEnabled,
} from "../../../src/features/action/SetAndroidNotificationsEnabled";
import type { BootedDevice } from "../../../src/models";
import { FakeAdbClientFactory } from "../../fakes/FakeAdbClientFactory";

const device: BootedDevice = { name: "Pixel", platform: "android", deviceId: "fake" };
const set = "shell cmd appops set 'com.example.app' POST_NOTIFICATION";
const get = "shell cmd appops get 'com.example.app' POST_NOTIFICATION";
function fixture(name: string): string {
  return readFileSync(
    new URL(`../../fixtures/android-notification-enabled/${name}.txt`, import.meta.url),
    "utf8",
  );
}

// Load outside individual tests so fixture I/O does not affect their timing budget.
const modes = ["allow", "deny", "ignore", "default", "foreground"] as const;
const fixtures = [33, 37].flatMap((api) =>
  modes.map((mode) => ({
    api,
    mode,
    output: fixture(`get-post-notification-api${api}-${mode}`),
  })),
);
const oldFailure = fixture("set-enabled-api37-stdout");
const oldExitCode = fixture("set-enabled-api37-exit-code");

describe("parseNotificationAppOpMode", () => {
  test.each(fixtures)("API $api $mode", ({ mode, output }) => {
    expect(parseNotificationAppOpMode(output)).toBe(mode);
  });
  test("accepts explicit default and CRLF indentation", () => {
    expect(parseNotificationAppOpMode("  POST_NOTIFICATION: default; time=+1s ago\r\n")).toBe(
      "default",
    );
  });
  test.each([
    "",
    "unrecognized",
    "POST_NOTIFICATION: future",
    "POST_NOTIFICATION: allowed",
    "OTHER_OP: allow",
    "Uid mode: POST_NOTIFICATION: allow",
    oldFailure,
  ])("rejects unrecognized output: %s", (output) => {
    expect(parseNotificationAppOpMode(output)).toBeUndefined();
  });
});

// Reuse the captured egg dump; package/user renaming and denied variants are synthetic.
const permissionCapture = readFileSync(
  new URL(
    "../../fixtures/android-dumpsys-package/dumpsys-package-system-installed.txt",
    import.meta.url,
  ),
  "utf8",
);
function permissionDump(enabled: boolean, appId = "com.example.app", userId = 0): string {
  return permissionCapture
    .replaceAll("com.android.egg", appId)
    .replace("User 0:", `User ${userId}:`)
    .replace(
      "android.permission.POST_NOTIFICATIONS: granted=true",
      `android.permission.POST_NOTIFICATIONS: granted=${enabled}`,
    );
}
const permission = "android.permission.POST_NOTIFICATIONS";
const dump = "shell dumpsys package 'com.example.app'";

describe("SetAndroidNotificationsEnabled", () => {
  test.each([
    { api: 37, enabled: true, userId: 0 },
    { api: 37, enabled: false, userId: 0 },
    { api: 33, enabled: true, userId: 0 },
    { api: null, enabled: false, userId: 0 },
    { api: 37, enabled: true, userId: 10 },
  ])("API $api permission enabled=$enabled user=$userId", async ({ api, enabled, userId }) => {
    const factory = new FakeAdbClientFactory();
    const client = factory.getFakeClient();
    client.setCommandResult(dump, permissionDump(enabled, "com.example.app", userId));
    const result = await new SetAndroidNotificationsEnabled(
      device,
      factory,
      async () => api,
    ).execute("com.example.app", { enabled, userId });
    expect(result).toEqual({ success: true, appId: "com.example.app" });
    expect(client.getAllCommands()).toEqual([
      `shell pm ${enabled ? "grant" : "revoke"} --user ${userId} 'com.example.app' ${permission}`,
      dump,
    ]);
    expect(client.getCommandCalls().every((call) => call.noRetry === true)).toBe(true);
    expect(
      client.getAllCommands().some((command) => command.includes("cmd notification set_enabled")),
    ).toBe(false);
  });
  test("resolves the default target user like the runtime grant action", async () => {
    const factory = new FakeAdbClientFactory();
    factory.getFakeClient().setCommandResult(dump, permissionDump(true));
    expect(
      (
        await new SetAndroidNotificationsEnabled(device, factory, async () => 37).execute(
          "com.example.app",
          { enabled: true },
        )
      ).success,
    ).toBe(true);
    expect(factory.getFakeClient().getAllCommands()).toContain(
      `shell pm grant --user 0 'com.example.app' ${permission}`,
    );
  });
  test.each([true, false])("permission read-back mismatch enabled=%s", async (enabled) => {
    const factory = new FakeAdbClientFactory();
    factory.getFakeClient().setCommandResult(dump, permissionDump(!enabled));
    const result = await new SetAndroidNotificationsEnabled(
      device,
      factory,
      async () => 37,
    ).execute("com.example.app", { enabled, userId: 0 });
    expect(result.success).toBe(false);
    expect(result.error).toContain(`enabled=${enabled}`);
    expect(result.error).toContain(`granted=${!enabled}`);
  });
  test.each([
    "",
    "Error: read denied",
    permissionCapture,
    permissionDump(true).replace(
      "POST_NOTIFICATIONS: granted=true",
      "POST_NOTIFICATIONS: unreadable",
    ),
  ])("permission read-back absent/unreadable: %s", async (output) => {
    const factory = new FakeAdbClientFactory();
    factory.getFakeClient().setCommandResult(dump, output);
    const result = await new SetAndroidNotificationsEnabled(
      device,
      factory,
      async () => 37,
    ).execute("com.example.app", { enabled: true, userId: 0 });
    expect(result.success).toBe(false);
    expect(result.error).toContain("enabled=true");
    expect(result.error).toContain("POST_NOTIFICATIONS");
  });
  test("does not verify against another user's permission row", async () => {
    const factory = new FakeAdbClientFactory();
    factory.getFakeClient().setCommandResult(dump, permissionDump(true));
    const result = await new SetAndroidNotificationsEnabled(
      device,
      factory,
      async () => 37,
    ).execute("com.example.app", { enabled: true, userId: 10 });
    expect(result.success).toBe(false);
    expect(result.error).toContain("user 10");
  });
  test.each(fixtures)("API 32 verifies appop fixture $api $mode", async ({ mode, output }) => {
    const enabled = mode === "allow";
    const factory = new FakeAdbClientFactory();
    const client = factory.getFakeClient();
    client.setCommandResult(get, output);
    const result = await new SetAndroidNotificationsEnabled(
      device,
      factory,
      async () => 32,
    ).execute("com.example.app", { enabled });
    expect(result.success).toBe(["allow", "deny", "ignore"].includes(mode));
    expect(client.getAllCommands()).toEqual([`${set} ${enabled ? "allow" : "deny"}`, get]);
    expect(client.getCommandCalls().every((call) => call.noRetry === true)).toBe(true);
  });
  test.each([
    { enabled: true, mode: "deny" },
    { enabled: true, mode: "ignore" },
    { enabled: true, mode: "default" },
    { enabled: true, mode: "foreground" },
    { enabled: false, mode: "allow" },
    { enabled: false, mode: "default" },
    { enabled: false, mode: "foreground" },
    { enabled: false, mode: "No operations." },
    { enabled: true, mode: "No operations." },
  ])("API 32 rejects mismatch $enabled / $mode", async ({ enabled, mode }) => {
    const factory = new FakeAdbClientFactory();
    factory
      .getFakeClient()
      .setCommandResult(get, mode === "No operations." ? mode : `POST_NOTIFICATION: ${mode}`);
    const result = await new SetAndroidNotificationsEnabled(
      device,
      factory,
      async () => 32,
    ).execute("com.example.app", { enabled });
    expect(result.success).toBe(false);
    expect(result.error).toContain(`enabled=${enabled}`);
  });
  test.each([
    { api: 32, command: `${set} allow`, output: "Unknown operation string: POST_NOTIFICATION" },
    { api: 32, command: `${set} allow`, output: "Error: permission denied" },
    {
      api: 37,
      command: `shell pm grant --user 0 'com.example.app' ${permission}`,
      output: "SecurityException: permission denied",
    },
  ])("rejects API $api set failure $output", async ({ api, command, output }) => {
    const factory = new FakeAdbClientFactory();
    factory.getFakeClient().setCommandResult(command, output);
    const result = await new SetAndroidNotificationsEnabled(
      device,
      factory,
      async () => api,
    ).execute("com.example.app", { enabled: true, userId: 0 });
    expect(result).toMatchObject({ success: false, error: output });
    expect(factory.getFakeClient().getAllCommands()).toEqual([command]);
  });
  test.each([
    "",
    "POST_NOTIFICATION: future",
    "Unknown operation string: POST_NOTIFICATION",
    "Error: read denied",
  ])("API 32 rejects unreadable verification %s", async (output) => {
    const factory = new FakeAdbClientFactory();
    factory.getFakeClient().setCommandResult(get, output);
    const result = await new SetAndroidNotificationsEnabled(
      device,
      factory,
      async () => 32,
    ).execute("com.example.app", { enabled: true });
    expect(result.success).toBe(false);
    expect(result.error).toBeTruthy();
  });
  test.each([32, 37])("API %s quotes injection-looking package in all commands", async (api) => {
    const factory = new FakeAdbClientFactory();
    const appId = "com.example'; id #";
    const quoted = "'com.example'\\''; id #'";
    const read =
      api === 32
        ? `shell cmd appops get ${quoted} POST_NOTIFICATION`
        : `shell dumpsys package ${quoted}`;
    factory
      .getFakeClient()
      .setCommandResult(
        read,
        api === 32 ? "POST_NOTIFICATION: deny" : permissionDump(false, appId),
      );
    const result = await new SetAndroidNotificationsEnabled(
      device,
      factory,
      async () => api,
    ).execute(appId, {
      enabled: false,
      userId: 0,
    });
    expect(result.success).toBe(true);
    expect(factory.getFakeClient().getAllCommands()).toEqual([
      api === 32
        ? `shell cmd appops set ${quoted} POST_NOTIFICATION deny`
        : `shell pm revoke --user 0 ${quoted} ${permission}`,
      read,
    ]);
  });
  test("preserves the real failing-command capture", () => {
    expect(oldExitCode.trim()).toBe("255");
    expect(oldFailure.trim()).toBe("Unknown command: set_enabled");
  });
  test("refuses non-Android without probing or shell calls", async () => {
    const factory = new FakeAdbClientFactory();
    const result = await new SetAndroidNotificationsEnabled(
      { ...device, platform: "ios" },
      factory,
      async () => {
        throw new Error("must not probe");
      },
    ).execute("com.example.app", { enabled: true });
    expect(result.success).toBe(false);
    expect(result.error).toContain("only supported on Android");
    expect(factory.getFakeClient().getAllCommands()).toEqual([]);
  });
  test("returns logged typed failure when ADB rejects", async () => {
    const factory = new FakeAdbClientFactory();
    factory.getFakeClient().setCommandError(`${set} allow`, new Error("ADB disconnected"));
    const result = await new SetAndroidNotificationsEnabled(
      device,
      factory,
      async () => 32,
    ).execute("com.example.app", { enabled: true });
    expect(result).toMatchObject({ success: false, error: "ADB disconnected" });
  });
});
