import { describe, expect, test } from "bun:test";
import {
  AndroidActionDispatcher,
  type AndroidActionDispatcherContext,
} from "../../../../src/features/observe/android/AndroidActionDispatcher";
import { RequestManager } from "../../../../src/utils/RequestManager";
import type { A11yActionResult } from "../../../../src/features/observe/android/types";
import { FakeWebSocket, WebSocketState } from "../../../fakes/FakeWebSocket";
import { FakeTimer } from "../../../fakes/FakeTimer";

function harness(
  options: { connected?: boolean; supported?: string[] | null; sent?: string[] } = {},
) {
  const timer = new FakeTimer();
  const requestManager = new RequestManager(timer);
  const pendingFocusedInputClickIds = new Set<string>();
  const supported = options.supported === undefined ? null : options.supported;
  const context: AndroidActionDispatcherContext = {
    timer,
    requestManager,
    pendingFocusedInputClickIds,
    supportedCommands: supported === null ? null : new Set(supported),
    awaitActionWork: (work) => work(),
    awaitCancellableRequest: (_id, promise) => promise,
    connectWebSocket: async () => options.connected ?? false,
    waitForHandshake: async () => {},
    isCommandSupported: (messageType) => supported?.includes(messageType) === true,
    cancelScreenshotBackoff: () => {},
    createDelegateContext: () => ({
      timer,
      requestManager,
      ensureConnected: async () => true,
      cancelScreenshotBackoff: () => {},
      getWebSocket: () =>
        new (class extends FakeWebSocket {
          override readyState = WebSocketState.OPEN;
          override send(data: string): void {
            options.sent?.push(data);
            const message: { requestId: string } = JSON.parse(data);
            requestManager.resolve<A11yActionResult>(message.requestId, {
              success: true,
              action: "click",
              totalTimeMs: 0,
            });
          }
        })("ws://fake", "none", 0, timer),
    }),
  };
  return {
    dispatcher: new AndroidActionDispatcher(context),
    requestManager,
    pendingFocusedInputClickIds,
  };
}

describe("AndroidActionDispatcher", () => {
  test("an action fails fast and undispatched when the socket cannot connect", async () => {
    const { dispatcher } = harness({ connected: false });
    expect(await dispatcher.requestAction("click", "id/button")).toMatchObject({
      success: false,
      action: "click",
      error: "Failed to connect to accessibility service",
      dispatched: false,
      acknowledged: false,
    });
  });

  test("node selector support stays closed until the handshake advertises it", async () => {
    expect(
      await harness({ connected: true, supported: null }).dispatcher.supportsNodeActionSelectors(),
    ).toBe(false);
    expect(
      await harness({
        connected: true,
        supported: ["node_selector_actions"],
      }).dispatcher.supportsNodeActionSelectors(),
    ).toBe(true);
  });

  test("bounds verification requires its own advertised flag", async () => {
    for (const supported of [
      null,
      ["node_selector_actions"],
      ["node_selector_bounds_v1"],
      ["node_selector_actions", "node_selector_bounds_v1"],
    ]) {
      expect(
        await harness({ connected: true, supported }).dispatcher.supportsNodeActionSelectors(
          undefined,
          undefined,
          true,
        ),
      ).toBe(supported?.length === 2);
    }
  });

  test("serializes expected node bounds only when provided", async () => {
    const sent: string[] = [];
    const { dispatcher } = harness({ connected: true, sent });
    const expectedBounds = { left: -4, top: 2, right: 80, bottom: 100 };
    for (const bounds of [expectedBounds, undefined]) {
      expect(
        (
          await dispatcher.requestNodeAction(
            "click",
            { resourceId: "id/button" },
            { expectedBounds: bounds },
          )
        ).success,
      ).toBe(true);
    }
    const [verified, legacy] = sent.map((data) => JSON.parse(data));
    expect(verified).toMatchObject({
      type: "request_action",
      selector: { resourceId: "id/button" },
      boundsLeft: -4,
      boundsTop: 2,
      boundsRight: 80,
      boundsBottom: 100,
    });
    for (const key of ["boundsLeft", "boundsTop", "boundsRight", "boundsBottom"]) {
      expect(legacy).not.toHaveProperty(key);
    }
    for (const key of [
      "identityClassName",
      "identityText",
      "identityContentDesc",
      "identityLabelText",
      "identityLabelContentDesc",
    ]) {
      expect(legacy).not.toHaveProperty(key);
    }
  });

  test("serializes allowInvisible only for an explicit true opt in", async () => {
    const sent: string[] = [];
    const { dispatcher } = harness({ connected: true, sent });
    for (const allowInvisible of [true, false, undefined]) {
      await dispatcher.requestNodeAction(
        "click",
        { resourceId: "id/button" },
        {
          expectedBounds: { left: 10, top: 20, right: 110, bottom: 120 },
          allowInvisible,
        },
      );
    }
    expect(sent).toHaveLength(3);
    const [optedIn, optedOut, legacy] = sent.map((data) => JSON.parse(data));
    expect(optedIn).toMatchObject({ allowInvisible: true, boundsLeft: 10, boundsBottom: 120 });
    expect(optedOut).not.toHaveProperty("allowInvisible");
    expect(legacy).not.toHaveProperty("allowInvisible");
  });

  test("serializes a bounds-only click without selector or resource id", async () => {
    const sent: string[] = [];
    const { dispatcher } = harness({ connected: true, sent });
    expect(
      (
        await dispatcher.requestNodeAction("click", undefined, {
          expectedBounds: { left: 48, top: 372, right: 696, bottom: 548 },
          identityHints: {
            className: "android.widget.LinearLayout",
            text: "",
            contentDesc: "",
            labelText: "Connected devices",
            labelContentDesc: "Connections",
          },
        })
      ).success,
    ).toBe(true);
    expect(sent).toHaveLength(1);
    const message = JSON.parse(sent[0]!);
    expect(message).toMatchObject({
      type: "request_action",
      action: "click",
      boundsLeft: 48,
      boundsTop: 372,
      boundsRight: 696,
      boundsBottom: 548,
      identityClassName: "android.widget.LinearLayout",
      identityText: "",
      identityContentDesc: "",
      identityLabelText: "Connected devices",
      identityLabelContentDesc: "Connections",
    });
    expect(message).not.toHaveProperty("selector");
    expect(message).not.toHaveProperty("resourceId");
  });

  test("selector omission is allowed only for a bounds-verified click", async () => {
    const sent: string[] = [];
    const { dispatcher } = harness({ connected: true, sent });
    await expect(dispatcher.requestNodeAction("click", undefined)).rejects.toThrow(
      "A resource-id or stable node selector is required",
    );
    await expect(
      dispatcher.requestNodeAction("long_click", undefined, {
        expectedBounds: { left: 48, top: 372, right: 696, bottom: 548 },
      }),
    ).rejects.toThrow("A resource-id or stable node selector is required");
    expect(sent).toHaveLength(0);
  });

  test("an unattributed focused-click rejection settles every pending click", async () => {
    const { dispatcher, requestManager, pendingFocusedInputClickIds } = harness();
    const pending = requestManager.register<{ success: boolean; error?: string }>(
      "click-1",
      "action",
      1000,
      { timeoutErrorFactory: () => ({ success: false, error: "timeout" }) },
    );
    pendingFocusedInputClickIds.add("click-1");
    dispatcher.settleUnattributedFocusedClickRejection(
      "other",
      "request_click_focused_input",
      "no",
    );
    dispatcher.settleUnattributedFocusedClickRejection(null, "request_swipe", "no");
    dispatcher.settleUnattributedFocusedClickRejection(
      null,
      "request_click_focused_input",
      "rejected",
    );
    expect(await pending).toMatchObject({ success: false, error: "rejected" });
  });
});

for (const action of ["scroll_forward", "scroll_backward", "click"] as const) {
  for (const v2 of [false, true]) {
    test(`${action} new bounds semantics require v2=${v2}`, async () => {
      const sent: string[] = [];
      const { dispatcher } = harness({
        connected: true,
        sent,
        supported: [
          "node_selector_actions",
          "node_selector_bounds_v1",
          ...(v2 ? ["node_selector_bounds_v2"] : []),
        ],
      });
      const request = dispatcher.requestNodeAction(action, undefined, {
        expectedBounds: { left: 32, top: 65, right: 136, bottom: 161 },
        ...(action === "click" ? { identityHints: { checkable: true } } : {}),
      });
      if (!v2) {
        await expect(request).rejects.toThrow("Update CtrlProxy");
        expect(sent).toEqual([]);
      } else {
        expect((await request).success).toBe(true);
        expect(JSON.parse(sent[0]!)).toMatchObject({
          action,
          boundsLeft: 32,
          ...(action === "click" ? { identityCheckable: true } : {}),
        });
        expect(JSON.parse(sent[0]!)).not.toHaveProperty("selector");
      }
    });
  }
}

test("checkable false is preserved on the request wire", async () => {
  const sent: string[] = [];
  const { dispatcher } = harness({
    connected: true,
    sent,
    supported: ["node_selector_actions", "node_selector_bounds_v1", "node_selector_bounds_v2"],
  });
  await dispatcher.requestNodeAction("click", undefined, {
    expectedBounds: { left: 1, top: 2, right: 3, bottom: 4 },
    identityHints: { checkable: false },
  });
  expect(JSON.parse(sent[0]!)).toHaveProperty("identityCheckable", false);
});
