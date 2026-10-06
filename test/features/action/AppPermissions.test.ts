import { readFileSync } from "node:fs";
import { describe, expect, spyOn, test } from "bun:test";
import { SetAndroidScheduleExactAlarmAppOp } from "../../../src/features/action/SetAndroidScheduleExactAlarmAppOp";
import { SetAndroidNotificationPolicyAccess } from "../../../src/features/action/SetAndroidNotificationPolicyAccess";
import { AppPermissions } from "../../../src/features/action/AppPermissions";
import type { BootedDevice } from "../../../src/models";
import { FakeAdbClientFactory } from "../../fakes/FakeAdbClientFactory";
import { FakeSimCtlClient } from "../../fakes/FakeSimCtlClient";
import {
  CAPTURED_APP_ID,
  dumpsysNotificationFromCapture,
} from "../../helpers/notificationPolicyCapture";
import type {
  IosSimulatorPermissionCommandResult,
  TccPermissionReader,
} from "../../../src/features/action/IosSimulatorPermissions";
import type { IosPhysicalPrivacyClient } from "../../../src/features/action/IosPhysicalPermissions";

const androidDevice: BootedDevice = {
  name: "Pixel",
  platform: "android",
  deviceId: "emulator-5554",
};

const iosSimulator: BootedDevice = {
  name: "iPhone 16",
  platform: "ios",
  deviceId: "12345678-1234-1234-1234-123456789ABC",
};

const iosPhysical: BootedDevice = {
  name: "iPhone (physical)",
  platform: "ios",
  deviceId: "00008110-001234567890ABCD",
};

class RecordingPhysicalPrivacyClient implements IosPhysicalPrivacyClient {
  public calls: Array<{ appId: string; permissions: string[] }> = [];

  async resetAuthorizations(
    appId: string,
    permissions: string[],
  ): Promise<IosSimulatorPermissionCommandResult[]> {
    this.calls.push({ appId, permissions });
    return permissions.map((permission) => ({ permission, success: true }));
  }
}

const egg = readFileSync(
  new URL(
    "../../fixtures/android-dumpsys-package/dumpsys-package-system-installed.txt",
    import.meta.url,
  ),
  "utf8",
).replaceAll("com.android.egg", "com.example.app");
const dumpsysNotification = "shell dumpsys notification";
const currentUser = "shell am get-current-user";
// Real API 36 captures (see test/fixtures/android-notification-policy), with the captured package
// renamed to this suite's app id the same way the dumpsys package fixture is.
const policyListsApp = dumpsysNotificationFromCapture("after-allow", "emulator-5600").replaceAll(
  CAPTURED_APP_ID,
  "com.example.app",
);
const policyOmitsApp = dumpsysNotificationFromCapture("after-disallow", "emulator-5600").replaceAll(
  CAPTURED_APP_ID,
  "com.example.app",
);
const grantedEgg = egg.replace(
  "android.permission.READ_EXTERNAL_STORAGE: granted=false",
  "android.permission.READ_EXTERNAL_STORAGE: granted=true",
);

describe("AppPermissions", () => {
  test("sets Android runtime permissions and Android-specific options through one action", async () => {
    const adbFactory = new FakeAdbClientFactory();
    const client = adbFactory.getFakeClient();
    client.setCommandResult(
      "shell pm grant --user 0 'com.example.app' 'android.permission.READ_EXTERNAL_STORAGE'",
      "",
    );
    client.setCommandResult("shell cmd notification set_enabled 'com.example.app' true", "");
    client.setCommandResult("shell cmd notification allow_dnd 'com.example.app'", "");
    client.setCommandResult(dumpsysNotification, policyListsApp);
    client.setCommandResult(currentUser, "0\n");
    client.setCommandResult(
      "shell appops set --uid 'com.example.app' SCHEDULE_EXACT_ALARM allow",
      "",
    );

    client.setCommandResultSequence("shell dumpsys package 'com.example.app'", [egg, grantedEgg]);
    const permissions = new AppPermissions(androidDevice, { adbFactory });
    const result = await permissions.setPermissions("com.example.app", {
      permissions: ["android.permission.READ_EXTERNAL_STORAGE"],
      userId: 0,
      notificationsEnabled: true,
      notificationPolicyAccess: true,
      scheduleExactAlarm: "allow",
    });

    expect(result.success).toBe(true);
    expect(result.changedCount).toBe(4);
    expect(result.operations.map((operation) => operation.operationId)).toEqual([
      "android_runtime_permissions:grant",
      "android_notifications_enabled",
      "android_notification_policy_access",
      "android_schedule_exact_alarm_appop",
    ]);
    expect(
      client.wasCommandExecuted(
        "shell pm grant --user 0 'com.example.app' 'android.permission.READ_EXTERNAL_STORAGE'",
      ),
    ).toBe(true);
    expect(
      client.wasCommandExecuted("shell cmd notification set_enabled 'com.example.app' true"),
    ).toBe(true);
    expect(client.wasCommandExecuted("shell cmd notification allow_dnd 'com.example.app'")).toBe(
      true,
    );
    expect(
      client.wasCommandExecuted(
        "shell appops set --uid 'com.example.app' SCHEDULE_EXACT_ALARM allow",
      ),
    ).toBe(true);
  });

  test.each([
    { permissions: ["all"], userId: 0 },
    { permissions: ["camera"] },
    { permissions: [] },
  ])("invalid Android reset suppresses every additional option: %j", async (input) => {
    const adbFactory = new FakeAdbClientFactory();
    const result = await new AppPermissions(androidDevice, { adbFactory }).setPermissions(
      "com.example.app",
      {
        ...input,
        action: "reset",
        notificationsEnabled: true,
        notificationPolicyAccess: true,
        scheduleExactAlarm: "allow",
      },
    );
    expect(result.success).toBe(false);
    expect(result.changedCount).toBe(0);
    expect(result.failedCount).toBe(1);
    expect(result.operations.map((operation) => operation.operationId)).toEqual([
      "android_runtime_permissions:reset",
    ]);
    expect(adbFactory.getFakeClient().getAllCommands()).toEqual([]);
  });

  test("valid Android reset precedes additional permission commands", async () => {
    const adbFactory = new FakeAdbClientFactory();
    adbFactory.getFakeClient().setCommandResult(dumpsysNotification, policyOmitsApp);
    adbFactory.getFakeClient().setCommandResult(currentUser, "0\n");
    const result = await new AppPermissions(androidDevice, { adbFactory }).setPermissions(
      "com.example.app",
      { action: "reset", permissions: ["all"], notificationPolicyAccess: false },
    );
    expect(result.success).toBe(true);
    expect(result.changedCount).toBe(2);
    expect(result.failedCount).toBe(0);
    expect(adbFactory.getFakeClient().getAllCommands()).toEqual([
      "shell pm reset-permissions",
      "shell cmd notification disallow_dnd 'com.example.app'",
      dumpsysNotification,
      currentUser,
    ]);
  });

  test("aggregates a policy failure and a skipped alarm operation", async () => {
    const adbFactory = new FakeAdbClientFactory();
    const policy = spyOn(SetAndroidNotificationPolicyAccess.prototype, "execute").mockResolvedValue(
      {
        success: false,
        appId: "com.example.app",
        error: "policy denied",
      },
    );
    const alarm = spyOn(SetAndroidScheduleExactAlarmAppOp.prototype, "execute").mockResolvedValue({
      success: true,
      appId: "com.example.app",
      skipped: true,
    });
    try {
      const result = await new AppPermissions(androidDevice, { adbFactory }).setPermissions(
        "com.example.app",
        { notificationPolicyAccess: false, scheduleExactAlarm: "deny" },
      );
      expect(result).toMatchObject({
        success: false,
        changedCount: 0,
        failedCount: 1,
        error: "policy denied",
      });
      expect(result.operations).toMatchObject([
        {
          operationId: "android_notification_policy_access",
          success: false,
          changedCount: 0,
          failedCount: 1,
          error: "policy denied",
        },
        {
          operationId: "android_schedule_exact_alarm_appop",
          success: true,
          changedCount: 0,
          failedCount: 0,
          skipped: true,
        },
      ]);
      expect(policy.mock.calls).toEqual([["com.example.app", { allowed: false }]]);
      expect(alarm.mock.calls).toEqual([["com.example.app", { mode: "deny" }]]);
    } finally {
      policy.mockRestore();
      alarm.mockRestore();
    }
  });

  describe("notification policy access read-back (#10011 follow-up)", () => {
    const allow = "shell cmd notification allow_dnd 'com.example.app'";
    const disallow = "shell cmd notification disallow_dnd 'com.example.app'";

    async function setPolicyAccess(
      notificationPolicyAccess: boolean,
      dumpsys: string,
      commandStderr = "",
    ) {
      const adbFactory = new FakeAdbClientFactory();
      const client = adbFactory.getFakeClient();
      client.setCommandResult(notificationPolicyAccess ? allow : disallow, "", commandStderr);
      client.setCommandResult(dumpsysNotification, dumpsys);
      client.setCommandResult(currentUser, "0\n");
      const result = await new AppPermissions(androidDevice, { adbFactory }).setPermissions(
        "com.example.app",
        { notificationPolicyAccess },
      );
      return { result, client };
    }

    test("grant counts as changed only when dumpsys lists the app, with one extra adb call", async () => {
      const { result, client } = await setPolicyAccess(true, policyListsApp);
      expect(result).toMatchObject({ success: true, changedCount: 1, failedCount: 0 });
      expect(result.operations[0].result).toMatchObject({
        policyAccess: { allowed: true, method: "android_dumpsys_notification" },
      });
      expect(client.getAllCommands()).toEqual([allow, dumpsysNotification, currentUser]);
    });

    test("revoke counts as changed only when dumpsys no longer lists the app", async () => {
      const { result } = await setPolicyAccess(false, policyOmitsApp);
      expect(result).toMatchObject({ success: true, changedCount: 1, failedCount: 0 });
      expect(result.operations[0].result).toMatchObject({ policyAccess: { allowed: false } });
    });

    test("a revoke the device did not apply is a failure, not a change", async () => {
      const { result } = await setPolicyAccess(false, policyListsApp);
      expect(result.success).toBe(false);
      expect(result.changedCount).toBe(0);
      expect(result.failedCount).toBe(1);
      expect(result.error).toContain("still granted");
      expect(result.operations[0].result).toMatchObject({ policyAccess: { allowed: true } });
    });

    test("a grant the device did not apply is a failure, not a change", async () => {
      const { result } = await setPolicyAccess(true, policyOmitsApp);
      expect(result).toMatchObject({ success: false, changedCount: 0, failedCount: 1 });
      expect(result.error).toContain("not granted");
    });

    test("a command error is a failure without counting a change", async () => {
      const { result } = await setPolicyAccess(
        false,
        policyListsApp,
        "SecurityException: not allowed",
      );
      expect(result).toMatchObject({ success: false, changedCount: 0, failedCount: 1 });
      expect(result.error).toContain("SecurityException");
    });

    test("an unreadable dumpsys keeps success but does not count a change", async () => {
      const { result } = await setPolicyAccess(true, "no policy section here\n");
      expect(result).toMatchObject({ success: true, changedCount: 0, failedCount: 0 });
      expect(result.operations[0].result).toMatchObject({
        policyAccess: { allowed: null, warning: expect.stringContaining("not verified") },
      });
      expect(result.warnings).toEqual([expect.stringContaining("not verified")]);
      expect(result.operations[0].warning).toContain("not verified");
    });

    test("a verified change carries no warnings", async () => {
      const { result } = await setPolicyAccess(true, policyListsApp);
      expect(result.warnings).toBeUndefined();
      expect(result.operations[0].warning).toBeUndefined();
    });
  });

  test("aggregates an alarm failure after a successful policy operation", async () => {
    const adbFactory = new FakeAdbClientFactory();
    adbFactory.getFakeClient().setCommandResult(dumpsysNotification, policyListsApp);
    adbFactory.getFakeClient().setCommandResult(currentUser, "0\n");
    const alarm = spyOn(SetAndroidScheduleExactAlarmAppOp.prototype, "execute").mockResolvedValue({
      success: false,
      appId: "com.example.app",
      error: "alarm denied",
    });
    try {
      const result = await new AppPermissions(androidDevice, { adbFactory }).setPermissions(
        "com.example.app",
        { notificationPolicyAccess: true, scheduleExactAlarm: "allow" },
      );
      expect(result).toMatchObject({
        success: false,
        changedCount: 1,
        failedCount: 1,
        error: "alarm denied",
      });
      expect(result.operations[1]).toMatchObject({
        success: false,
        changedCount: 0,
        failedCount: 1,
        error: "alarm denied",
      });
      expect(adbFactory.getFakeClient().getAllCommands()).toEqual([
        "shell cmd notification allow_dnd 'com.example.app'",
        dumpsysNotification,
        currentUser,
      ]);
    } finally {
      alarm.mockRestore();
    }
  });

  test("aggregates Android revoke and notification command failures", async () => {
    const adbFactory = new FakeAdbClientFactory();
    const client = adbFactory.getFakeClient();
    client.setCommandResult(
      "shell pm revoke --user 0 'com.example.app' 'android.permission.READ_EXTERNAL_STORAGE'",
      "",
    );
    client.setCommandResult(
      "shell cmd notification set_enabled 'com.example.app' false",
      "",
      "SecurityException: notification access denied",
    );

    client.setCommandResultSequence("shell dumpsys package 'com.example.app'", [grantedEgg, egg]);
    const permissions = new AppPermissions(androidDevice, { adbFactory });
    const result = await permissions.setPermissions("com.example.app", {
      action: "revoke",
      permissions: ["android.permission.READ_EXTERNAL_STORAGE"],
      userId: 0,
      notificationsEnabled: false,
    });

    expect(result.success).toBe(false);
    expect(result.changedCount).toBe(1);
    expect(result.failedCount).toBe(1);
    expect(
      result.operations.map((operation) => ({
        operationId: operation.operationId,
        success: operation.success,
        changedCount: operation.changedCount,
        failedCount: operation.failedCount,
      })),
    ).toEqual([
      {
        operationId: "android_runtime_permissions:revoke",
        success: true,
        changedCount: 1,
        failedCount: 0,
      },
      {
        operationId: "android_notifications_enabled",
        success: false,
        changedCount: 0,
        failedCount: 1,
      },
    ]);
    expect(result.error).toContain("SecurityException");
  });

  test("disables Android notifications independently of runtime permissions", async () => {
    const adbFactory = new FakeAdbClientFactory();
    const client = adbFactory.getFakeClient();
    client.setCommandResult("shell cmd notification set_enabled 'com.example.app' false", "");

    const permissions = new AppPermissions(androidDevice, { adbFactory });
    const result = await permissions.setPermissions("com.example.app", {
      notificationsEnabled: false,
    });

    expect(result.success).toBe(true);
    expect(result.changedCount).toBe(1);
    expect(result.failedCount).toBe(0);
    expect(result.operations.map((operation) => operation.operationId)).toEqual([
      "android_notifications_enabled",
    ]);
    expect(
      client.wasCommandExecuted("shell cmd notification set_enabled 'com.example.app' false"),
    ).toBe(true);
  });

  test("quotes notification package names before passing them to the device shell", async () => {
    const adbFactory = new FakeAdbClientFactory();
    const client = adbFactory.getFakeClient();
    const appId = "com.example.app; id #";
    const command = "shell cmd notification set_enabled 'com.example.app; id #' false";
    client.setCommandResult(command, "");

    const permissions = new AppPermissions(androidDevice, { adbFactory });
    const result = await permissions.setPermissions(appId, {
      notificationsEnabled: false,
    });

    expect(result.success).toBe(true);
    expect(client.getAllCommands()).toContain(command);
  });

  test("rejects a notification-only Android reset before executing either operation", async () => {
    const adbFactory = new FakeAdbClientFactory();
    const client = adbFactory.getFakeClient();
    const permissions = new AppPermissions(androidDevice, { adbFactory });

    const result = await permissions.setPermissions("com.example.app", {
      action: "reset",
      notificationsEnabled: false,
    });

    expect(result.success).toBe(false);
    expect(result.changedCount).toBe(0);
    expect(result.failedCount).toBe(1);
    expect(result.operations.map((operation) => operation.operationId)).toEqual([
      "android_runtime_permissions:reset",
    ]);
    expect(result.operations[0].result).toMatchObject({
      results: [
        {
          error:
            "Android reset requires permissions=['all'] because pm reset-permissions is device-wide",
        },
      ],
    });
    expect(client.wasCommandExecuted("shell pm reset-permissions")).toBe(false);
    expect(
      client.wasCommandExecuted("shell cmd notification set_enabled com.example.app false"),
    ).toBe(false);
  });

  test("reports Android reset as one standard operation", async () => {
    const adbFactory = new FakeAdbClientFactory();
    const client = adbFactory.getFakeClient();
    client.setCommandResult("shell pm reset-permissions", "");

    const permissions = new AppPermissions(androidDevice, { adbFactory });
    const result = await permissions.setPermissions("com.example.app", {
      action: "reset",
      permissions: ["all"],
    });

    expect(result.success).toBe(true);
    expect(result.changedCount).toBe(1);
    expect(result.failedCount).toBe(0);
    expect(result.operations.map((operation) => operation.operationId)).toEqual([
      "android_runtime_permissions:reset",
    ]);
    expect(client.wasCommandExecuted("shell pm reset-permissions")).toBe(true);
  });

  test("rejects a whitespace-padded Android reset sentinel", async () => {
    const adbFactory = new FakeAdbClientFactory();
    const client = adbFactory.getFakeClient();
    const permissions = new AppPermissions(androidDevice, { adbFactory });

    const result = await permissions.setPermissions("com.example.app", {
      action: "reset",
      permissions: [" all "],
    });

    expect(result.success).toBe(false);
    expect(result.operations[0].result).toMatchObject({
      results: [
        {
          error:
            "Android reset requires permissions=['all'] because pm reset-permissions is device-wide",
        },
      ],
    });
    expect(client.wasCommandExecuted("shell pm reset-permissions")).toBe(false);
  });

  test("queries Android runtime permission state from dumpsys package", async () => {
    const adbFactory = new FakeAdbClientFactory();
    const client = adbFactory.getFakeClient();
    client.setCommandResult("shell dumpsys package 'com.example.app'", egg);

    const permissions = new AppPermissions(androidDevice, { adbFactory });
    const result = await permissions.getPermissions("com.example.app", {
      permissions: [
        "android.permission.POST_NOTIFICATIONS",
        "android.permission.READ_EXTERNAL_STORAGE",
        "android.permission.ACCESS_FINE_LOCATION",
      ],
    });

    expect(result.success).toBe(true);
    expect(
      result.permissions.map((permission) => ({
        permission: permission.permission,
        state: permission.state,
        source: permission.source,
      })),
    ).toEqual([
      {
        permission: "android.permission.POST_NOTIFICATIONS",
        state: "granted",
        source: "androidRuntime",
      },
      {
        permission: "android.permission.READ_EXTERNAL_STORAGE",
        state: "denied",
        source: "androidRuntime",
      },
      {
        permission: "android.permission.ACCESS_FINE_LOCATION",
        state: "unknown",
        source: "androidRuntime",
      },
    ]);
  });

  test("quotes package names when querying permissions through the device shell", async () => {
    const adbFactory = new FakeAdbClientFactory();
    const client = adbFactory.getFakeClient();
    const appId = "com.example.app; id #";
    const command = "shell dumpsys package 'com.example.app; id #'";
    client.setCommandResult(command, egg.replaceAll("com.example.app", appId));

    const permissions = new AppPermissions(androidDevice, { adbFactory });
    const result = await permissions.getPermissions(appId, {
      permissions: ["android.permission.POST_NOTIFICATIONS"],
    });

    expect(result.success).toBe(true);
    expect(result.permissions[0].state).toBe("granted");
    expect(client.getAllCommands()).toEqual([command]);
    expect(client.wasCommandExecuted(command)).toBe(true);
    expect(client.wasCommandExecuted(`shell dumpsys package ${appId}`)).toBe(false);
  });

  test("sets and queries iOS simulator permissions through the same facade", async () => {
    const simctl = new FakeSimCtlClient();
    const tccReader: TccPermissionReader = {
      readPermissions: async () => [
        {
          service: "kTCCServiceCamera",
          client: "com.example.app",
          auth_value: 2,
          allowed: null,
          prompt_count: null,
        },
      ],
    };

    const permissions = new AppPermissions(iosSimulator, { simctl, tccReader });
    const setResult = await permissions.setPermissions("com.example.app", {
      action: "grant",
      permissions: ["camera"],
    });
    const getResult = await permissions.getPermissions("com.example.app", {
      permissions: ["camera"],
    });

    expect(setResult.success).toBe(true);
    expect(setResult.changedCount).toBe(1);
    expect(simctl.getMethodCalls("executeCommandArgs")).toEqual([
      {
        args: [
          "privacy",
          "12345678-1234-1234-1234-123456789ABC",
          "grant",
          "camera",
          "com.example.app",
        ],
        timeoutMs: undefined,
      },
    ]);
    expect(getResult.permissions).toEqual([
      {
        permission: "camera",
        service: "kTCCServiceCamera",
        state: "granted",
        source: "iosTcc",
        authValue: 2,
        raw: {
          service: "kTCCServiceCamera",
          client: "com.example.app",
          auth_value: 2,
          allowed: null,
          prompt_count: null,
        },
      },
    ]);
  });

  test("routes reset on a physical iOS device through the CtrlProxy runner", async () => {
    const iosPhysicalClient = new RecordingPhysicalPrivacyClient();
    const permissions = new AppPermissions(iosPhysical, { iosPhysicalClient });

    const result = await permissions.setPermissions("com.example.app", {
      action: "reset",
      permissions: ["camera", "photos"],
    });

    expect(result.success).toBe(true);
    expect(result.platform).toBe("ios");
    expect(result.changedCount).toBe(2);
    expect(result.operations.map((operation) => operation.operationId)).toEqual([
      "ios_xcuitest_reset:reset:camera",
      "ios_xcuitest_reset:reset:photos",
    ]);
    expect(iosPhysicalClient.calls).toEqual([
      { appId: "com.example.app", permissions: ["camera", "photos"] },
    ]);
  });

  test("reports physical iOS all reset as per-resource operations", async () => {
    const iosPhysicalClient = new RecordingPhysicalPrivacyClient();
    const permissions = new AppPermissions(iosPhysical, { iosPhysicalClient });

    const result = await permissions.setPermissions("com.example.app", {
      action: "reset",
      permissions: ["all", "photos-add", "contacts-limited", "location-always"],
    });

    const expandedResources = [
      "camera",
      "photos",
      "microphone",
      "contacts",
      "location",
      "calendar",
      "reminders",
      "media-library",
      "homekit",
      "focus",
      "local-network",
      "bluetooth",
      "keyboard-network",
      "health",
      "user-tracking",
    ];
    expect(result.success).toBe(true);
    expect(result.changedCount).toBe(expandedResources.length);
    expect(result.failedCount).toBe(0);
    expect(result.operations.map((operation) => operation.operationId)).toEqual(
      expandedResources.map((resource) => `ios_xcuitest_reset:reset:${resource}`),
    );
    expect(iosPhysicalClient.calls).toEqual([
      {
        appId: "com.example.app",
        permissions: expandedResources,
      },
    ]);
  });

  test("returns a physical-aware failure for getPermissions on a physical iOS device", async () => {
    const tccReader: TccPermissionReader = {
      readPermissions: async () => {
        throw new Error("TCC reader must not be used for physical iOS devices");
      },
    };
    const permissions = new AppPermissions(iosPhysical, { tccReader });

    const result = await permissions.getPermissions("com.example.app", {
      permissions: ["camera"],
    });

    expect(result.success).toBe(false);
    expect(result.platform).toBe("ios");
    expect(result.appId).toBe("com.example.app");
    expect(result.deviceId).toBe(iosPhysical.deviceId);
    expect(result.permissions).toEqual([]);
    expect(result.error).toBe(
      "iOS permission state queries are not available on physical devices (no readable TCC store); use setAppPermissions with action=reset to re-arm the system prompt",
    );
  });

  test("rejects grant on a physical iOS device with a reset-only failure", async () => {
    const iosPhysicalClient = new RecordingPhysicalPrivacyClient();
    const permissions = new AppPermissions(iosPhysical, { iosPhysicalClient });

    const result = await permissions.setPermissions("com.example.app", {
      action: "grant",
      permissions: ["camera"],
    });

    expect(result.success).toBe(false);
    expect(result.action).toBe("grant");
    expect(result.error).toContain("reset");
    expect(iosPhysicalClient.calls).toEqual([]);
  });

  // Issue #4169 item 6: an unsupported request must fail loudly, not be silently
  // accepted. Android-only fields have no meaning on iOS, and a request that asks
  // for nothing at all must not report success.
  describe("rejects unsupported requests", () => {
    test("rejects the Android-only notificationPolicyAccess field on iOS", async () => {
      const permissions = new AppPermissions(iosSimulator, { simctl: new FakeSimCtlClient() });

      const result = await permissions.setPermissions("com.example.app", {
        action: "grant",
        notificationPolicyAccess: true,
      });

      expect(result.success).toBe(false);
      expect(result.operations).toEqual([]);
      expect(result.changedCount).toBe(0);
      expect(result.failedCount).toBe(0);
      expect(result.error).toBe(
        "setAppPermissions does not support the following fields on iOS: notificationPolicyAccess",
      );
    });

    test("rejects the Android-only scheduleExactAlarm field on iOS", async () => {
      const permissions = new AppPermissions(iosSimulator, { simctl: new FakeSimCtlClient() });

      const result = await permissions.setPermissions("com.example.app", {
        action: "grant",
        scheduleExactAlarm: "allow",
      });

      expect(result.success).toBe(false);
      expect(result.error).toBe(
        "setAppPermissions does not support the following fields on iOS: scheduleExactAlarm",
      );
    });

    test("rejects the Android-only notificationsEnabled field on iOS", async () => {
      const permissions = new AppPermissions(iosSimulator, { simctl: new FakeSimCtlClient() });

      const result = await permissions.setPermissions("com.example.app", {
        action: "grant",
        notificationsEnabled: true,
      });

      expect(result.success).toBe(false);
      expect(result.error).toBe(
        "setAppPermissions does not support the following fields on iOS: notificationsEnabled",
      );
    });

    test("rejects an Android-only boolean field on iOS even when it is false", async () => {
      // The presence check is `!== undefined`, so a FALSE value must still reject.
      // A regression to a truthiness check would silently accept `false` here.
      const permissions = new AppPermissions(iosSimulator, { simctl: new FakeSimCtlClient() });

      const result = await permissions.setPermissions("com.example.app", {
        action: "grant",
        notificationPolicyAccess: false,
        notificationsEnabled: false,
      });

      expect(result.success).toBe(false);
      expect(result.error).toBe(
        "setAppPermissions does not support the following fields on iOS: notificationPolicyAccess, notificationsEnabled",
      );
    });

    test("lists every unsupported field when several are supplied on iOS", async () => {
      const permissions = new AppPermissions(iosSimulator, { simctl: new FakeSimCtlClient() });

      const result = await permissions.setPermissions("com.example.app", {
        action: "grant",
        notificationPolicyAccess: true,
        scheduleExactAlarm: "allow",
      });

      expect(result.success).toBe(false);
      expect(result.error).toBe(
        "setAppPermissions does not support the following fields on iOS: notificationPolicyAccess, scheduleExactAlarm",
      );
    });

    test("fails an empty Android request instead of silently succeeding", async () => {
      const adbFactory = new FakeAdbClientFactory();
      const permissions = new AppPermissions(androidDevice, { adbFactory });

      const result = await permissions.setPermissions("com.example.app", {});

      expect(result.success).toBe(false);
      expect(result.operations.map((operation) => operation.operationId)).toEqual([
        "app_permissions:no_operation",
      ]);
      expect(result.error).toBe(
        "Provide at least one permission or Android-specific permission option",
      );
    });
  });
});
