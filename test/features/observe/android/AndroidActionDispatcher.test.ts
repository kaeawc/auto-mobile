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
