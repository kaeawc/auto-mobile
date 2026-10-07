import { describe, expect, test } from "bun:test";
import { requestSdkTrigger } from "../../../../src/features/observe/ios/CtrlProxySdkTrigger";
import { decodeCtrlProxyMessage } from "../../../../src/features/observe/ios/decodeCtrlProxyMessage";
import { createIosDelegateHarness } from "../../../helpers/iosDelegateHarness";

async function flush(): Promise<void> {
  for (let i = 0; i < 10; i++) {
    await Promise.resolve();
  }
}

describe("SDK trigger relay (#1580)", () => {
  test("sends module, trigger and a JSON payload string, and resolves the decoded result", async () => {
    const harness = createIosDelegateHarness();
    const pending = requestSdkTrigger(harness.context, {
      module: "callkit",
      trigger: "call",
      payload: { phoneNumber: "555" },
    });
    await flush();
    expect(harness.sentMessages).toHaveLength(1);
    expect(harness.sentMessages[0]).toMatchObject({
      type: "request_sdk_trigger",
      module: "callkit",
      trigger: "call",
      payloadJson: '{"phoneNumber":"555"}',
    });
    const decoded = decodeCtrlProxyMessage({
      type: "sdk_trigger_result",
      requestId: harness.lastRequestId() ?? undefined,
      success: false,
      available: true,
      statusCode: 409,
      sdkError: "trigger_failed",
      reason: "callkit_timeout",
      error: "The in-app SDK rejected trigger callkit.call: trigger_failed",
      totalTimeMs: 3,
    });
    expect(decoded?.errorMessage).toBeUndefined();
    harness.resolveLast(decoded?.result);
    expect(await pending).toEqual({
      success: false,
      available: true,
      statusCode: 409,
      sdkError: "trigger_failed",
      reason: "callkit_timeout",
      registeredModules: undefined,
      supportedTriggers: undefined,
      error: "The in-app SDK rejected trigger callkit.call: trigger_failed",
      totalTimeMs: 3,
    });
  });

  test("omits payloadJson when there is no payload", async () => {
    const harness = createIosDelegateHarness();
    void requestSdkTrigger(harness.context, { module: "callkit", trigger: "hold" });
    await flush();
    expect(harness.sentMessages[0]).not.toHaveProperty("payloadJson");
  });

  test("decoding defaults a bare reply to unavailable", () => {
    const decoded = decodeCtrlProxyMessage({ type: "sdk_trigger_result", requestId: "t-1" });
    expect(decoded?.result).toMatchObject({ success: false, available: false, totalTimeMs: 0 });
  });

  test("an older runner refuses the command without sending it", async () => {
    const harness = createIosDelegateHarness({ supportedCommands: ["get_voiceover_state"] });
    const result = await requestSdkTrigger(harness.context, { module: "callkit", trigger: "call" });
    expect(result).toMatchObject({ success: false, available: false, unsupported: true });
    expect(harness.sentMessages).toEqual([]);
  });

  test("a timeout does not claim the SDK is absent", async () => {
    const harness = createIosDelegateHarness();
    const pending = requestSdkTrigger(harness.context, {
      module: "messages",
      trigger: "sms",
      timeoutMs: 10,
    });
    await flush();
    harness.advanceTime(11);
    const result = await pending;
    expect(result.success).toBe(false);
    expect(result.available).toBe(true);
  });
});
