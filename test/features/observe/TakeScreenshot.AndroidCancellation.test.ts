import { describe, expect, test } from "bun:test";
import { TakeScreenshot } from "../../../src/features/observe/TakeScreenshot";
import { AndroidCtrlProxyClient } from "../../../src/features/observe/android";
import { OPERATION_CANCELLED_MESSAGE } from "../../../src/utils/constants";
import { FakeAdbExecutor } from "../../fakes/FakeAdbExecutor";
import { FakeAdbClientFactory } from "../../fakes/FakeAdbClientFactory";
import { FakeScreenshotFileWriter } from "../../fakes/FakeScreenshotFileWriter";
import { FakeTimer } from "../../fakes/FakeTimer";
import { CountingIdGenerator } from "../../../src/utils/IdGenerator";
import { androidDevice } from "./takeScreenshotTestHelpers";

describe("TakeScreenshot Android cancellation", function () {
  test("abandons an in-flight CtrlProxy screenshot as soon as the signal aborts", async function () {
    const controller = new AbortController();
    const originalGetInstance = AndroidCtrlProxyClient.getInstance;
    let finishScreenshot: (() => void) | undefined;
    let requestScreenshotCalls = 0;
    AndroidCtrlProxyClient.getInstance = (() => ({
      requestScreenshot: () =>
        new Promise((resolve) => {
          requestScreenshotCalls++;
          finishScreenshot = () => resolve({ success: false, error: "too late" });
        }),
    })) as typeof AndroidCtrlProxyClient.getInstance;
    try {
      const screenshot = new TakeScreenshot(
        androidDevice("android-cancel-device"),
        new FakeAdbClientFactory(new FakeAdbExecutor()),
      );
      const resultPromise = screenshot.execute({}, controller.signal);
      await Promise.resolve();
      controller.abort();
      const stillPending = (async () => {
        for (let i = 0; i < 50; i++) {
          await Promise.resolve();
        }
        return "still-pending" as const;
      })();
      const outcome = await Promise.race([resultPromise, stillPending]);
      expect(requestScreenshotCalls).toBe(1);
      expect(outcome).toEqual({ success: false, error: OPERATION_CANCELLED_MESSAGE });
      finishScreenshot?.();
      await resultPromise;
    } finally {
      AndroidCtrlProxyClient.getInstance = originalGetInstance;
    }
  });

  test("discards a capture written after the caller cancelled", async function () {
    const controller = new AbortController();
    const originalGetInstance = AndroidCtrlProxyClient.getInstance;
    AndroidCtrlProxyClient.getInstance = (() => ({
      requestScreenshot: async () => ({
        success: true,
        data: Buffer.from([0xff, 0xd8, 0xff, 0xe0]).toString("base64"),
        format: "jpeg" as const,
      }),
    })) as typeof AndroidCtrlProxyClient.getInstance;
    const writer = new FakeScreenshotFileWriter(() => controller.abort());
    try {
      const screenshot = new TakeScreenshot(
        androidDevice("android-late-cancel"),
        new FakeAdbClientFactory(new FakeAdbExecutor()),
        new FakeTimer(),
        new CountingIdGenerator("capture"),
        writer,
      );
      const result = await screenshot.execute({}, controller.signal);
      expect(result).toEqual({ success: false, error: OPERATION_CANCELLED_MESSAGE });
      expect(writer.written).toHaveLength(1);
      expect(writer.removed).toEqual(writer.written);
    } finally {
      AndroidCtrlProxyClient.getInstance = originalGetInstance;
    }
  });
});
