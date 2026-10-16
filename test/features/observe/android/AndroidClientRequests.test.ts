import { describe, expect, test } from "bun:test";
import {
  AndroidClientRequests,
  type AndroidClientRequestsContext,
} from "../../../../src/features/observe/android/AndroidClientRequests";
import { logger } from "../../../../src/utils/logger";
import { RequestManager } from "../../../../src/utils/RequestManager";
import { FakeTimer } from "../../../fakes/FakeTimer";

function harness() {
  const timer = new FakeTimer();
  const requestManager = new RequestManager(timer);
  const context: AndroidClientRequestsContext = {
    timer,
    requestManager,
    logger,
    actions: {
      sendClientCommand: () => {
        throw new Error("unused");
      },
    },
    isConnected: () => false,
    connectWebSocket: async () => false,
    createDelegateContext: () => {
      throw new Error("unused");
    },
    awaitActionWork: (work) => work(),
  };
  return { requests: new AndroidClientRequests(context), requestManager, timer };
}

type Result = { success: boolean; totalTimeMs: number; error?: string };

describe("AndroidClientRequests.awaitCancellableRequest", () => {
  test("without a signal it is the promise itself", async () => {
    const { requests } = harness();
    const promise = Promise.resolve<Result>({ success: true, totalTimeMs: 1 });
    expect(await requests.awaitCancellableRequest("r", promise, undefined, 0)).toEqual({
      success: true,
      totalTimeMs: 1,
    });
  });

  test("an abort settles the pending request with a cancellation failure immediately", async () => {
    const { requests, requestManager, timer } = harness();
    const pending = requestManager.register<Result>("r", "x", 60_000, () => ({
      success: false,
      totalTimeMs: 0,
      error: "timeout",
    }));
    const controller = new AbortController();
    const awaited = requests.awaitCancellableRequest("r", pending, controller.signal, timer.now());
    timer.advanceTime(5);
    controller.abort();
    const result = await awaited;
    expect(result.success).toBe(false);
    expect(result.error).not.toBe("timeout");
    expect(result.totalTimeMs).toBe(5);
  });
});
