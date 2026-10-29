import { describe, expect, test } from "bun:test";
import { createIosSdkBridgeTapper } from "../../../src/features/action/IosSdkBridgeTapRouter";
import {
  iosSdkWebActionOutcome,
  type IosSdkWebActionClient,
} from "../../../src/features/action/IosSdkWebActionRouter";
import type { IosSdkWebAction } from "../../../src/features/observe/ios/sdkWebViewBridge";
import type { CtrlProxySdkWebActionResult } from "../../../src/features/observe/ios/types";

const webElement = {
  "content-desc": "Pay",
  "web-view-id": "checkout",
  "web-snapshot-id": "s7",
  "web-element-id": "e0",
};

const accepted: CtrlProxySdkWebActionResult = {
  success: true,
  available: true,
  result: { status: "accepted" },
  totalTimeMs: 2,
};

const rejected = (reason: string): CtrlProxySdkWebActionResult => ({
  success: false,
  available: true,
  result: { status: "rejected", reason },
  totalTimeMs: 1,
});

class FakeWebActionClient implements IosSdkWebActionClient {
  calls: Array<{ webViewId: string; action: IosSdkWebAction; timeoutMs?: number }> = [];
  constructor(private readonly reply: CtrlProxySdkWebActionResult) {}
  async requestSdkWebActionForIos(
    webViewId: string,
    action: IosSdkWebAction,
    options?: { timeoutMs?: number },
  ): Promise<CtrlProxySdkWebActionResult> {
    this.calls.push({ webViewId, action, timeoutMs: options?.timeoutMs });
    return this.reply;
  }
}

function tapper(reply: CtrlProxySdkWebActionResult, enabled = true) {
  const web = new FakeWebActionClient(reply);
  const native = {
    requestSdkActionForIos: async () =>
      Promise.reject(new Error("native bridge must not be called")),
  };
  return {
    web,
    tapper: createIosSdkBridgeTapper({
      client: () => native,
      webClient: () => web,
      enabled: () => enabled,
    }),
  };
}

describe("tapOn on a merged DOM element (#5162)", () => {
  test("a tap is the web view's click on that element of that snapshot", async () => {
    const { web, tapper: router } = tapper(accepted);
    expect(await router.tap({ action: "tap", element: webElement })).toEqual({ backend: "sdk" });
    expect(web.calls).toEqual([
      {
        webViewId: "checkout",
        action: { click: { snapshotId: "s7", elementId: "e0" } },
        timeoutMs: 5000,
      },
    ]);
  });

  test("an action with no web form falls back as unsupported without a request", async () => {
    const { web, tapper: router } = tapper(accepted);
    for (const action of ["longPress", "doubleTap"]) {
      expect(await router.tap({ action, element: webElement })).toEqual({
        backend: "xctest",
        fallbackReason: "unsupported",
      });
    }
    expect(web.calls).toEqual([]);
  });

  test("routing off and sendKeys focus taps stay on XCTest; no web client is unavailable", async () => {
    const off = tapper(accepted, false);
    expect(await off.tapper.tap({ action: "tap", element: webElement })).toBeNull();
    const on = tapper(accepted);
    expect(await on.tapper.tap({ action: "focus", element: webElement })).toBeNull();
    expect([...off.web.calls, ...on.web.calls]).toEqual([]);
    const noWeb = createIosSdkBridgeTapper({ client: () => null, enabled: () => true });
    expect(await noWeb.tap({ action: "tap", element: webElement })).toEqual({
      backend: "xctest",
      fallbackReason: "unavailable",
    });
  });
});

describe("iosSdkWebActionOutcome (#5162)", () => {
  test("only an unavailable web bridge falls back to XCTest", () => {
    expect(
      iosSdkWebActionOutcome(
        { success: false, available: false, failure: "bridge_unavailable", totalTimeMs: 1 },
        "click",
      ),
    ).toEqual({ backend: "xctest", fallbackReason: "unavailable" });
    expect(
      iosSdkWebActionOutcome(
        { success: false, available: false, unsupported: true, totalTimeMs: 1 },
        "click",
      ),
    ).toEqual({ backend: "xctest", fallbackReason: "unavailable" });
  });

  test("every web rejection and every other failure fails closed, naming the reason", () => {
    for (const reason of [
      "stale_snapshot",
      "element_not_actionable",
      "disallowed_origin",
      "web_process_unavailable",
      "javascript_error",
    ]) {
      expect(() => iosSdkWebActionOutcome(rejected(reason), "click")).toThrow(
        `rejected the click (${reason})`,
      );
    }
    expect(() =>
      iosSdkWebActionOutcome(
        {
          success: false,
          available: true,
          error: "Timeout waiting for sdk_web_action_result",
          totalTimeMs: 5000,
        },
        "click",
      ),
    ).toThrow("Timeout waiting for sdk_web_action_result");
    expect(() =>
      iosSdkWebActionOutcome(
        { success: false, available: true, failure: "no_snapshot", totalTimeMs: 1 },
        "click",
      ),
    ).toThrow("(no_snapshot)");
  });
});
