import { expect, describe, test, beforeEach } from "bun:test";
import { PostNotification } from "../../../src/features/utility/PostNotification";
import { BootedDevice } from "../../../src/models";
import { FakeSimCtlClient } from "../../fakes/FakeSimCtlClient";

const SIM_UDID = "11111111-2222-3333-4444-555555555555";
const PHYSICAL_UDID = "00008030001A2B3C4D5E6F7089ABCDEF01234567";

describe("PostNotification - iOS Simulator", () => {
  let simctl: FakeSimCtlClient;

  const makeDevice = (deviceId: string): BootedDevice =>
    ({ deviceId, platform: "ios" }) as BootedDevice;

  const make = (deviceId: string) =>
    new PostNotification(makeDevice(deviceId), null, null, simctl as any);

  const pushCalls = () => simctl.getMethodCalls("pushNotification");

  beforeEach(() => {
    simctl = new FakeSimCtlClient();
  });

  test("posts via simctl push on a simulator with appId", async () => {
    const result = await make(SIM_UDID).execute({
      title: "Hello",
      body: "World",
      appId: "com.example.App",
    });

    expect(result.success).toBe(true);
    expect(result.supported).toBe(true);
    expect(result.method).toBe("simctlPush");
    expect(result.appId).toBe("com.example.App");

    expect(pushCalls()).toHaveLength(1);
    const call = pushCalls()[0];
    expect(call.deviceId).toBe(SIM_UDID);
    expect(call.bundleId).toBe("com.example.App");
    const payload = JSON.parse(String(call.payloadJson));
    expect(payload["Simulator Target Bundle"]).toBe("com.example.App");
    expect(payload.aps.alert).toEqual({ title: "Hello", body: "World" });
  });

  test("channelId maps to APNs category", async () => {
    await make(SIM_UDID).execute({ title: "t", body: "b", appId: "com.x", channelId: "messages" });
    const payload = JSON.parse(String(pushCalls()[0].payloadJson));
    expect(payload.aps.category).toBe("messages");
  });

  test("missing appId fails with no shell call", async () => {
    const result = await make(SIM_UDID).execute({ title: "t", body: "b" });
    expect(result.success).toBe(false);
    expect(result.supported).toBe(false);
    expect(result.error).toContain("appId");
    expect(pushCalls()).toHaveLength(0);
  });

  test("physical iOS device is unsupported with no shell call", async () => {
    const result = await make(PHYSICAL_UDID).execute({ title: "t", body: "b", appId: "com.x" });
    expect(result.success).toBe(false);
    expect(result.supported).toBe(false);
    expect(result.error).toContain("physical iOS devices");
    expect(pushCalls()).toHaveLength(0);
  });

  test("bigPicture/imagePath are ignored with a warning (still succeeds)", async () => {
    const result = await make(SIM_UDID).execute({
      title: "t",
      body: "b",
      appId: "com.x",
      imageType: "bigPicture",
      imagePath: "/tmp/x.png",
    });
    expect(result.success).toBe(true);
    expect(result.warning).toContain("bigPicture");
    expect(pushCalls()).toHaveLength(1);
  });

  test("action buttons are ignored with a warning", async () => {
    const result = await make(SIM_UDID).execute({
      title: "t",
      body: "b",
      appId: "com.x",
      actions: [{ label: "Open", actionId: "open" }],
    });
    expect(result.success).toBe(true);
    expect(result.warning).toContain("action buttons");
  });

  test("oversized payload is rejected before invoking simctl", async () => {
    const result = await make(SIM_UDID).execute({
      title: "t",
      body: "x".repeat(5000),
      appId: "com.x",
    });
    expect(result.success).toBe(false);
    expect(result.error).toContain("4096");
    expect(pushCalls()).toHaveLength(0);
  });

  test("simctl push failure surfaces as supported failure", async () => {
    simctl.setPushNotificationResult({ success: false, error: "No such device" });
    const result = await make(SIM_UDID).execute({ title: "t", body: "b", appId: "com.x" });
    expect(result.success).toBe(false);
    expect(result.supported).toBe(true);
    expect(result.error).toContain("No such device");
  });
});
