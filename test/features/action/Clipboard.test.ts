import { expect, describe, test, beforeEach } from "bun:test";
import { Clipboard } from "../../../src/features/action/Clipboard";
import { BootedDevice } from "../../../src/models";
import { FakeIOSCtrlProxy } from "../../fakes/FakeIOSCtrlProxy";
import { FakeAdbClientFactory } from "../../fakes/FakeAdbClientFactory";

describe("Clipboard iOS", () => {
  let clipboard: Clipboard;
  let mockDevice: BootedDevice;
  let fakeIOSCtrlProxy: FakeIOSCtrlProxy;

  beforeEach(() => {
    mockDevice = {
      name: "Test iPhone",
      platform: "ios",
      deviceId: "test-iphone",
    };

    fakeIOSCtrlProxy = new FakeIOSCtrlProxy();

    clipboard = new Clipboard(mockDevice, new FakeAdbClientFactory(), () => fakeIOSCtrlProxy);
  });

  test("get returns clipboard text", async () => {
    fakeIOSCtrlProxy.setClipboardResult({
      success: true,
      action: "get",
      text: "hello world",
      totalTimeMs: 10,
    });

    const result = await clipboard.execute("get");

    expect(result.success).toBe(true);
    expect(result.action).toBe("get");
    expect(result.text).toBe("hello world");
    expect(result.method).toBe("a11y");
  });

  test("copy sends text to clipboard", async () => {
    fakeIOSCtrlProxy.setClipboardResult({
      success: true,
      action: "copy",
      totalTimeMs: 10,
    });

    const result = await clipboard.execute("copy", "test text");

    expect(result.success).toBe(true);
    expect(result.action).toBe("copy");

    const history = fakeIOSCtrlProxy.getClipboardHistory();
    expect(history).toHaveLength(1);
    expect(history[0].action).toBe("copy");
    expect(history[0].text).toBe("test text");
  });

  test("copy without text returns error", async () => {
    const result = await clipboard.execute("copy");

    expect(result.success).toBe(false);
    expect(result.error).toContain("Text is required");
  });

  test("clear clipboard succeeds", async () => {
    fakeIOSCtrlProxy.setClipboardResult({
      success: true,
      action: "clear",
      totalTimeMs: 10,
    });

    const result = await clipboard.execute("clear");

    expect(result.success).toBe(true);
    expect(result.action).toBe("clear");
  });

  test("paste clipboard succeeds", async () => {
    fakeIOSCtrlProxy.setClipboardResult({
      success: true,
      action: "paste",
      totalTimeMs: 10,
    });

    const result = await clipboard.execute("paste");

    expect(result.success).toBe(true);
    expect(result.action).toBe("paste");
  });

  test("returns error when CtrlProxy fails", async () => {
    fakeIOSCtrlProxy.setClipboardResult({
      success: false,
      action: "get",
      totalTimeMs: 10,
      error: "Clipboard access denied",
    });

    const result = await clipboard.execute("get");

    expect(result.success).toBe(false);
    expect(result.error).toBe("Clipboard access denied");
  });

  test("get returns success with undefined text when clipboard empty", async () => {
    fakeIOSCtrlProxy.setClipboardResult({
      success: true,
      action: "get",
      text: undefined,
      totalTimeMs: 10,
    });

    const result = await clipboard.execute("get");

    expect(result.success).toBe(true);
    expect(result.text).toBeUndefined();
  });
});

describe("Clipboard Android", () => {
  const androidDevice: BootedDevice = {
    name: "Test Android",
    platform: "android",
    deviceId: "test-android",
  };

  // Regression for https://github.com/kaeawc/auto-mobile/issues/2227.
  // AndroidCtrlProxyClient.getInstance expects an AdbClientFactory and calls
  // `.create(device)` on it. Passing the resolved AdbExecutor instead
  // surfaces in production as `TypeError: <minified>.create is not a function`
  // and silently breaks the a11y clipboard path.
  test("passes the injected AdbClientFactory (not AdbExecutor) to AndroidCtrlProxyClient.getInstance", async () => {
    const factory = new FakeAdbClientFactory();
    let passedFactory: FakeAdbClientFactory | undefined;
    const clipboard = new Clipboard(androidDevice, factory, (_device, adbFactory) => {
      passedFactory = adbFactory as FakeAdbClientFactory;
      return {
        requestClipboard: async () => ({ success: true, action: "copy", totalTimeMs: 1 }),
      };
    });

    await clipboard.execute("copy", "hello");

    expect(passedFactory).toBeDefined();
    expect(typeof passedFactory!.create).toBe("function");
    expect(passedFactory).toBe(factory);
    expect(factory.wasCalledForDevice(androidDevice.deviceId)).toBe(true);
  });

  test("get returns accessibility restriction error without ADB fallback when Android denies clipboard reads", async () => {
    const factory = new FakeAdbClientFactory();
    const fakeAdb = factory.getFakeClient();
    const clipboard = new Clipboard(androidDevice, factory, () => ({
      requestClipboard: async () => ({
        success: false,
        action: "get",
        totalTimeMs: 1,
        error: "Clipboard read is restricted while CtrlProxy is not foreground",
      }),
    }));
    const result = await clipboard.execute("get");

    expect(result.success).toBe(false);
    expect(result.action).toBe("get");
    expect(result.method).toBe("a11y");
    expect(result.error).toContain("Clipboard read is restricted");
    expect(fakeAdb.getAllCommands()).not.toContain("shell cmd clipboard get");
  });

  test("get returns default accessibility error when Android read fails without details", async () => {
    const factory = new FakeAdbClientFactory();
    const fakeAdb = factory.getFakeClient();
    const clipboard = new Clipboard(androidDevice, factory, () => ({
      requestClipboard: async () => ({
        success: false,
        action: "get",
        totalTimeMs: 1,
      }),
    }));
    const result = await clipboard.execute("get");

    expect(result.success).toBe(false);
    expect(result.error).toBe("Accessibility clipboard get failed");
    expect(result.method).toBe("a11y");
    expect(fakeAdb.getAllCommands()).not.toContain("shell cmd clipboard get");
  });

  test("get does not use unsupported cmd clipboard fallback for an empty accessibility read", async () => {
    const factory = new FakeAdbClientFactory();
    const fakeAdb = factory.getFakeClient();
    fakeAdb.setCommandResult("shell cmd clipboard get", "No shell command implementation");
    const clipboard = new Clipboard(androidDevice, factory, () => ({
      requestClipboard: async () => ({
        success: true,
        action: "get",
        text: "",
        totalTimeMs: 1,
      }),
    }));
    const result = await clipboard.execute("get");

    expect(result.success).toBe(true);
    expect(result.action).toBe("get");
    expect(result.text).toBe("");
    expect(result.method).toBe("a11y");
    expect(fakeAdb.getAllCommands()).not.toContain("shell cmd clipboard get");
  });
});
