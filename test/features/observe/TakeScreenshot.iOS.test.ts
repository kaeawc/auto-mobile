import { describe, expect, spyOn, test } from "bun:test";
import os from "node:os";
import path from "node:path";
import { readFileSync } from "node:fs";
import { TakeScreenshot } from "../../../src/features/observe/TakeScreenshot";
import { IOSCtrlProxyClient } from "../../../src/features/observe/ios";
import { OPERATION_CANCELLED_MESSAGE } from "../../../src/utils/constants";
import { FakeAdbExecutor } from "../../fakes/FakeAdbExecutor";
import { FakeAdbClientFactory } from "../../fakes/FakeAdbClientFactory";
import { FakeIOSCtrlProxy } from "../../fakes/FakeIOSCtrlProxy";
import { FakeScreenshotFileWriter } from "../../fakes/FakeScreenshotFileWriter";
import { FakeTimer } from "../../fakes/FakeTimer";
import { CountingIdGenerator } from "../../../src/utils/IdGenerator";
import { iosDevice } from "./takeScreenshotTestHelpers";
import {
  DeviceDataStreamSocketServer,
  installDeviceDataStreamSocketServerForTesting,
} from "../../../src/daemon/deviceDataStreamSocketServer";

describe("TakeScreenshot iOS cancellation", function () {
  test("decodes an iOS capture once and passes the bytes to the stream server", async function () {
    const png = Buffer.alloc(24);
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(png, 0);
    png.writeUInt32BE(13, 8);
    png.write("IHDR", 12, "ascii");
    png.writeUInt32BE(320, 16);
    png.writeUInt32BE(640, 20);
    const screenshotBase64 = png.toString("base64");
    const fakeCtrlProxy = new FakeIOSCtrlProxy();
    fakeCtrlProxy.setScreenshotData(screenshotBase64);
    const originalGetInstance = IOSCtrlProxyClient.getInstance;
    const streamServer = new DeviceDataStreamSocketServer("/fake/path/test.sock", new FakeTimer());
    const pushSpy = spyOn(streamServer, "pushScreenshotUpdate");
    const fromSpy = spyOn(Buffer, "from");
    IOSCtrlProxyClient.getInstance = (() => ({
      ensureConnected: async () => true,
      requestScreenshot: fakeCtrlProxy.requestScreenshot.bind(fakeCtrlProxy),
    })) as typeof IOSCtrlProxyClient.getInstance;
    installDeviceDataStreamSocketServerForTesting(streamServer);

    try {
      const screenshot = new TakeScreenshot(
        iosDevice("ios-single-decode"),
        new FakeAdbClientFactory(new FakeAdbExecutor()),
        new FakeTimer(),
        new CountingIdGenerator("capture"),
        new FakeScreenshotFileWriter(),
      );
      const result = await screenshot.execute({ format: "png" });

      expect(result.success).toBe(true);
      expect(
        fromSpy.mock.calls.filter(
          ([value, encoding]) => value === screenshotBase64 && encoding === "base64",
        ),
      ).toHaveLength(1);
      expect(pushSpy).toHaveBeenCalledTimes(1);
      const [deviceId, pushedBase64, , , , options] = pushSpy.mock.calls[0]!;
      expect(deviceId).toBe("ios-single-decode");
      expect(pushedBase64).toBe(screenshotBase64);
      expect(options?.decodedImage).toBeInstanceOf(Buffer);
      expect(options?.decodedImage?.toString("base64")).toBe(screenshotBase64);
    } finally {
      fromSpy.mockRestore();
      pushSpy.mockRestore();
      installDeviceDataStreamSocketServerForTesting(null);
      IOSCtrlProxyClient.getInstance = originalGetInstance;
    }
  });

  test("does not let a reconnect hold an expired screenshot request open", async function () {
    const controller = new AbortController();
    const originalGetInstance = IOSCtrlProxyClient.getInstance;
    let requestScreenshotCalls = 0;
    let finishReconnect: (() => void) | undefined;
    IOSCtrlProxyClient.getInstance = (() => ({
      ensureConnected: () =>
        new Promise<boolean>((resolve) => {
          finishReconnect = () => resolve(true);
        }),
      requestScreenshot: async () => {
        requestScreenshotCalls++;
        return { success: false, error: "unexpected screenshot request" };
      },
    })) as typeof IOSCtrlProxyClient.getInstance;
    try {
      const screenshot = new TakeScreenshot(
        iosDevice("ios-device-id"),
        new FakeAdbClientFactory(new FakeAdbExecutor()),
      );
      const resultPromise = screenshot.execute({ format: "png" }, controller.signal);
      controller.abort();
      const result = await resultPromise;
      expect(result).toEqual({ success: false, error: OPERATION_CANCELLED_MESSAGE });
      expect(requestScreenshotCalls).toBe(0);
      finishReconnect?.();
    } finally {
      IOSCtrlProxyClient.getInstance = originalGetInstance;
    }
  });

  test("does not write or publish a screenshot after the request is cancelled", async function () {
    const controller = new AbortController();
    const originalGetInstance = IOSCtrlProxyClient.getInstance;
    let requestScreenshotCalls = 0;
    IOSCtrlProxyClient.getInstance = (() => ({
      ensureConnected: async () => true,
      requestScreenshot: async () => {
        requestScreenshotCalls++;
        controller.abort();
        return { success: true, data: Buffer.from("image").toString("base64") };
      },
    })) as typeof IOSCtrlProxyClient.getInstance;
    try {
      const screenshot = new TakeScreenshot(
        iosDevice("ios-device-id"),
        new FakeAdbClientFactory(new FakeAdbExecutor()),
      );
      const result = await screenshot.execute({ format: "png" }, controller.signal);
      expect(requestScreenshotCalls).toBe(1);
      expect(result).toEqual({ success: false, error: OPERATION_CANCELLED_MESSAGE });
    } finally {
      IOSCtrlProxyClient.getInstance = originalGetInstance;
    }
  });

  test("removes an iOS frame written as the caller cancels", async function () {
    const controller = new AbortController();
    const fakeCtrlProxy = new FakeIOSCtrlProxy();
    fakeCtrlProxy.setScreenshotData(
      readFileSync("test/fixtures/screenshots/black-on-white.png").toString("base64"),
    );
    const originalGetInstance = IOSCtrlProxyClient.getInstance;
    IOSCtrlProxyClient.getInstance = (() => ({
      ensureConnected: async () => true,
      requestScreenshot: fakeCtrlProxy.requestScreenshot.bind(fakeCtrlProxy),
    })) as typeof IOSCtrlProxyClient.getInstance;
    const writer = new FakeScreenshotFileWriter(() => controller.abort());
    try {
      const screenshot = new TakeScreenshot(
        iosDevice("ios-late-cancel"),
        new FakeAdbClientFactory(new FakeAdbExecutor()),
        new FakeTimer(),
        new CountingIdGenerator("capture"),
        writer,
      );
      const result = await screenshot.execute({ format: "png" }, controller.signal);
      expect(result).toEqual({ success: false, error: OPERATION_CANCELLED_MESSAGE });
      expect(writer.written).toHaveLength(1);
      expect(writer.removed).toEqual(writer.written);
    } finally {
      IOSCtrlProxyClient.getInstance = originalGetInstance;
    }
  });

  test("passes a cancellation signal to iOS CtrlProxy before screenshot dispatch", async function () {
    const controller = new AbortController();
    const fakeCtrlProxy = new FakeIOSCtrlProxy();
    fakeCtrlProxy.setScreenshotData(
      readFileSync("test/fixtures/screenshots/black-on-white.png").toString("base64"),
    );
    fakeCtrlProxy.abortScreenshotOnRequest(controller);
    const originalGetInstance = IOSCtrlProxyClient.getInstance;
    IOSCtrlProxyClient.getInstance = (() => ({
      ensureConnected: async () => true,
      requestScreenshot: fakeCtrlProxy.requestScreenshot.bind(fakeCtrlProxy),
    })) as typeof IOSCtrlProxyClient.getInstance;
    const writer = new FakeScreenshotFileWriter();
    try {
      const screenshot = new TakeScreenshot(
        iosDevice("ios-pre-cancel"),
        new FakeAdbClientFactory(new FakeAdbExecutor()),
        new FakeTimer(),
        new CountingIdGenerator("capture"),
        writer,
      );
      let streamPushes = 0;
      (screenshot as any).pushScreenshotToStream = () => {
        streamPushes++;
      };
      const result = await (screenshot as any).captureiOSScreenshot(
        path.join(os.tmpdir(), "ios-pre-cancel.png"),
        { format: "png" },
        controller.signal,
      );
      expect(result).toEqual({ success: false, error: OPERATION_CANCELLED_MESSAGE });
      expect(fakeCtrlProxy.getScreenshotRequestSignals()).toEqual([controller.signal]);
      expect(writer.written).toEqual([]);
      expect(streamPushes).toBe(0);
    } finally {
      IOSCtrlProxyClient.getInstance = originalGetInstance;
    }
  });
});
