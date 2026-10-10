import { describe, expect, test } from "bun:test";
import WebSocket from "ws";
import { AndroidCtrlProxyClient } from "../../../../src/features/observe/android";
import type { ScreenshotResult } from "../../../../src/features/observe/android/types";
import {
  ANDROID_CAPABILITY_FLAGS,
  ANDROID_FULL_COMMAND_SET_CAPABILITY,
  ctrlProxyRequests,
  KNOWN_REQUEST_TYPES,
  SCREENSHOT_HIDE_PROTOTYPE_CAPABILITY,
  serializeCtrlProxyRequest,
} from "../../../../src/features/observe/android/ctrlProxyProtocol";
import type { BootedDevice } from "../../../../src/models";
import { FakeAdbExecutor } from "../../../fakes/FakeAdbExecutor";
import { FakeScreenshotBackoffScheduler } from "../../../fakes/FakeScreenshotBackoffScheduler";
import { FakeTimer } from "../../../fakes/FakeTimer";
import { FakeWebSocket } from "../../../fakes/FakeWebSocket";

const device: BootedDevice = {
  deviceId: "screenshot-hide-prototype",
  platform: "android",
  isEmulator: true,
  name: "Android",
};

/** A client whose socket only records frames; the handshake is set per test. */
function clientWithCapturedFrames(supportedCommands?: readonly string[]) {
  const timer = new FakeTimer();
  const adb = new FakeAdbExecutor();
  AndroidCtrlProxyClient.resetInstances();
  const client = AndroidCtrlProxyClient.createForTesting(
    device,
    adb,
    (url) => new FakeWebSocket(url, "none", 0, timer) as unknown as WebSocket,
    timer,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    new FakeScreenshotBackoffScheduler(),
  );
  const frames: Record<string, unknown>[] = [];
  client["ws"] = {
    readyState: WebSocket.OPEN,
    send: (data: string) => frames.push(JSON.parse(data) as Record<string, unknown>),
  } as unknown as WebSocket;
  // The handshake itself sends set_hierarchy_interval; only screenshot frames matter here.
  const sent = {
    get frames() {
      return frames.filter((frame) => frame.type === "request_screenshot");
    },
  };
  if (supportedCommands) {
    client["webSocketMessageHandlers"].connected({ type: "connected", supportedCommands });
  }
  return { client, sent };
}

const fullAdvertisement = [
  ...KNOWN_REQUEST_TYPES,
  ...ANDROID_CAPABILITY_FLAGS,
  ANDROID_FULL_COMMAND_SET_CAPABILITY,
];

describe("request_screenshot hidePrototypes (#9305)", () => {
  test("the builder sends hidePrototypes only when set", () => {
    expect(
      serializeCtrlProxyRequest(
        ctrlProxyRequests.requestScreenshot({ requestId: "s-1", hidePrototypes: true }),
      ),
    ).toBe('{"type":"request_screenshot","requestId":"s-1","hidePrototypes":true}');
    expect(
      serializeCtrlProxyRequest(
        ctrlProxyRequests.requestScreenshot({ requestId: "s-1", hidePrototypes: false }),
      ),
    ).toBe('{"type":"request_screenshot","requestId":"s-1"}');
  });

  test("the capability is a handshake flag shared by name with the iOS agent", () => {
    expect(SCREENSHOT_HIDE_PROTOTYPE_CAPABILITY).toBe("screenshot_hide_prototype_v1");
    expect(ANDROID_CAPABILITY_FLAGS).toContain(SCREENSHOT_HIDE_PROTOTYPE_CAPABILITY);
  });

  test("a device advertising the capability receives the flag", async () => {
    const { client, sent } = clientWithCapturedFrames(fullAdvertisement);
    await client["dispatchScreenshotRequest"]("s-1", undefined, 2, true);
    expect(sent.frames).toEqual([
      { type: "request_screenshot", requestId: "s-1", displayId: 2, hidePrototypes: true },
    ]);
  });

  test.each([
    [
      "a full advertisement without the capability",
      fullAdvertisement.filter((name) => name !== SCREENSHOT_HIDE_PROTOTYPE_CAPABILITY),
    ],
    ["a legacy advertisement", ["set_hierarchy_interval"]],
    ["no handshake yet", undefined],
  ])("%s never receives the flag", async (_, advertisement) => {
    const { client, sent } = clientWithCapturedFrames(advertisement);
    await client["dispatchScreenshotRequest"]("s-1", undefined, undefined, true);
    expect(sent.frames).toEqual([{ type: "request_screenshot", requestId: "s-1" }]);
  });

  test("a capture without hiding never sends the flag", async () => {
    const { client, sent } = clientWithCapturedFrames(fullAdvertisement);
    await client["dispatchScreenshotRequest"]("s-1");
    expect(sent.frames).toEqual([{ type: "request_screenshot", requestId: "s-1" }]);
  });

  test.each([
    [true, true],
    [false, false],
    [undefined, undefined],
  ])("a reply with prototypesHidden=%p resolves prototypesHidden=%p", async (wire, expected) => {
    const { client } = clientWithCapturedFrames(fullAdvertisement);
    const pending = client["requestManager"].register<ScreenshotResult>(
      "s-1",
      "screenshot",
      1000,
      () => ({ success: false, error: "timeout" }),
    );
    client["screenshotObservationStreamSuppressions"].add("s-1");
    client["webSocketMessageHandlers"].screenshot({
      type: "screenshot",
      requestId: "s-1",
      data: "jpeg-base64",
      format: "jpeg",
      timestamp: 1,
      ...(wire === undefined ? {} : { prototypesHidden: wire }),
    });
    const result = await pending;
    expect(result.success).toBe(true);
    expect(result.prototypesHidden).toBe(expected);
  });
});
