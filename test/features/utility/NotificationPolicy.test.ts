import { describe, expect, test } from "bun:test";
import type { BootedDevice } from "../../../src/models";
import {
  NotificationPolicy,
  type NotificationPolicyAccessState,
} from "../../../src/features/utility/NotificationPolicy";
import type { IosNotificationAuthorizationReader } from "../../../src/features/utility/ios/IosNotificationAuthorizationReader";
import type { FakeAdbClient } from "../../fakes/FakeAdbClient";
import { FakeAdbClientFactory } from "../../fakes/FakeAdbClientFactory";
import {
  CAPTURE_EMULATORS,
  CAPTURED_APP_ID,
  dumpsysNotificationFromCapture,
  readNotificationPolicyCaptureFile,
} from "../../helpers/notificationPolicyCapture";

const androidDevice: BootedDevice = {
  name: "Pixel",
  platform: "android",
  deviceId: "emulator-5554",
};

const currentUserCmd = "shell am get-current-user";
const dumpsys = "shell dumpsys notification";
const allowCmd = `shell cmd notification allow_dnd '${CAPTURED_APP_ID}'`;
const disallowCmd = `shell cmd notification disallow_dnd '${CAPTURED_APP_ID}'`;

function setup(userId = "0\n"): { policy: NotificationPolicy; client: FakeAdbClient } {
  const adbFactory = new FakeAdbClientFactory();
  const client = adbFactory.getFakeClient();
  client.setCommandResult(currentUserCmd, userId);
  return { policy: new NotificationPolicy(androidDevice, { adbFactory }), client };
}

async function readWith(dumpsysOutput: string, appId = CAPTURED_APP_ID, userId = "0\n") {
  const { policy, client } = setup(userId);
  client.setCommandResult(dumpsys, dumpsysOutput);
  return policy.getPolicy(appId);
}

/** Edit a captured dump; throws when the edit would not change anything (no silent no-ops). */
function edit(text: string, from: string, to: string): string {
  if (!text.includes(from)) {
    throw new Error(`capture does not contain ${from}`);
  }
  return text.replace(from, to);
}

const primaryLineTail = "com.google.android.GoogleCamera (user: 0 isPrimary: true)";
const otherLineTail = "com.google.android.apps.nexuslauncher (user: 0 isPrimary: false)";

describe("NotificationPolicy", () => {
  describe.each(CAPTURE_EMULATORS)("captured API 36 dumpsys on %s", (emulator) => {
    const before = dumpsysNotificationFromCapture("before", emulator);
    const afterAllow = dumpsysNotificationFromCapture("after-allow", emulator);
    const afterDisallow = dumpsysNotificationFromCapture("after-disallow", emulator);

    test("the captured files carry no mPolicyAccess line, the premise of this parser", () => {
      for (const step of ["before", "after-allow", "after-disallow"] as const) {
        expect(readNotificationPolicyCaptureFile(step, emulator)).not.toContain("mPolicyAccess=");
      }
    });

    test("before the grant the app is not allowed", async () => {
      const result = await readWith(before);
      expect(result.success).toBe(true);
      expect(result.policyAccess).toMatchObject({
        supported: true,
        allowed: false,
        method: "android_dumpsys_notification",
      });
      expect(result.policyAccess.warning).toBeUndefined();
    });

    test("after allow_dnd the app is allowed", async () => {
      const result = await readWith(afterAllow);
      expect(result.success).toBe(true);
      expect(result.policyAccess).toMatchObject({ supported: true, allowed: true });
      expect(result.policyAccess.warning).toBeUndefined();
    });

    test("after disallow_dnd the app is not allowed again", async () => {
      const result = await readWith(afterDisallow);
      expect(result.success).toBe(true);
      expect(result.policyAccess).toMatchObject({ supported: true, allowed: false });
    });

    test("after disallow_dnd the capture is byte-identical to the one before the grant", () => {
      expect(afterDisallow).toBe(before);
    });

    test("setPolicy(true) reports the observed grant from the read-back", async () => {
      const { policy, client } = setup();
      client.setCommandResult(allowCmd, "");
      client.setCommandResult(dumpsys, afterAllow);

      const result = await policy.setPolicy(CAPTURED_APP_ID, { policyAccess: true });

      expect(result.success).toBe(true);
      expect(result.policyAccess).toMatchObject({
        allowed: true,
        method: "android_dumpsys_notification",
      });
      expect(result.policyAccess.warning).toBeUndefined();
      expect(client.getAllCommands()).toEqual([allowCmd, dumpsys, currentUserCmd]);
    });

    test("setPolicy(false) reports the observed revoke from the read-back", async () => {
      const { policy, client } = setup();
      client.setCommandResult(disallowCmd, "");
      client.setCommandResult(dumpsys, afterDisallow);

      const result = await policy.setPolicy(CAPTURED_APP_ID, { policyAccess: false });

      expect(result.success).toBe(true);
      expect(result.policyAccess).toMatchObject({ allowed: false });
    });

    test("a grant whose read-back is the pre-grant dump is a failure with allowed false", async () => {
      const { policy, client } = setup();
      client.setCommandResult(allowCmd, "");
      client.setCommandResult(dumpsys, before);

      const result = await policy.setPolicy(CAPTURED_APP_ID, { policyAccess: true });

      expect(result.success).toBe(false);
      expect(result.policyAccess.allowed).toBe(false);
      expect(result.error).toContain("not granted");
    });

    test("a revoke whose read-back is the post-grant dump is a mismatch failure", async () => {
      const { policy, client } = setup();
      client.setCommandResult(disallowCmd, "");
      client.setCommandResult(dumpsys, afterAllow);

      const result = await policy.setPolicy(CAPTURED_APP_ID, { policyAccess: false });

      expect(result.success).toBe(false);
      expect(result.policyAccess.allowed).toBe(true);
      expect(result.error).toContain("still granted");
    });

    test("a revoke whose command errored and whose read-back still shows the grant is a failure", async () => {
      const { policy, client } = setup();
      client.setCommandResult(disallowCmd, "", "Error: Exception occurred while executing");
      client.setCommandResult(dumpsys, afterAllow);

      const result = await policy.setPolicy(CAPTURED_APP_ID, { policyAccess: false });

      expect(result.success).toBe(false);
      expect(result.error).toContain("Exception occurred");
      expect(result.policyAccess.allowed).toBe(true);
    });

    test("a failing disallow_dnd whose read-back shows no grant is a success with a warning", async () => {
      const { policy, client } = setup();
      client.setCommandResult(disallowCmd, "", "Error: package not found");
      client.setCommandResult(dumpsys, afterDisallow);

      const result = await policy.setPolicy(CAPTURED_APP_ID, { policyAccess: false });

      expect(result.success).toBe(true);
      expect(result.policyAccess.allowed).toBe(false);
      expect(result.policyAccess.warning).toContain("package not found");
    });

    test("a failing allow_dnd whose read-back already shows the grant is a success with a warning", async () => {
      const { policy, client } = setup();
      client.setCommandResult(allowCmd, "", "Error: already allowed");
      client.setCommandResult(dumpsys, afterAllow);

      const result = await policy.setPolicy(CAPTURED_APP_ID, { policyAccess: true });

      expect(result.success).toBe(true);
      expect(result.policyAccess.warning).toContain("already allowed");
    });

    test("the Has user set block is not a grant: it names the app even before allow_dnd", async () => {
      // Real behaviour in every capture: the app is under `Has user set:` before the grant and
      // after the revoke, yet the allowed list (and so the grant) says false.
      const hasUserSet = before
        .split("\n")
        .find((line) => line.trimStart().startsWith("userId=0 value="));
      expect(hasUserSet).toContain(CAPTURED_APP_ID);
      const result = await readWith(before);
      expect(result.policyAccess.allowed).toBe(false);
    });

    test("a package that merely shares a prefix with the allowed one is not the app", async () => {
      const result = await readWith(afterAllow, "dev.jasonpearson.automobile");
      expect(result.policyAccess.allowed).toBe(false);
    });

    test("an app granted only in a different Android user is unverified for the current one", async () => {
      const result = await readWith(afterAllow, CAPTURED_APP_ID, "7\n");
      expect(result.success).toBe(true);
      expect(result.policyAccess.allowed).toBeNull();
      expect(result.policyAccess.warning).toContain("user 7");
    });

    test("an unreadable current user makes the dump unverified, not a failure", async () => {
      const result = await readWith(afterAllow, CAPTURED_APP_ID, "");
      expect(result.success).toBe(true);
      expect(result.policyAccess.allowed).toBeNull();
      expect(result.policyAccess.warning).toBeDefined();
    });

    describe("synthetic variants (derived from the capture by one edit; no device produced these)", () => {
      test("a pkg/Component entry does not count as the package grant", async () => {
        const dump = edit(
          before,
          primaryLineTail,
          `${CAPTURED_APP_ID}/com.example.Service:${primaryLineTail}`,
        );
        const result = await readWith(dump);
        expect(result.policyAccess.allowed).toBeNull();
        expect(result.policyAccess.warning).toContain("does not conclusively list");
      });

      test("an exact package entry still wins next to a component entry", async () => {
        const dump = edit(
          afterAllow,
          primaryLineTail,
          `${CAPTURED_APP_ID}/com.example.Service:${primaryLineTail}`,
        );
        expect((await readWith(dump)).policyAccess.allowed).toBe(true);
      });

      test("a bare package only in the non-primary list is unverified", async () => {
        const dump = edit(before, otherLineTail, `${CAPTURED_APP_ID}:${otherLineTail}`);
        expect((await readWith(dump)).policyAccess.allowed).toBeNull();
      });

      test("an empty primary list for the user means the app is not allowed", async () => {
        const primaryLine =
          /^ +com\.google\.android\.apps\.diagnosticstool:.*\(user: 0 isPrimary: true\)$/m;
        expect(primaryLine.test(before)).toBe(true);
        const dump = before.replace(primaryLine, "       (user: 0 isPrimary: true)");
        expect((await readWith(dump)).policyAccess.allowed).toBe(false);
      });

      test("a user with only a non-primary list is unverified", async () => {
        const dump = edit(
          before,
          `${primaryLineTail}\n`,
          `${primaryLineTail.replace("user: 0", "user: 3")}\n`,
        );
        const result = await readWith(dump);
        expect(result.policyAccess.allowed).toBeNull();
      });

      test("another user's list is not the current user's list", async () => {
        const otherUser = `      ${CAPTURED_APP_ID} (user: 10 isPrimary: true)\n`;
        const dump = edit(before, `${otherLineTail}\n`, `${otherLineTail}\n${otherUser}`);
        expect((await readWith(dump, CAPTURED_APP_ID, "0\n")).policyAccess.allowed).toBe(false);
        expect((await readWith(dump, CAPTURED_APP_ID, "10\n")).policyAccess.allowed).toBe(true);
      });

      test("a repeated primary list for one user is ambiguous and unverified", async () => {
        const dump = edit(
          before,
          `${otherLineTail}\n`,
          `${otherLineTail}\n      x (user: 0 isPrimary: true)\n`,
        );
        const result = await readWith(dump);
        expect(result.success).toBe(true);
        expect(result.policyAccess.allowed).toBeNull();
        expect(result.policyAccess.warning).toContain("repeats");
      });

      test("two allowed condition providers sections are ambiguous and unverified", async () => {
        const result = await readWith(`${before}\n${afterAllow}`);
        expect(result.success).toBe(true);
        expect(result.policyAccess.allowed).toBeNull();
        expect(result.policyAccess.warning).toContain("several");
      });

      test("the header with no recognised list line is unverified", async () => {
        const lines = before.split("\n");
        const header = lines.findIndex((line) => line.includes("Allowed condition providers:"));
        const result = await readWith(
          `${lines.slice(0, header + 1).join("\n")}\n    Has user set:\n`,
        );
        expect(result.policyAccess.allowed).toBeNull();
        expect(result.policyAccess.warning).toContain("no recognised entries");
      });
    });
  });

  describe("unrecognised output stays unverified, never a failure", () => {
    test.each([
      "",
      "NotificationManagerService state\n",
      "  mPolicyAccess={0=[dev.jasonpearson.automobile.playground]}\n",
    ])("%j reports allowed null with a warning", async (output) => {
      const result = await readWith(output);
      expect(result.success).toBe(true);
      expect(result.policyAccess.allowed).toBeNull();
      expect(result.policyAccess.warning).toContain("Could not find");
    });

    test("an unparseable read-back after a set keeps success but reports allowed null", async () => {
      const { policy, client } = setup();
      client.setCommandResult(disallowCmd, "");
      client.setCommandResult(dumpsys, "NotificationManagerService state\n");

      const result = await policy.setPolicy(CAPTURED_APP_ID, { policyAccess: false });

      expect(result.success).toBe(true);
      expect(result.policyAccess.allowed).toBeNull();
      expect(result.policyAccess.warning).toContain("not verified");
    });

    test("a failing command with an unverified read-back stays a failure", async () => {
      const { policy, client } = setup();
      client.setCommandResult(disallowCmd, "", "Error: boom");
      client.setCommandResult(dumpsys, "nothing recognisable\n");

      const result = await policy.setPolicy(CAPTURED_APP_ID, { policyAccess: false });

      expect(result.success).toBe(false);
      expect(result.error).toContain("boom");
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
