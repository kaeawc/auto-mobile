import { describe, expect, test } from "bun:test";
import type { BootedDevice } from "../../../src/models";
import {
  NotificationPolicy,
  type NotificationPolicyAccessState,
} from "../../../src/features/utility/NotificationPolicy";
import type { IosNotificationAuthorizationReader } from "../../../src/features/utility/ios/IosNotificationAuthorizationReader";
import type { FakeAdbClient } from "../../fakes/FakeAdbClient";
import { FakeAdbClientFactory } from "../../fakes/FakeAdbClientFactory";

const androidDevice: BootedDevice = {
  name: "Pixel",
  platform: "android",
  deviceId: "emulator-5554",
};

describe("NotificationPolicy", () => {
  test("reads Android notification policy access from dumpsys notification", async () => {
    const adbFactory = new FakeAdbClientFactory();
    const client = adbFactory.getFakeClient();
    client.setCommandResult(
      "shell dumpsys notification",
      "  mPolicyAccess={0=[com.example.app, com.other.app]}\n",
    );

    const notificationPolicy = new NotificationPolicy(androidDevice, { adbFactory });
    const result = await notificationPolicy.getPolicy("com.example.app");

    expect(result.success).toBe(true);
    expect(result.policyAccess).toMatchObject({
      supported: true,
      allowed: true,
      method: "android_dumpsys_notification",
    });
  });

  test("reports Android notification policy access as false when policy list excludes app", async () => {
    const adbFactory = new FakeAdbClientFactory();
    const client = adbFactory.getFakeClient();
    client.setCommandResult("shell dumpsys notification", "  mPolicyAccess={0=[com.other.app]}\n");

    const notificationPolicy = new NotificationPolicy(androidDevice, { adbFactory });
    const result = await notificationPolicy.getPolicy("com.example.app");

    expect(result.success).toBe(true);
    expect(result.policyAccess.allowed).toBe(false);
  });

  test("sets Android notification policy access through cmd notification", async () => {
    const adbFactory = new FakeAdbClientFactory();
    const client = adbFactory.getFakeClient();
    client.setCommandResult("shell cmd notification allow_dnd 'com.example.app'", "");
    client.setCommandResult(
      "shell dumpsys notification",
      "  mPolicyAccess={0=[com.example.app]}\n",
    );

    const notificationPolicy = new NotificationPolicy(androidDevice, { adbFactory });
    const result = await notificationPolicy.setPolicy("com.example.app", {
      policyAccess: true,
    });

    expect(result.success).toBe(true);
    expect(result.policyAccess).toMatchObject({
      supported: true,
      allowed: true,
      method: "android_dumpsys_notification",
    });
    expect(client.wasCommandExecuted("shell cmd notification allow_dnd 'com.example.app'")).toBe(
      true,
    );
  });

  describe("setPolicy read-back (#10011)", () => {
    const allowCmd = "shell cmd notification allow_dnd 'com.example.app'";
    const disallowCmd = "shell cmd notification disallow_dnd 'com.example.app'";
    const dumpsys = "shell dumpsys notification";
    // Minimal hand-built strings: no captured dumpsys policy-access fixture exists in the repo yet.
    const listsApp = "  mPolicyAccess={0=[com.example.app, com.other.app]}\n";
    const omitsApp = "  mPolicyAccess={0=[com.other.app]}\n";

    function setup(): { policy: NotificationPolicy; client: FakeAdbClient } {
      const adbFactory = new FakeAdbClientFactory();
      return {
        policy: new NotificationPolicy(androidDevice, { adbFactory }),
        client: adbFactory.getFakeClient(),
      };
    }

    test("revoke whose command errored and whose read-back still lists the app is a failure", async () => {
      const { policy, client } = setup();
      client.setCommandResult(disallowCmd, "", "Error: Exception occurred while executing");
      client.setCommandResult(dumpsys, listsApp);

      const result = await policy.setPolicy("com.example.app", { policyAccess: false });

      expect(result.success).toBe(false);
      expect(result.error).toContain("Exception occurred");
      expect(result.policyAccess.allowed).toBe(true);
    });

    test("revoke reports the observed state when the read-back confirms it", async () => {
      const { policy, client } = setup();
      client.setCommandResult(disallowCmd, "");
      client.setCommandResult(dumpsys, omitsApp);

      const result = await policy.setPolicy("com.example.app", { policyAccess: false });

      expect(result.success).toBe(true);
      expect(result.policyAccess).toMatchObject({
        allowed: false,
        method: "android_dumpsys_notification",
      });
      expect(client.getAllCommands()).toEqual([disallowCmd, dumpsys]);
    });

    test("revoke with a clean command but a read-back that still lists the app is a mismatch failure", async () => {
      const { policy, client } = setup();
      client.setCommandResult(disallowCmd, "");
      client.setCommandResult(dumpsys, listsApp);

      const result = await policy.setPolicy("com.example.app", { policyAccess: false });

      expect(result.success).toBe(false);
      expect(result.policyAccess.allowed).toBe(true);
      expect(result.error).toContain("still granted");
    });

    test("grant is verified by the read-back", async () => {
      const { policy, client } = setup();
      client.setCommandResult(allowCmd, "");
      client.setCommandResult(dumpsys, listsApp);

      const result = await policy.setPolicy("com.example.app", { policyAccess: true });

      expect(result.success).toBe(true);
      expect(result.policyAccess.allowed).toBe(true);
    });

    test("grant whose read-back omits the app is a failure with allowed false", async () => {
      const { policy, client } = setup();
      client.setCommandResult(allowCmd, "");
      client.setCommandResult(dumpsys, omitsApp);

      const result = await policy.setPolicy("com.example.app", { policyAccess: true });

      expect(result.success).toBe(false);
      expect(result.policyAccess.allowed).toBe(false);
      expect(result.error).toContain("not granted");
    });

    test("an unparseable read-back keeps success but reports allowed null with a warning", async () => {
      const { policy, client } = setup();
      client.setCommandResult(disallowCmd, "");
      client.setCommandResult(dumpsys, "NotificationManagerService state\n");

      const result = await policy.setPolicy("com.example.app", { policyAccess: false });

      expect(result.success).toBe(true);
      expect(result.policyAccess.allowed).toBeNull();
      expect(result.policyAccess.warning).toContain("not verified");
    });
  });

  test("reports iOS notification policy as unsupported", async () => {
    const ios: BootedDevice = {
      name: "iPhone 16",
      platform: "ios",
      deviceId: "12345678-1234-1234-1234-123456789ABC",
    };

    const notificationPolicy = new NotificationPolicy(ios);
    const result = await notificationPolicy.setPolicy("com.example.app", {
      policyAccess: true,
    });

    expect(result.success).toBe(false);
    expect(result.policyAccess.supported).toBe(false);
    expect(result.error).toContain("iOS does not expose");
  });

  test("getPolicy on iOS simulator routes to the injected BulletinBoard reader", async () => {
    const ios: BootedDevice = {
      name: "iPhone 16",
      platform: "ios",
      deviceId: "12345678-1234-1234-1234-123456789ABC",
    };

    const calls: Array<{ deviceId: string; bundleId: string }> = [];
    const fakeReader: IosNotificationAuthorizationReader = {
      read: async (deviceId, bundleId) => {
        calls.push({ deviceId, bundleId });
        return {
          supported: true,
          method: "ios_bulletinboard_plist",
          allowed: true,
          authorizationStatus: "authorized",
        } as NotificationPolicyAccessState;
      },
    };

    const notificationPolicy = new NotificationPolicy(ios, { iosReader: fakeReader });
    const result = await notificationPolicy.getPolicy("com.apple.MobileSMS");

    expect(result.success).toBe(true);
    expect(result.platform).toBe("ios");
    expect(result.policyAccess).toMatchObject({
      supported: true,
      method: "ios_bulletinboard_plist",
      allowed: true,
      authorizationStatus: "authorized",
    });
    expect(calls).toEqual([{ deviceId: ios.deviceId, bundleId: "com.apple.MobileSMS" }]);
  });

  test("getPolicy on iOS surfaces reader errors as success:false", async () => {
    const ios: BootedDevice = {
      name: "iPhone (physical)",
      platform: "ios",
      deviceId: "00008110-000A1234567890AB",
    };
    const fakeReader: IosNotificationAuthorizationReader = {
      read: async () => ({
        supported: false,
        method: "unsupported",
        error: "iOS notification authorization can only be read on simulators",
      }),
    };

    const notificationPolicy = new NotificationPolicy(ios, { iosReader: fakeReader });
    const result = await notificationPolicy.getPolicy("com.apple.MobileSMS");

    expect(result.success).toBe(false);
    expect(result.policyAccess.supported).toBe(false);
    expect(result.error).toContain("simulators");
  });
});
