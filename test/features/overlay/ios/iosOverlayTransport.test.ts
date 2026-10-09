import { describe, expect, test } from "bun:test";
import {
  captureHideDeadlineMs,
  IosOverlayTransport,
} from "../../../../src/features/overlay/ios/iosOverlayTransport";
import type {
  OverlayAgentClient,
  OverlayAgentMessage,
  OverlayAgentRequestType,
  OverlayAgentResult,
} from "../../../../src/features/overlay/ios/overlayAgentClient";

function fakeAgent(
  capabilities: string[],
  calls: string[],
  reply: (type: OverlayAgentRequestType) => Partial<OverlayAgentResult> | Error = (type) => ({
    success: true,
    ...(type === "restore_after_capture" ? { restored: true } : {}),
  }),
): OverlayAgentClient {
  return {
    handshake: { agentVersion: "t", protocolVersion: 1, capabilities },
    async request(type: OverlayAgentRequestType, body?: OverlayAgentMessage) {
      calls.push(
        body?.deadlineMs !== undefined
          ? `${type}:${body.deadlineMs}`
          : body?.token !== undefined
            ? `${type}:token${body.token}`
            : type,
      );
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
      fakeAgent(CAPS, calls, (type) =>
        type === "restore_after_capture"
          ? { success: true, restored: true }
          : { success: true, hidden: false },
      ),
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
    expect(result.value).toBe("png");
    expect(result.hideUnconfirmed).toBe(true);
  });

  test("restored:false (the hold expired mid-capture) fails closed as hideUnconfirmed", async () => {
    const calls: string[] = [];
    const transport = new IosOverlayTransport(
      fakeAgent(CAPS, calls, (type) =>
        type === "restore_after_capture"
          ? { success: true, restored: false }
          : { success: true, token: 4 },
      ),
    );
    const result = await transport.captureWithOverlayHidden(async () => "png");
    expect(calls).toEqual(["hide_for_capture:1500", "restore_after_capture:token4"]);
    expect(result.hideUnconfirmed).toBe(true);
  });

  test("overlapping captures each restore their own token and both stay confirmed", async () => {
    const calls: string[] = [];
    let next = 0;
    const transport = new IosOverlayTransport(
      fakeAgent(CAPS, calls, (type) =>
        type === "hide_for_capture"
          ? { success: true, hidden: true, token: ++next }
          : { success: true, restored: true },
      ),
    );
    const [a, b] = await Promise.all([
      transport.captureWithOverlayHidden(async () => "a"),
      transport.captureWithOverlayHidden(async () => "b"),
    ]);
    expect(a.hideUnconfirmed).toBeUndefined();
    expect(b.hideUnconfirmed).toBeUndefined();
    expect(calls.filter((c) => c.startsWith("restore"))).toEqual([
      "restore_after_capture:token1",
      "restore_after_capture:token2",
    ]);
  });

  test("an older agent without a token gets a tokenless restore", async () => {
    const calls: string[] = [];
    const transport = new IosOverlayTransport(fakeAgent(CAPS, calls));
    await transport.captureWithOverlayHidden(async () => "png");
    expect(calls).toEqual(["hide_for_capture:1500", "restore_after_capture"]);
  });

  test("the hide deadline covers the capture timeout plus a margin, capped at the agent max", () => {
    expect(captureHideDeadlineMs(10000)).toBe(11000);
    expect(captureHideDeadlineMs(60000)).toBe(15000);
  });

  describe("show reset", () => {
    const spec = {
      id: "panel",
      window: { placement: { type: "fullscreen" as const } },
      root: { type: "text" as const, text: "hi" },
    };
    function recording(capabilities: string[]) {
      const bodies: OverlayAgentMessage[] = [];
      const agent = fakeAgent(capabilities, []);
      const request = agent.request.bind(agent);
      agent.request = async (type, body) => {
        bodies.push(body ?? {});
        return request(type, body);
      };
      return { agent, bodies };
    }

    test("reset true is sent on the wire; absent or false keeps the wire unchanged", async () => {
      const { agent, bodies } = recording(["show_overlay", "overlay_show_in_place_v1"]);
      const transport = new IosOverlayTransport(agent);
      await transport.show(spec);
      await transport.show(spec, { reset: false });
      await transport.show(spec, { reset: true });
      expect(bodies).toEqual([{ spec }, { spec }, { spec, reset: true }]);
    });

    test("an agent without the capability refuses reset before sending anything", async () => {
      const { agent, bodies } = recording(["show_overlay"]);
      const transport = new IosOverlayTransport(agent);
      await expect(transport.show(spec, { reset: true })).rejects.toThrow("does not support reset");
      expect(bodies).toEqual([]);
      await transport.show(spec);
      expect(bodies).toEqual([{ spec }]);
    });
  });
});
