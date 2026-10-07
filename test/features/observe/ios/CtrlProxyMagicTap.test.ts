import { describe, expect, test } from "bun:test";
import { CtrlProxyVoiceOver } from "../../../../src/features/observe/ios/CtrlProxyVoiceOver";
import { decodeCtrlProxyMessage } from "../../../../src/features/observe/ios/decodeCtrlProxyMessage";
import { createIosDelegateHarness } from "../../../helpers/iosDelegateHarness";
import type { CtrlProxyMagicTapResult } from "../../../../src/features/observe/ios/types";

async function flush(): Promise<void> {
  for (let i = 0; i < 10; i++) {
    await Promise.resolve();
  }
}

describe("SDK Magic Tap", () => {
  test.each([true, false])(
    "preserves handled=%s through the wire and delegate",
    async (handled) => {
      const harness = createIosDelegateHarness();
      const pending = new CtrlProxyVoiceOver(harness.context).requestMagicTap();
      await flush();
      expect(harness.sentMessages).toHaveLength(1);
      expect(harness.sentMessages[0].type).toBe("request_magic_tap");
      const result: CtrlProxyMagicTapResult = {
        success: handled,
        available: true,
        handled,
        unsupported: !handled,
        requiresVoiceOver: false,
        totalTimeMs: 2,
        error: handled ? undefined : "No responder handled Magic Tap",
      };
      const decoded = decodeCtrlProxyMessage({
        type: "magic_tap_result",
        requestId: harness.lastRequestId() ?? undefined,
        ...result,
      });
      expect(decoded?.errorMessage).toBeUndefined();
      harness.resolveLast(decoded?.result);
      expect(await pending).toEqual(result);
    },
  );

  test("SDK absent is distinct from an unhandled call", () => {
    const decoded = decodeCtrlProxyMessage({
      type: "magic_tap_result",
      requestId: "magic-1",
      success: false,
      available: false,
      unsupported: true,
      error: "Magic Tap requires the in-app SDK",
    });
    expect(decoded?.result).toEqual({
      success: false,
      available: false,
      handled: undefined,
      unsupported: true,
      requiresVoiceOver: false,
      error: "Magic Tap requires the in-app SDK",
      totalTimeMs: 0,
    });
  });

  test("old runner refuses the additive command without sending it", async () => {
    const harness = createIosDelegateHarness({ supportedCommands: ["get_voiceover_state"] });
    const result = await new CtrlProxyVoiceOver(harness.context).requestMagicTap();
    expect(result.success).toBe(false);
    expect(result.unsupported).toBe(true);
    expect(harness.sentMessages).toEqual([]);
  });

  test("timeout never claims the app had no handler", async () => {
    const harness = createIosDelegateHarness();
    const pending = new CtrlProxyVoiceOver(harness.context).requestMagicTap(10);
    await flush();
    harness.advanceTime(11);
    const result = await pending;
    expect(result.success).toBe(false);
    expect(result.handled).toBeUndefined();
  });
});
