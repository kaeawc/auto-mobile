import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { TakeScreenshot } from "../../../src/features/observe/TakeScreenshot";
import { IOSCtrlProxyClient } from "../../../src/features/observe/ios";
import {
  iosAgentHidesOverlayForCapture,
  overlayHiderFromConnections,
} from "../../../src/features/overlay/ios/iosCaptureOverlayHider";
import { SCREENSHOT_HIDE_OVERLAY_CAPABILITY } from "../../../src/features/overlay/ios/iosOverlayTransport";
import type { OverlayAgentClient } from "../../../src/features/overlay/ios/overlayAgentClient";
import { FakeAdbClientFactory } from "../../fakes/FakeAdbClientFactory";
import { FakeAdbExecutor } from "../../fakes/FakeAdbExecutor";
import { FakeOverlayAgentClient } from "../../fakes/FakeOverlayAgentClient";
import { FakeScreenshotFileWriter } from "../../fakes/FakeScreenshotFileWriter";
import { FakeTimer } from "../../fakes/FakeTimer";
import { CountingIdGenerator } from "../../../src/utils/IdGenerator";
import { iosDevice } from "./takeScreenshotTestHelpers";

// A 1x1-header PNG: enough for the header-size read and the unencoded PNG path.
const PNG = Buffer.alloc(24);
Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(PNG, 0);
PNG.writeUInt32BE(13, 8);
PNG.write("IHDR", 12, "ascii");
PNG.writeUInt32BE(320, 16);
PNG.writeUInt32BE(640, 20);

const DEVICE_ID = "ios-hide-overlay";

function agent(capabilities: string[]): FakeOverlayAgentClient {
  return new FakeOverlayAgentClient({ agentVersion: "t", protocolVersion: 1, capabilities });
}

const HIDE_CAPS = ["hide_for_capture", "restore_after_capture", SCREENSHOT_HIDE_OVERLAY_CAPABILITY];

describe("iOS screenshot with the overlay hidden (#9305)", () => {
  const originalGetInstance = IOSCtrlProxyClient.getInstance;
  let captures: string[];
  let captureFails: boolean;

  beforeEach(() => {
    captures = [];
    captureFails = false;
    IOSCtrlProxyClient.getInstance = (() => ({
      ensureConnected: async () => true,
      requestScreenshot: async () => {
        captures.push("capture");
        if (captureFails) {
          throw new Error("simctl screenshot failed");
        }
        return { success: true, data: PNG.toString("base64") };
      },
    })) as typeof IOSCtrlProxyClient.getInstance;
  });

  afterEach(() => {
    IOSCtrlProxyClient.getInstance = originalGetInstance;
  });

  function screenshotWith(client: OverlayAgentClient | undefined): TakeScreenshot {
    return new TakeScreenshot(
      iosDevice(DEVICE_ID),
      new FakeAdbClientFactory(new FakeAdbExecutor()),
      new FakeTimer(),
      new CountingIdGenerator("capture"),
      new FakeScreenshotFileWriter(),
      undefined,
      undefined,
      undefined,
      false,
      { iosOverlayHider: overlayHiderFromConnections({ get: () => client }) },
    );
  }

  test("capability present: hides around the capture, restores, and reports the overlay hidden", async () => {
    const overlay = agent(HIDE_CAPS);
    const result = await screenshotWith(overlay).execute({ format: "png", hideOverlays: true });

    expect(result.success).toBe(true);
    expect(result.overlaysHidden).toBe(true);
    expect(overlay.requests.map((request) => request.type)).toEqual([
      "hide_for_capture",
      "restore_after_capture",
    ]);
    expect(captures).toEqual(["capture"]);
  });

  test("a hide that found nothing visible still returns the image as hidden", async () => {
    const overlay = agent(HIDE_CAPS);
    overlay.queueReplies({ hidden: false });
    const result = await screenshotWith(overlay).execute({ format: "png", hideOverlays: true });

    expect(result.success).toBe(true);
    expect(result.overlaysHidden).toBe(true);
  });

  test("hideOverlays not requested: the agent is never asked", async () => {
    const overlay = agent(HIDE_CAPS);
    const result = await screenshotWith(overlay).execute({ format: "png" });

    expect(result.success).toBe(true);
    expect(result.overlaysHidden).toBeUndefined();
    expect(overlay.requests).toEqual([]);
  });

  test("capture throws: the restore is still sent and the failure is reported", async () => {
    captureFails = true;
    const overlay = agent(HIDE_CAPS);
    const result = await screenshotWith(overlay).execute({ format: "png", hideOverlays: true });

    expect(result.success).toBe(false);
    expect(result.error).toContain("simctl screenshot failed");
    expect(overlay.requests.map((request) => request.type)).toEqual([
      "hide_for_capture",
      "restore_after_capture",
    ]);
  });

  test("a hide the agent never confirmed fails the capture instead of showing the overlay", async () => {
    const overlay = agent(HIDE_CAPS);
    overlay.queueReplies(new Error("no answer"));
    const result = await screenshotWith(overlay).execute({ format: "png", hideOverlays: true });

    expect(result.success).toBe(false);
    expect(result.error).toContain("could not confirm");
    expect(result.overlaysHidden).toBeUndefined();
  });

  test("agent gone by capture time fails rather than capturing the overlay", async () => {
    const result = await screenshotWith(undefined).execute({ format: "png", hideOverlays: true });

    expect(result.success).toBe(false);
    expect(result.error).toContain("no longer connected");
    expect(captures).toEqual([]);
  });
});

describe("iosAgentHidesOverlayForCapture (#9305)", () => {
  const resolverFor = (client: OverlayAgentClient | undefined) =>
    overlayHiderFromConnections({ get: () => client });

  test("true only for a connected agent advertising the capability", () => {
    expect(iosAgentHidesOverlayForCapture(DEVICE_ID, resolverFor(agent(HIDE_CAPS)))).toBe(true);
  });

  test("false when the agent does not advertise it", () => {
    expect(iosAgentHidesOverlayForCapture(DEVICE_ID, resolverFor(agent(["show_overlay"])))).toBe(
      false,
    );
  });

  test("false when no agent is connected", () => {
    expect(iosAgentHidesOverlayForCapture(DEVICE_ID, resolverFor(undefined))).toBe(false);
  });
});
