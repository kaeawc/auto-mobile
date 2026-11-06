import { describe, expect, test } from "bun:test";
import { CtrlProxyVoiceOver } from "../../../../src/features/observe/ios/CtrlProxyVoiceOver";
import { decodeCtrlProxyMessage } from "../../../../src/features/observe/ios/decodeCtrlProxyMessage";
import { createIosDelegateHarness } from "../../../helpers/iosDelegateHarness";
import type { CtrlProxyAccessibilityFocusResult } from "../../../../src/features/observe/ios/types";

async function flush(): Promise<void> {
  for (let i = 0; i < 10; i++) {
    await Promise.resolve();
  }
}

describe("SDK accessibility focus", () => {
  test.each([
    undefined,
    "voiceover_off",
    "sdk_unavailable",
    "element_not_found",
    "invalid_selector",
    "unsupported",
  ] as const)(
    "preserves success and typed %s failures through the decoder and delegate",
    async (errorCode) => {
      const harness = createIosDelegateHarness();
      const selector = { resourceId: "save", text: "Save", contentDesc: "Button" };
      const pending = new CtrlProxyVoiceOver(harness.context).requestAccessibilityFocus(selector);
      await flush();
      expect(harness.sentMessages).toHaveLength(1);
      expect(harness.sentMessages[0]).toMatchObject({
        type: "request_accessibility_focus",
        ...selector,
      });
      const result: CtrlProxyAccessibilityFocusResult = {
        success: errorCode === undefined,
        errorCode,
        error: errorCode ? "SDK error" : undefined,
        totalTimeMs: 2,
      };
      const decoded = decodeCtrlProxyMessage({
        type: "accessibility_focus_result",
        requestId: harness.lastRequestId() ?? undefined,
        ...result,
      });
      expect(decoded?.errorMessage).toBeUndefined();
      harness.resolveLast(decoded?.result);
      expect(await pending).toEqual(result);
    },
  );

  test("old runner returns unsupported without sending a command", async () => {
    const harness = createIosDelegateHarness({ supportedCommands: ["get_voiceover_state"] });
    const result = await new CtrlProxyVoiceOver(harness.context).requestAccessibilityFocus({
      text: "Save",
    });
    expect(result.success).toBe(false);
    expect(result.errorCode).toBe("unsupported");
    expect(harness.sentMessages).toEqual([]);
  });

  test("timeout reports a typed failure without claiming focus was never posted", async () => {
    const harness = createIosDelegateHarness();
    const pending = new CtrlProxyVoiceOver(harness.context).requestAccessibilityFocus(
      { text: "Save" },
      10,
    );
    await flush();
    harness.advanceTime(11);
    const result = await pending;
    expect(result.success).toBe(false);
    expect(result.errorCode).toBe("sdk_unavailable");
    expect(result.error).toContain("may have been posted");
  });
});
