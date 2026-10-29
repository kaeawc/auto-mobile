import { describe, expect, test } from "bun:test";
import {
  requestSdkWebAction,
  requestSdkWebSnapshot,
} from "../../../../src/features/observe/ios/CtrlProxySdkWebView";
import { decodeCtrlProxyMessage } from "../../../../src/features/observe/ios/decodeCtrlProxyMessage";
import { createIosDelegateHarness } from "../../../helpers/iosDelegateHarness";

async function flush(): Promise<void> {
  for (let i = 0; i < 10; i++) {
    await Promise.resolve();
  }
}

const snapshot = {
  snapshotId: "s1",
  url: "https://fixture.local/",
  elements: [
    {
      id: "submit",
      role: "button",
      label: "Submit",
      bounds: [10, 20, 80, 30],
      enabled: true,
      visible: true,
      focused: false,
    },
  ],
};

const webViews = [
  {
    webViewId: "main",
    url: "https://fixture.local/",
    allowedOrigins: ["https://fixture.local"],
    contentProcessAvailable: true,
  },
];

function decoded(message: ReturnType<typeof decodeCtrlProxyMessage>): unknown {
  return message?.result;
}

describe("SDK web-view commands (#5162)", () => {
  test("requestSdkWebSnapshot relays the snapshot and the registered web views", async () => {
    const harness = createIosDelegateHarness();
    const pending = requestSdkWebSnapshot(harness.context, { webViewId: "main" });
    await flush();
    expect(harness.sentMessages[0]).toMatchObject({
      type: "request_sdk_web_snapshot",
      webViewId: "main",
    });
    const message = decodeCtrlProxyMessage({
      type: "sdk_web_snapshot_result",
      requestId: harness.lastRequestId() ?? undefined,
      success: true,
      available: true,
      webViewId: "main",
      snapshot,
      webViews,
      totalTimeMs: 3,
    });
    harness.resolveLast(message?.result);
    expect(await pending).toEqual({
      success: true,
      available: true,
      webViewId: "main",
      snapshot,
      webViews,
      totalTimeMs: 3,
    });
  });

  test("a snapshot request without a web view id sends none", async () => {
    const harness = createIosDelegateHarness();
    void requestSdkWebSnapshot(harness.context);
    await flush();
    expect(harness.sentMessages[0].type).toBe("request_sdk_web_snapshot");
    expect(harness.sentMessages[0]).not.toHaveProperty("webViewId");
  });

  test("requestSdkWebAction sends the web view and the action as one JSON string", async () => {
    const harness = createIosDelegateHarness();
    const pending = requestSdkWebAction(harness.context, "main", {
      setValue: { snapshotId: "s1", elementId: "q", text: "hi" },
    });
    await flush();
    expect(harness.sentMessages[0]).toMatchObject({
      type: "request_sdk_web_action",
      webViewId: "main",
      actionJson: '{"setValue":{"snapshotId":"s1","elementId":"q","text":"hi"}}',
    });
    const message = decodeCtrlProxyMessage({
      type: "sdk_web_action_result",
      requestId: harness.lastRequestId() ?? undefined,
      success: true,
      available: true,
      result: { status: "accepted" },
      totalTimeMs: 6,
    });
    harness.resolveLast(message?.result);
    expect(await pending).toMatchObject({ success: true, result: { status: "accepted" } });
  });

  test("a stale snapshot decodes as a rejected result, not a failure", () => {
    expect(
      decoded(
        decodeCtrlProxyMessage({
          type: "sdk_web_action_result",
          requestId: "web-2",
          success: false,
          available: true,
          result: { status: "rejected", reason: "stale_snapshot" },
          error: "stale_snapshot",
          totalTimeMs: 2,
        }),
      ),
    ).toEqual({
      success: false,
      available: true,
      result: { status: "rejected", reason: "stale_snapshot" },
      error: "stale_snapshot",
      totalTimeMs: 2,
    });
  });

  test("web failure codes stay typed; an unknown one reads as bad_reply", () => {
    for (const failure of [
      "disallowed_origin",
      "web_process_unavailable",
      "message_too_large",
      "no_snapshot",
      "invalid_action",
    ]) {
      expect(
        decoded(
          decodeCtrlProxyMessage({
            type: "sdk_web_snapshot_result",
            requestId: "web-1",
            success: false,
            available: true,
            failure,
          }),
        ),
      ).toMatchObject({ failure });
    }
    expect(
      decoded(
        decodeCtrlProxyMessage({
          type: "sdk_web_action_result",
          requestId: "web-2",
          success: false,
          available: true,
          failure: "future_failure",
        }),
      ),
    ).toMatchObject({ failure: "bad_reply" });
  });

  test("a malformed relayed snapshot or web-view list is a bad_reply failure", () => {
    expect(
      decoded(
        decodeCtrlProxyMessage({
          type: "sdk_web_snapshot_result",
          requestId: "web-1",
          success: true,
          available: true,
          snapshot: { snapshotId: 7 },
        }),
      ),
    ).toMatchObject({ success: false, failure: "bad_reply", snapshot: undefined });
    expect(
      decoded(
        decodeCtrlProxyMessage({
          type: "sdk_web_snapshot_result",
          requestId: "web-1",
          success: true,
          available: true,
          snapshot,
          webViews: [{ webViewId: 1 }],
        }),
      ),
    ).toMatchObject({ success: false, failure: "bad_reply" });
  });
});
