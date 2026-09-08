import { describe, expect, test } from "bun:test";
import { CtrlProxyText } from "../../../../src/features/observe/android/CtrlProxyText";
import type { DelegateContext } from "../../../../src/features/observe/android/types";
import { RequestManager } from "../../../../src/utils/RequestManager";
import { FakeTimer } from "../../../fakes/FakeTimer";

describe("Android CtrlProxyText", () => {
  test("sends request_insert_text and resolves its result", async () => {
    const timer = new FakeTimer();
    timer.enableAutoAdvance();
    const sent: string[] = [];
    const requestManager = new RequestManager(timer);
    const context: DelegateContext = {
      getWebSocket: () =>
        ({
          readyState: 1,
          send: (data: string) => sent.push(data),
        }) as any,
      requestManager,
      timer,
      ensureConnected: async () => true,
      cancelScreenshotBackoff: () => {},
    };
    const delegate = new CtrlProxyText(context);

    const resultPromise = delegate.requestInsertText("value");
    await Promise.resolve();
    await Promise.resolve();
    const request = JSON.parse(sent[0] ?? "{}") as Record<string, unknown>;
    requestManager.resolve(request.requestId as string, { success: true, totalTimeMs: 2 });

    expect(request).toMatchObject({
      type: "request_insert_text",
      text: "value",
    });
    expect(await resultPromise).toMatchObject({ success: true, totalTimeMs: 2 });
  });
});
