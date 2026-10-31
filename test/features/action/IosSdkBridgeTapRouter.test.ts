import { MAX_SETTIMEOUT_DELAY_MS } from "../../../src/utils/SystemTimer";
import { describe, expect, test } from "bun:test";
import { createIosSdkBridgeTapper } from "../../../src/features/action/IosSdkBridgeTapRouter";
import type { IosSdkAction } from "../../../src/features/observe/ios/sdkObservationBridge";
import type { CtrlProxySdkActionResult } from "../../../src/features/observe/ios/types";

const bridgeElement = { "sdk-element-id": "save", "sdk-capture-identity": "41" };

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

function tapper(reply: CtrlProxySdkActionResult, enabled = true) {
  const client = new FakeActionClient(reply);
  return {
    client,
    tapper: createIosSdkBridgeTapper({ client: () => client, enabled: () => enabled }),
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

describe("createIosSdkBridgeTapper (#5159)", () => {
  test("taps a bridge node through the bridge with its observation identity", async () => {
    const { client, tapper: router } = tapper(accepted);
    expect(await router.tap({ action: "tap", element: bridgeElement })).toEqual({
      backend: "sdk",
      nextObservationIdentity: 42,
    });
    expect(client.timeouts).toEqual([5000]);
    expect(client.actions).toEqual([{ tap: { observationIdentity: 41, elementId: "save" } }]);
  });

  test.each([
    [10000, 12000],
    [MAX_SETTIMEOUT_DELAY_MS, MAX_SETTIMEOUT_DELAY_MS],
  ])("a long press of %i ms gets a duration-aware bounded timeout", async (duration, expected) => {
    const { client, tapper: router } = tapper(accepted);
    await router.tap({
      action: "longPress",
      element: bridgeElement,
      longPressDurationMs: duration,
    });
    expect(client.timeouts).toEqual([expected]);
    if (duration === 10000) {
      expect(client.timeouts[0]).toBeGreaterThan(10000);
    }
  });

  test("a long press carries its duration", async () => {
    const { client, tapper: router } = tapper(accepted);
    await router.tap({ action: "longPress", element: bridgeElement, longPressDurationMs: 800 });
    expect(client.actions).toEqual([
      { longPress: { observationIdentity: 41, elementId: "save", durationMs: 800 } },
    ]);
  });

  test("XCTest nodes, disabled routing and sendKeys focus taps never reach the bridge", async () => {
    const { client, tapper: router } = tapper(accepted);
    expect(await router.tap({ action: "tap", element: { "resource-id": "save" } })).toBeNull();
    expect(await router.tap({ action: "focus", element: bridgeElement })).toBeNull();
    const off = tapper(accepted, false);
    expect(await off.tapper.tap({ action: "tap", element: bridgeElement })).toBeNull();
    expect(client.actions).toEqual([]);
    expect(off.client.actions).toEqual([]);
  });

  test("an action the bridge has no form for falls back as unsupported without a request", async () => {
    const { client, tapper: router } = tapper(accepted);
    expect(await router.tap({ action: "doubleTap", element: bridgeElement })).toEqual({
      backend: "xctest",
      fallbackReason: "unsupported",
    });
    expect(client.actions).toEqual([]);
  });

  test("only unsupported and unavailable fall back to XCTest", async () => {
    expect(
      await tapper(rejected("unsupported_action")).tapper.tap({
        action: "tap",
        element: bridgeElement,
      }),
    ).toEqual({ backend: "xctest", fallbackReason: "unsupported" });
    const unavailable: CtrlProxySdkActionResult = {
      success: false,
      available: false,
      failure: "bridge_unavailable",
      totalTimeMs: 1,
    };
    expect(await tapper(unavailable).tapper.tap({ action: "tap", element: bridgeElement })).toEqual(
      {
        backend: "xctest",
        fallbackReason: "unavailable",
      },
    );
    const oldRunner: CtrlProxySdkActionResult = {
      success: false,
      available: false,
      unsupported: true,
      totalTimeMs: 0,
    };
    expect(await tapper(oldRunner).tapper.tap({ action: "tap", element: bridgeElement })).toEqual({
      backend: "xctest",
      fallbackReason: "unavailable",
    });
  });

  test.each([
    "stale_observation",
    "unknown_element",
    "element_not_actionable",
    "action_in_flight",
    "action_queue_overloaded",
    "action_cancelled",
  ])("%s fails closed instead of falling back", async (reason) => {
    await expect(
      tapper(rejected(reason)).tapper.tap({ action: "tap", element: bridgeElement }),
    ).rejects.toThrow(reason);
  });

  test("a runner failure other than unavailable fails closed", async () => {
    for (const failure of ["app_not_active", "bad_reply", "invalid_action"] as const) {
      const reply: CtrlProxySdkActionResult = {
        success: false,
        available: true,
        failure,
        totalTimeMs: 1,
      };
      await expect(
        tapper(reply).tapper.tap({ action: "tap", element: bridgeElement }),
      ).rejects.toThrow(failure);
    }
    const timeout: CtrlProxySdkActionResult = {
      success: false,
      available: true,
      error: "Timeout waiting for sdk_action_result",
      totalTimeMs: 0,
    };
    await expect(
      tapper(timeout).tapper.tap({ action: "tap", element: bridgeElement }),
    ).rejects.toThrow("Timeout");
  });
});
