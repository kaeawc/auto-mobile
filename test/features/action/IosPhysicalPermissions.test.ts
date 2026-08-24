import { describe, expect, test } from "bun:test";
import {
  IosPhysicalPermissions,
  type IosPhysicalPrivacyClient,
} from "../../../src/features/action/IosPhysicalPermissions";
import type { BootedDevice } from "../../../src/models";
import type { IosSimulatorPermissionCommandResult } from "../../../src/features/action/IosSimulatorPermissions";

const physicalDevice: BootedDevice = {
  name: "iPhone (physical)",
  platform: "ios",
  deviceId: "00008110-001234567890ABCD",
};

/**
 * Recording fake for the CtrlProxy-backed reset client. Returns per-permission
 * results the caller pre-seeds, so a test can force partial failure without a device.
 */
class FakePhysicalPrivacyClient implements IosPhysicalPrivacyClient {
  public calls: Array<{ appId: string; permissions: string[] }> = [];
  private resultByPermission = new Map<string, IosSimulatorPermissionCommandResult>();

  setResult(permission: string, result: IosSimulatorPermissionCommandResult): void {
    this.resultByPermission.set(permission, result);
  }

  async resetAuthorizations(
    appId: string,
    permissions: string[],
  ): Promise<IosSimulatorPermissionCommandResult[]> {
    this.calls.push({ appId, permissions });
    return permissions.map(
      (permission) => this.resultByPermission.get(permission) ?? { permission, success: true },
    );
  }
}

describe("IosPhysicalPermissions", () => {
  test("reset expands all to every physical iOS resettable resource", async () => {
    const client = new FakePhysicalPrivacyClient();
    const permissions = new IosPhysicalPermissions(physicalDevice, client);

    const result = await permissions.setPermissions("reset", "com.example.app", [" all "]);

    const expanded = [
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
    expect(result.changedCount).toBe(expanded.length);
    expect(result.failedCount).toBe(0);
    expect(result.results.map((r) => r.permission)).toEqual(expanded);
    expect(client.calls).toEqual([{ appId: "com.example.app", permissions: expanded }]);
  });

  test("reset deduplicates explicit resources already covered by all", async () => {
    const client = new FakePhysicalPrivacyClient();
    const permissions = new IosPhysicalPermissions(physicalDevice, client);

    const result = await permissions.setPermissions("reset", "com.example.app", [
      "camera",
      "all",
      "photos",
      "photos-add",
      "contacts-limited",
      "location-always",
    ]);

    const expanded = [
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
    expect(result.changedCount).toBe(expanded.length);
    expect(result.results.map((r) => r.permission)).toEqual(expanded);
    expect(client.calls).toEqual([
      {
        appId: "com.example.app",
        permissions: expanded,
      },
    ]);
  });

  test("reset preserves the first requested alias when deduplicating aliases", async () => {
    const client = new FakePhysicalPrivacyClient();
    const permissions = new IosPhysicalPermissions(physicalDevice, client);

    const result = await permissions.setPermissions("reset", "com.example.app", [
      "photos-add",
      "photos",
    ]);

    expect(result.success).toBe(true);
    expect(result.changedCount).toBe(1);
    expect(result.results.map((r) => r.permission)).toEqual(["photos-add"]);
    expect(client.calls).toEqual([{ appId: "com.example.app", permissions: ["photos-add"] }]);
  });

  test("reset delegates to the client and reports per-permission success", async () => {
    const client = new FakePhysicalPrivacyClient();
    const permissions = new IosPhysicalPermissions(physicalDevice, client);

    const result = await permissions.setPermissions("reset", "com.example.app", [
      "camera",
      "photos",
    ]);

    expect(result.success).toBe(true);
    expect(result.action).toBe("reset");
    expect(result.appId).toBe("com.example.app");
    expect(result.deviceId).toBe(physicalDevice.deviceId);
    expect(result.platform).toBe("ios");
    expect(result.changedCount).toBe(2);
    expect(result.failedCount).toBe(0);
    expect(result.results.map((r) => r.permission)).toEqual(["camera", "photos"]);
    expect(client.calls).toEqual([{ appId: "com.example.app", permissions: ["camera", "photos"] }]);
  });

  test("reset supports the newly added XCUIProtectedResource names explicitly", async () => {
    const client = new FakePhysicalPrivacyClient();
    const permissions = new IosPhysicalPermissions(physicalDevice, client);

    const newlySupported = [
      "homekit",
      "focus",
      "local-network",
      "bluetooth",
      "keyboard-network",
      "health",
      "user-tracking",
    ];
    const result = await permissions.setPermissions("reset", "com.example.app", newlySupported);

    expect(result.success).toBe(true);
    expect(result.changedCount).toBe(newlySupported.length);
    expect(result.results.map((r) => r.permission)).toEqual(newlySupported);
    expect(client.calls).toEqual([{ appId: "com.example.app", permissions: newlySupported }]);
  });

  test("reset aggregates partial failure (e.g. unmapped resource) honestly", async () => {
    const client = new FakePhysicalPrivacyClient();
    client.setResult("siri", {
      permission: "siri",
      success: false,
      error: "Invalid value 'siri' for parameter 'permission'",
    });
    const permissions = new IosPhysicalPermissions(physicalDevice, client);

    const result = await permissions.setPermissions("reset", "com.example.app", ["camera", "siri"]);

    expect(result.success).toBe(false);
    expect(result.changedCount).toBe(1);
    expect(result.failedCount).toBe(1);
    expect(result.error).toContain("reset");
    const failed = result.results.find((r) => r.permission === "siri");
    expect(failed?.success).toBe(false);
    expect(failed?.error).toContain("siri");
  });

  test("empty permission list is a no-op success and never calls the client", async () => {
    const client = new FakePhysicalPrivacyClient();
    const permissions = new IosPhysicalPermissions(physicalDevice, client);

    const result = await permissions.setPermissions("reset", "com.example.app", []);

    expect(result.success).toBe(true);
    expect(result.changedCount).toBe(0);
    expect(result.results).toEqual([]);
    expect(client.calls).toEqual([]);
  });

  test("grant is rejected with a clear reset-only message and no client call", async () => {
    const client = new FakePhysicalPrivacyClient();
    const permissions = new IosPhysicalPermissions(physicalDevice, client);

    const result = await permissions.setPermissions("grant", "com.example.app", ["camera"]);

    expect(result.success).toBe(false);
    expect(result.action).toBe("grant");
    expect(result.changedCount).toBe(0);
    expect(result.results).toEqual([]);
    expect(result.error).toContain("reset");
    expect(result.error?.toLowerCase()).toContain("physical");
    expect(client.calls).toEqual([]);
  });

  test("revoke is rejected with a clear reset-only message and no client call", async () => {
    const client = new FakePhysicalPrivacyClient();
    const permissions = new IosPhysicalPermissions(physicalDevice, client);

    const result = await permissions.setPermissions("revoke", "com.example.app", ["camera"]);

    expect(result.success).toBe(false);
    expect(result.action).toBe("revoke");
    expect(result.error).toContain("reset");
    expect(client.calls).toEqual([]);
  });

  test("empty appId is rejected before any client call", async () => {
    const client = new FakePhysicalPrivacyClient();
    const permissions = new IosPhysicalPermissions(physicalDevice, client);

    const result = await permissions.setPermissions("reset", "   ", ["camera"]);

    expect(result.success).toBe(false);
    expect(result.error?.toLowerCase()).toContain("bundle identifier");
    expect(client.calls).toEqual([]);
  });
});
