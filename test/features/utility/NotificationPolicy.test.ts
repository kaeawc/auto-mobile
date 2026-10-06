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

const currentUserCmd = "shell am get-current-user";

async function readWith(dumpsysOutput: string, userId = "0\n") {
  const adbFactory = new FakeAdbClientFactory();
  const client = adbFactory.getFakeClient();
  client.setCommandResult(currentUserCmd, userId);
  client.setCommandResult("shell dumpsys notification", dumpsysOutput);
  return new NotificationPolicy(androidDevice, { adbFactory }).getPolicy("com.example.app");
}

describe("NotificationPolicy", () => {
  test("reads Android notification policy access from dumpsys notification", async () => {
    const adbFactory = new FakeAdbClientFactory();
    const client = adbFactory.getFakeClient();
    client.setCommandResult(currentUserCmd, "0\n");
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
    client.setCommandResult(currentUserCmd, "0\n");
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
    client.setCommandResult(currentUserCmd, "0\n");
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
    // SYNTHETIC shape probes, not captures: no real `dumpsys notification` policy-access output exists
    // in the repo yet. They only pin which shapes the parser recognises; a real capture is still needed.
    const listsApp = "  mPolicyAccess={0=[com.example.app, com.other.app]}\n";
    const omitsApp = "  mPolicyAccess={0=[com.other.app]}\n";

    function setup(): { policy: NotificationPolicy; client: FakeAdbClient } {
      const adbFactory = new FakeAdbClientFactory();
      const client = adbFactory.getFakeClient();
      client.setCommandResult(currentUserCmd, "0\n");
      return { policy: new NotificationPolicy(androidDevice, { adbFactory }), client };
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
      expect(client.getAllCommands()).toEqual([disallowCmd, dumpsys, currentUserCmd]);
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

    test("a failing disallow_dnd whose read-back shows the app not granted is still a success with a warning", async () => {
      const { policy, client } = setup();
      client.setCommandResult(disallowCmd, "", "Error: package not found");
      client.setCommandResult(dumpsys, omitsApp);

      const result = await policy.setPolicy("com.example.app", { policyAccess: false });

      expect(result.success).toBe(true);
      expect(result.policyAccess.allowed).toBe(false);
      expect(result.policyAccess.warning).toContain("package not found");
    });

    test("a failing allow_dnd whose read-back already shows the grant is a success with a warning", async () => {
      const { policy, client } = setup();
      client.setCommandResult(allowCmd, "", "Error: already allowed");
      client.setCommandResult(dumpsys, listsApp);

      const result = await policy.setPolicy("com.example.app", { policyAccess: true });

      expect(result.success).toBe(true);
      expect(result.policyAccess.warning).toContain("already allowed");
    });

    test("a failing command with an unverified read-back stays a failure", async () => {
      const { policy, client } = setup();
      client.setCommandResult(disallowCmd, "", "Error: boom");
      client.setCommandResult(dumpsys, "nothing recognisable\n");

      const result = await policy.setPolicy("com.example.app", { policyAccess: false });

      expect(result.success).toBe(false);
      expect(result.error).toContain("boom");
    });

    describe("conservative parsing (synthetic shape probes)", () => {
      const multiUser = "  mPolicyAccess={0=[com.other.app], 10=[com.example.app]}\n";

      test("multi-user map: a revoke is judged on the current user's list only", async () => {
        const { policy, client } = setup();
        client.setCommandResult(disallowCmd, "");
        client.setCommandResult(dumpsys, multiUser);

        const result = await policy.setPolicy("com.example.app", { policyAccess: false });

        expect(result.success).toBe(true);
        expect(result.policyAccess.allowed).toBe(false);
      });

      test("multi-user map: a grant is judged on the current user's list only", async () => {
        const { policy, client } = setup();
        client.setCommandResult(currentUserCmd, "10\n");
        client.setCommandResult(allowCmd, "");
        client.setCommandResult(dumpsys, multiUser);

        const result = await policy.setPolicy("com.example.app", { policyAccess: true });

        expect(result.success).toBe(true);
        expect(result.policyAccess.allowed).toBe(true);
      });

      test("an unreadable current user makes a recognised map unverified, not a failure", async () => {
        const { policy, client } = setup();
        client.setCommandResult(currentUserCmd, "");
        client.setCommandResult(disallowCmd, "");
        client.setCommandResult(dumpsys, multiUser);

        const result = await policy.setPolicy("com.example.app", { policyAccess: false });

        expect(result.success).toBe(true);
        expect(result.policyAccess.allowed).toBeNull();
        expect(result.policyAccess.warning).toContain("not verified");
      });

      test("a map with no entry for the current user is unverified", async () => {
        const { policy, client } = setup();
        client.setCommandResult(allowCmd, "");
        client.setCommandResult(dumpsys, "  mPolicyAccess={10=[com.example.app]}\n");

        const result = await policy.setPolicy("com.example.app", { policyAccess: true });

        expect(result.success).toBe(true);
        expect(result.policyAccess.allowed).toBeNull();
      });

      test("an empty map means nobody holds access", async () => {
        const { policy, client } = setup();
        client.setCommandResult(disallowCmd, "");
        client.setCommandResult(dumpsys, "  mPolicyAccess={}\n");

        const result = await policy.setPolicy("com.example.app", { policyAccess: false });

        expect(result.success).toBe(true);
        expect(result.policyAccess.allowed).toBe(false);
        expect(client.wasCommandExecuted(currentUserCmd)).toBe(false);
      });

      test("a pkg/Component entry does not count as the package grant", async () => {
        const { policy, client } = setup();
        client.setCommandResult(disallowCmd, "");
        client.setCommandResult(
          dumpsys,
          "  mPolicyAccess={0=[com.example.app/com.example.app.Service]}\n",
        );

        const result = await policy.setPolicy("com.example.app", { policyAccess: false });

        expect(result.success).toBe(true);
        expect(result.policyAccess.allowed).toBeNull();
        expect(result.policyAccess.warning).toContain("component");
      });

      test("an exact package entry still wins next to a component entry", async () => {
        const result = await readWith(
          "  mPolicyAccess={0=[com.example.app/com.example.app.Service, com.example.app]}\n",
        );
        expect(result.policyAccess.allowed).toBe(true);
      });

      test("a package that merely shares a prefix is not the app", async () => {
        const result = await readWith(
          "  mPolicyAccess={0=[com.example.app2, com.example.app.x]}\n",
        );
        expect(result.policyAccess.allowed).toBe(false);
      });

      test("a stray earlier line that mentions policy access does not become the header", async () => {
        const result = await readWith(
          [
            "      tickerText=Do Not Disturb policy access",
            "      android.title=Do Not Disturb policy access",
            "  mPolicyAccess={0=[com.example.app]}",
            "",
          ].join("\n"),
        );
        expect(result.policyAccess.allowed).toBe(true);
      });

      test("two header-like lines are ambiguous and unverified", async () => {
        const result = await readWith(
          ["  Policy access needed for com.example.app", "  mPolicyAccess={0=[]}", ""].join("\n"),
        );
        expect(result.success).toBe(true);
        expect(result.policyAccess.allowed).toBeNull();
        expect(result.policyAccess.warning).toContain("several");
      });

      test("a label with the list on sibling lines is unverified, not a confident false", async () => {
        const result = await readWith("  Policy access:\n  com.example.app\n");
        expect(result.policyAccess.allowed).toBeNull();
        expect(result.policyAccess.warning).toContain("not in a recognised format");
      });

      test.each([
        "  mPolicyAccess=[com.example.app]\n",
        "  mPolicyAccess={0=[com.example.app]} trailing\n",
        "  mPolicyAccess={0=[a], 0=[com.example.app]}\n",
        "  mPolicyAccess={zero=[com.example.app]}\n",
      ])("unrecognised shape %j is unverified", async (output) => {
        const result = await readWith(output);
        expect(result.success).toBe(true);
        expect(result.policyAccess.allowed).toBeNull();
        expect(result.policyAccess.warning).toBeDefined();
      });
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
