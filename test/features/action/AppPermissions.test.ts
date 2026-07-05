import { describe, expect, test } from "bun:test";
import { AppPermissions } from "../../../src/features/action/AppPermissions";
import type { BootedDevice } from "../../../src/models";
import { FakeAdbClientFactory } from "../../fakes/FakeAdbClientFactory";
import { FakeSimCtlClient } from "../../fakes/FakeSimCtlClient";
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
    permissions: string[]
  ): Promise<IosSimulatorPermissionCommandResult[]> {
    this.calls.push({ appId, permissions });
    return permissions.map(permission => ({ permission, success: true }));
  }
}

describe("AppPermissions", () => {
  test("sets Android runtime permissions and Android-specific options through one action", async () => {
    const adbFactory = new FakeAdbClientFactory();
    const client = adbFactory.getFakeClient();
    client.setCommandResult("shell pm grant --user 0 com.example.app android.permission.CAMERA", "");
    client.setCommandResult("shell cmd notification allow_dnd com.example.app", "");
    client.setCommandResult("shell appops set --uid com.example.app SCHEDULE_EXACT_ALARM allow", "");

    const permissions = new AppPermissions(androidDevice, { adbFactory });
    const result = await permissions.setPermissions("com.example.app", {
      permissions: ["android.permission.CAMERA"],
      userId: 0,
      notificationPolicyAccess: true,
      scheduleExactAlarm: "allow",
    });

    expect(result.success).toBe(true);
    expect(result.changedCount).toBe(3);
    expect(result.operations.map(operation => operation.operationId)).toEqual([
      "android_runtime_permissions:grant",
      "android_notification_policy_access",
      "android_schedule_exact_alarm_appop",
    ]);
    expect(client.wasCommandExecuted("shell pm grant --user 0 com.example.app android.permission.CAMERA")).toBe(true);
    expect(client.wasCommandExecuted("shell cmd notification allow_dnd com.example.app")).toBe(true);
    expect(client.wasCommandExecuted("shell appops set --uid com.example.app SCHEDULE_EXACT_ALARM allow")).toBe(true);
  });

  test("queries Android runtime permission state from dumpsys package", async () => {
    const adbFactory = new FakeAdbClientFactory();
    const client = adbFactory.getFakeClient();
    client.setCommandResult(
      "shell dumpsys package com.example.app",
      [
        "runtime permissions:",
        "  android.permission.CAMERA: granted=true, flags=[ USER_SET ]",
        "  android.permission.POST_NOTIFICATIONS: granted=false, flags=[ USER_FIXED ]",
      ].join("\n")
    );

    const permissions = new AppPermissions(androidDevice, { adbFactory });
    const result = await permissions.getPermissions("com.example.app", {
      permissions: [
        "android.permission.CAMERA",
        "android.permission.POST_NOTIFICATIONS",
        "android.permission.ACCESS_FINE_LOCATION",
      ],
    });

    expect(result.success).toBe(true);
    expect(result.permissions.map(permission => ({
      permission: permission.permission,
      state: permission.state,
      source: permission.source,
    }))).toEqual([
      { permission: "android.permission.CAMERA", state: "granted", source: "androidRuntime" },
      { permission: "android.permission.POST_NOTIFICATIONS", state: "denied", source: "androidRuntime" },
      { permission: "android.permission.ACCESS_FINE_LOCATION", state: "unknown", source: "androidRuntime" },
    ]);
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
    expect(simctl.getMethodCalls("executeCommand")).toEqual([
      {
        command: 'privacy "12345678-1234-1234-1234-123456789ABC" grant "camera" "com.example.app"',
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
    expect(result.operations.map(operation => operation.operationId)).toEqual([
      "ios_xcuitest_reset:reset:camera",
      "ios_xcuitest_reset:reset:photos",
    ]);
    expect(iosPhysicalClient.calls).toEqual([
      { appId: "com.example.app", permissions: ["camera", "photos"] },
    ]);
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
});
