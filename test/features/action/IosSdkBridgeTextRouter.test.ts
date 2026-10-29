import { describe, expect, test } from "bun:test";
import { createIosSdkBridgeTextRouter } from "../../../src/features/action/IosSdkBridgeTextRouter";
import type { IosSdkAction } from "../../../src/features/observe/ios/sdkObservationBridge";
import type { CtrlProxySdkActionResult } from "../../../src/features/observe/ios/types";

const target = { elementId: "email", observationIdentity: 41 };

class FakeActionClient {
  actions: IosSdkAction[] = [];
  timeouts: Array<number | undefined> = [];
  constructor(private readonly reply: CtrlProxySdkActionResult) {}
  async requestSdkActionForIos(
    action: IosSdkAction,
    options?: { timeoutMs?: number },
  ): Promise<CtrlProxySdkActionResult> {
    this.actions.push(action);
    this.timeouts.push(options?.timeoutMs);
    return this.reply;
  }
}

function router(reply: CtrlProxySdkActionResult, enabled = true) {
  const client = new FakeActionClient(reply);
  return {
    client,
    router: createIosSdkBridgeTextRouter({ client: () => client, enabled: () => enabled }),
  };
}

const accepted: CtrlProxySdkActionResult = {
  success: true,
  available: true,
  result: { status: "accepted", durationMs: 3, nextObservationIdentity: 42 },
  totalTimeMs: 4,
};

function rejected(reason: string): CtrlProxySdkActionResult {
  return {
    success: false,
    available: true,
    result: { status: "rejected", reason, durationMs: 0 },
    error: reason,
    totalTimeMs: 1,
  };
}

describe("createIosSdkBridgeTextRouter (#5159)", () => {
  test("sends insertText and clearText with the target's capture identity", async () => {
    const { client, router: text } = router(accepted);
    expect(
      await text.perform({ action: "insertText", target, text: "a@b.co", timeoutMs: 9000 }),
    ).toEqual({ backend: "sdk", nextObservationIdentity: 42 });
    await text.perform({ action: "clearText", target });
    expect(client.actions).toEqual([
      { insertText: { observationIdentity: 41, elementId: "email", text: "a@b.co" } },
      { clearText: { observationIdentity: 41, elementId: "email" } },
    ]);
    expect(client.timeouts).toEqual([9000, 5000]);
  });

  test("routing off returns null so the caller types with XCTest", async () => {
    const { client, router: text } = router(accepted, false);
    expect(await text.perform({ action: "insertText", target, text: "x" })).toBeNull();
    expect(client.actions).toEqual([]);
  });

  test("XCTest stands in only for an unsupported action or an unavailable bridge", async () => {
    expect(
      await router(rejected("unsupported_action")).router.perform({ action: "clearText", target }),
    ).toEqual({ backend: "xctest", fallbackReason: "unsupported" });
    const unavailable: CtrlProxySdkActionResult = {
      success: false,
      available: false,
      failure: "bridge_unavailable",
      totalTimeMs: 1,
    };
    expect(
      await router(unavailable).router.perform({ action: "insertText", target, text: "x" }),
    ).toEqual({ backend: "xctest", fallbackReason: "unavailable" });
    const noClient = createIosSdkBridgeTextRouter({ client: () => null, enabled: () => true });
    expect(await noClient.perform({ action: "clearText", target })).toEqual({
      backend: "xctest",
      fallbackReason: "unavailable",
    });
  });

  test("a stale or unactionable field fails closed and names the text action", async () => {
    await expect(
      router(rejected("stale_observation")).router.perform({
        action: "insertText",
        target,
        text: "x",
      }),
    ).rejects.toThrow("rejected the text entry (stale_observation)");
    await expect(
      router(rejected("element_not_actionable")).router.perform({ action: "clearText", target }),
    ).rejects.toThrow("rejected the clear (element_not_actionable)");
  });
});
