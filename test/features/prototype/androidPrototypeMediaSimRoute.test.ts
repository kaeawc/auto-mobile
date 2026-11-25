import { describe, expect, test } from "bun:test";
import {
  androidPrototypeMediaSimRoute,
  PROTOTYPE_PLATFORM_MEDIA_CAPABILITY,
} from "../../../src/features/prototype/androidPrototypeMediaSimRoute";
import { simulatePrototypeMedia } from "../../../src/features/prototype/prototypeMediaSimulate";
import type { PrototypeResult } from "../../../src/features/observe/android/ctrlProxyProtocol";

/** Records what reaches CtrlProxy and answers with a scripted reply. */
function fakeAndroid(advertised: string[], reply: PrototypeResult = { success: true }) {
  const sent: Array<{ id: string; event: string; data: unknown; timeoutMs?: number }> = [];
  return {
    sent,
    android: {
      supportsCommand: async (name: string) => advertised.includes(name),
      simulatePlatformEvent: async (
        id: string,
        event: string,
        data: Record<string, unknown>,
        timeoutMs?: number,
      ) => {
        sent.push({ id, event, data, timeoutMs });
        return reply;
      },
    },
  };
}

describe("Android media simulate route (#14257)", () => {
  test("a CtrlProxy advertising the media module gets the event with its data", async () => {
    const { android, sent } = fakeAndroid([PROTOTYPE_PLATFORM_MEDIA_CAPABILITY]);
    const result = await simulatePrototypeMedia(androidPrototypeMediaSimRoute(android), {
      id: "player",
      event: "media.ended",
      data: { player: "main", advanceMs: 500 },
      timeoutMs: 900,
    });
    expect(result).toEqual({ success: true, mediaEngine: "fake" });
    expect(sent).toEqual([
      {
        id: "player",
        event: "media.ended",
        data: { player: "main", advanceMs: 500 },
        timeoutMs: 900,
      },
    ]);
  });

  test("a CtrlProxy without the media module is unavailable and sent nothing", async () => {
    const { android, sent } = fakeAndroid([]);
    const result = await simulatePrototypeMedia(androidPrototypeMediaSimRoute(android), {
      id: "player",
      event: "media.ended",
      data: { player: "main" },
    });
    expect(result).toMatchObject({ success: false, code: "unavailable" });
    expect(sent).toEqual([]);
  });

  test("a device refusal is a platform error carrying the device's message", async () => {
    const error = "unsupported: module does not support simulation of media.statusChanged";
    const { android } = fakeAndroid([PROTOTYPE_PLATFORM_MEDIA_CAPABILITY], {
      success: false,
      error,
    });
    const result = await simulatePrototypeMedia(androidPrototypeMediaSimRoute(android), {
      id: "player",
      event: "media.statusChanged",
      data: { player: "other", status: "buffering" },
    });
    expect(result).toEqual({ success: false, code: "platform_error", mediaEngine: "fake", error });
  });
});
