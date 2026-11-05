import { beforeEach, describe, expect, test } from "bun:test";
import { PostNotification } from "../../../src/features/utility/PostNotification";
import type { BootedDevice } from "../../../src/models";
import { FakeSimctl } from "../../fakes/FakeSimctl";

const WATCH_UDID = "11111111-2222-3333-4444-555555555555";
const BUNDLE_ID = "com.example.App.watchkitapp";

describe("PostNotification - watchOS simulator", () => {
  let simctl: FakeSimctl;

  beforeEach(() => {
    simctl = new FakeSimctl();
  });

  const make = (deviceId = WATCH_UDID) => {
    const device: BootedDevice = { name: "Watch", deviceId, platform: "watchos" };
    return new PostNotification(device, { simctl });
  };
  const pushCalls = () => simctl.getMethodCalls("pushNotification");

  test("delivers the exact APNs payload to the watch UDID and bundle", async () => {
    const result = await make().execute({
      title: "Hello",
      body: "World",
      appId: BUNDLE_ID,
      channelId: "legacy",
      category: "reply",
      payload: { orderId: "A-1", aps: { "thread-id": "orders" } },
    });

    expect(result).toEqual({
      success: true,
      supported: true,
      method: "simctlPush",
      appId: BUNDLE_ID,
      channelId: "legacy",
      warning: undefined,
    });
    expect(pushCalls()).toEqual([
      expect.objectContaining({
        deviceId: WATCH_UDID,
        bundleId: BUNDLE_ID,
        payloadJson: JSON.stringify({
          orderId: "A-1",
          aps: {
            alert: { title: "Hello", body: "World" },
            sound: "default",
            category: "reply",
            "thread-id": "orders",
          },
          "Simulator Target Bundle": BUNDLE_ID,
        }),
      }),
    ]);
  });

  test("requires appId before pushing", async () => {
    const result = await make().execute({ title: "T", body: "B" });
    expect(result.success).toBe(false);
    expect(result.supported).toBe(false);
    expect(result.error).toBe(
      "appId (bundle identifier) is required to post a notification on watchOS.",
    );
    expect(pushCalls()).toHaveLength(0);
  });

  test("refuses a physical watch UDID before pushing", async () => {
    const result = await make("00008030001A2B3C4D5E6F7089ABCDEF01234567").execute({
      title: "T",
      body: "B",
      appId: BUNDLE_ID,
    });
    expect(result.success).toBe(false);
    expect(result.supported).toBe(false);
    expect(result.error).toContain("only supported on simulators (simctl push)");
    expect(result.error).toContain("physical watchOS devices");
    expect(pushCalls()).toHaveLength(0);
  });

  test("refuses an oversized payload before pushing", async () => {
    const result = await make().execute({ title: "T", body: "x".repeat(5000), appId: BUNDLE_ID });
    expect(result.success).toBe(false);
    expect(result.supported).toBe(true);
    expect(result.error).toContain("4096");
    expect(pushCalls()).toHaveLength(0);
  });

  test("forwards payload warnings and channelId category fallback", async () => {
    const result = await make().execute({
      title: "T",
      body: "B",
      appId: BUNDLE_ID,
      channelId: "messages",
      imageType: "bigPicture",
      actions: [{ label: "Open", actionId: "open" }],
    });
    expect(result.success).toBe(true);
    expect(result.warning).toBe(
      "bigPicture needs imagePath; no image was sent. actions were ignored: iOS buttons come from the UNNotificationCategory the app registered for the category.",
    );
    expect(String(pushCalls()[0].payloadJson)).toContain('"category":"messages"');
  });

  test("preserves simctl failures", async () => {
    simctl.setPushNotificationResult({ success: false, error: "No such device" });
    const result = await make().execute({ title: "T", body: "B", appId: BUNDLE_ID });
    expect(result).toEqual({
      success: false,
      supported: true,
      appId: BUNDLE_ID,
      error: "No such device",
      warning: undefined,
    });
    expect(pushCalls()).toHaveLength(1);
  });
});
