import { describe, expect, test } from "bun:test";
import type { BootedDevice } from "../../../src/models";
import { NotificationPolicy } from "../../../src/features/utility/NotificationPolicy";
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
      "  mPolicyAccess={0=[com.example.app, com.other.app]}\n"
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
    client.setCommandResult(
      "shell dumpsys notification",
      "  mPolicyAccess={0=[com.other.app]}\n"
    );

    const notificationPolicy = new NotificationPolicy(androidDevice, { adbFactory });
    const result = await notificationPolicy.getPolicy("com.example.app");

    expect(result.success).toBe(true);
    expect(result.policyAccess.allowed).toBe(false);
  });

  test("sets Android notification policy access through cmd notification", async () => {
    const adbFactory = new FakeAdbClientFactory();
    const client = adbFactory.getFakeClient();
    client.setCommandResult("shell cmd notification allow_dnd com.example.app", "");

    const notificationPolicy = new NotificationPolicy(androidDevice, { adbFactory });
    const result = await notificationPolicy.setPolicy("com.example.app", {
      policyAccess: true,
    });

    expect(result.success).toBe(true);
    expect(result.policyAccess).toMatchObject({
      supported: true,
      allowed: true,
      method: "android_cmd_notification",
    });
    expect(client.wasCommandExecuted("shell cmd notification allow_dnd com.example.app")).toBe(true);
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
});
