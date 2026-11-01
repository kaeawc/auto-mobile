import { describe, expect, test } from "bun:test";
import {
  AndroidActionDispatcher,
  type AndroidActionDispatcherContext,
} from "../../../../src/features/observe/android/AndroidActionDispatcher";
import { RequestManager } from "../../../../src/utils/RequestManager";
import { FakeTimer } from "../../../fakes/FakeTimer";

function harness(options: { connected?: boolean; supported?: string[] | null } = {}) {
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
    createDelegateContext: () => {
      throw new Error("not needed when the socket never connects");
    },
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
