import { describe, expect, test } from "bun:test";
import { IosOverlayTransport } from "../../../../src/features/overlay/ios/iosOverlayTransport";
import type {
  OverlayAgentClient,
  OverlayAgentMessage,
  OverlayAgentRequestType,
  OverlayAgentResult,
} from "../../../../src/features/overlay/ios/overlayAgentClient";

function fakeAgent(
  capabilities: string[],
  calls: string[],
  reply: (type: OverlayAgentRequestType) => Partial<OverlayAgentResult> | Error = () => ({
    success: true,
  }),
): OverlayAgentClient {
  return {
    handshake: { agentVersion: "t", protocolVersion: 1, capabilities },
    async request(type: OverlayAgentRequestType, body?: OverlayAgentMessage) {
      calls.push(body?.deadlineMs !== undefined ? `${type}:${body.deadlineMs}` : type);
      const out = reply(type);
      if (out instanceof Error) {
        throw out;
      }
      return { type: "overlay_result", requestId: "1", success: true, ...out };
    },
    onEvent: () => () => {},
    onClosed: () => () => {},
    close: () => {},
  };
}

const CAPS = ["hide_for_capture", "restore_after_capture", "screenshot_hide_overlay_v1"];

describe("IosOverlayTransport.captureWithOverlayHidden", () => {
  test("hides, captures, then restores, and reports the overlay absent", async () => {
    const calls: string[] = [];
    const transport = new IosOverlayTransport(fakeAgent(CAPS, calls));
    const result = await transport.captureWithOverlayHidden(async () => {
      calls.push("capture");
      return "png";
    }, 900);
    expect(calls).toEqual(["hide_for_capture:900", "capture", "restore_after_capture"]);
    expect(result).toEqual({ value: "png", screenshotIncludesOverlay: false });
  });

  test("restores even when the capture throws", async () => {
    const calls: string[] = [];
    const transport = new IosOverlayTransport(fakeAgent(CAPS, calls));
    await expect(
      transport.captureWithOverlayHidden(async () => {
        calls.push("capture");
        throw new Error("simctl failed");
      }),
    ).rejects.toThrow("simctl failed");
    expect(calls).toEqual(["hide_for_capture:1500", "capture", "restore_after_capture"]);
  });

  test("without the capability it only captures and flags the overlay as present", async () => {
    const calls: string[] = [];
    const transport = new IosOverlayTransport(fakeAgent(["show_overlay"], calls));
    const result = await transport.captureWithOverlayHidden(async () => "png");
    expect(calls).toEqual([]);
    expect(result).toEqual({
      value: "png",
      screenshotIncludesOverlay: true,
      hideUnconfirmed: true,
    });
  });

  test("a failed hide still captures, skips restore, and flags the overlay as present", async () => {
    const calls: string[] = [];
    const transport = new IosOverlayTransport(
      fakeAgent(CAPS, calls, (type) =>
        type === "hide_for_capture" ? new Error("no answer") : { success: true },
      ),
    );
    const result = await transport.captureWithOverlayHidden(async () => {
      calls.push("capture");
      return "png";
    });
    expect(calls).toEqual(["hide_for_capture:1500", "capture"]);
    expect(result.screenshotIncludesOverlay).toBe(true);
    expect(result.hideUnconfirmed).toBe(true);
  });

  test("a hide that found nothing visible is not claimed as hidden", async () => {
    const calls: string[] = [];
    const transport = new IosOverlayTransport(
      fakeAgent(CAPS, calls, () => ({ success: true, hidden: false })),
    );
    const result = await transport.captureWithOverlayHidden(async () => "png");
    expect(result.screenshotIncludesOverlay).toBe(true);
    expect(result.hideUnconfirmed).toBeUndefined();
  });

  test("a lost restore is tolerated", async () => {
    const calls: string[] = [];
    const transport = new IosOverlayTransport(
      fakeAgent(CAPS, calls, (type) =>
        type === "restore_after_capture" ? new Error("closed") : { success: true },
      ),
    );
    const result = await transport.captureWithOverlayHidden(async () => "png");
    expect(result).toEqual({ value: "png", screenshotIncludesOverlay: false });
  });
});
