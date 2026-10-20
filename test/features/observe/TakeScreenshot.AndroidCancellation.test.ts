import { describe, expect, test, spyOn, afterEach, mock } from "bun:test";
import { TakeScreenshot } from "../../../src/features/observe/TakeScreenshot";
import { AndroidCtrlProxyClient } from "../../../src/features/observe/android";
import { OPERATION_CANCELLED_MESSAGE } from "../../../src/utils/constants";
import { FakeAdbExecutor } from "../../fakes/FakeAdbExecutor";
import { FakeAdbClientFactory } from "../../fakes/FakeAdbClientFactory";
import { FakeScreenshotFileWriter } from "../../fakes/FakeScreenshotFileWriter";
import { FakeTimer } from "../../fakes/FakeTimer";
import { CountingIdGenerator } from "../../../src/utils/IdGenerator";
import { androidDevice } from "./takeScreenshotTestHelpers";
import { FakeCtrlProxy } from "../../fakes/FakeCtrlProxy";

afterEach(() => mock.restore());

describe("TakeScreenshot Android cancellation", function () {
  test("abandons an in-flight CtrlProxy screenshot as soon as the signal aborts", async function () {
    const controller = new AbortController();
    let finishScreenshot: (() => void) | undefined;
    let requestScreenshotCalls = 0;
    const ctrlProxy = new FakeCtrlProxy();
    spyOn(ctrlProxy, "requestScreenshot").mockImplementation(
      () =>
        new Promise((resolve) => {
          requestScreenshotCalls++;
          finishScreenshot = () => resolve({ success: false, error: "too late" });
        }),
    );
    const getInstance = spyOn(AndroidCtrlProxyClient, "getInstance").mockReturnValue(ctrlProxy);
    try {
      const screenshot = new TakeScreenshot(androidDevice("android-cancel-device"), {
        adbFactory: new FakeAdbClientFactory(new FakeAdbExecutor()),
      });
      const resultPromise = screenshot.execute({ format: "jpeg" }, controller.signal);
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
      getInstance.mockRestore();
    }
  });

  test("discards a capture written after the caller cancelled", async function () {
    const controller = new AbortController();
    const ctrlProxy = new FakeCtrlProxy();
    spyOn(ctrlProxy, "requestScreenshot").mockImplementation(async () => ({
      success: true,
      data: Buffer.from([0xff, 0xd8, 0xff, 0xe0]).toString("base64"),
      format: "jpeg" as const,
    }));
    const getInstance = spyOn(AndroidCtrlProxyClient, "getInstance").mockReturnValue(ctrlProxy);
    const writer = new FakeScreenshotFileWriter(() => controller.abort());
    try {
      const screenshot = new TakeScreenshot(androidDevice("android-late-cancel"), {
        adbFactory: new FakeAdbClientFactory(new FakeAdbExecutor()),
        timer: new FakeTimer(),
        idGenerator: new CountingIdGenerator("capture"),
        fileWriter: writer,
      });
      const result = await screenshot.execute({ format: "jpeg" }, controller.signal);
      expect(result).toEqual({ success: false, error: OPERATION_CANCELLED_MESSAGE });
      expect(writer.written).toHaveLength(1);
      expect(writer.removed).toEqual(writer.written);
    } finally {
      getInstance.mockRestore();
    }
  });
});
