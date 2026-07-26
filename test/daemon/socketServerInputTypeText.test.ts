import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { UnixSocketServer } from "../../src/daemon/socketServer";
import { AndroidCtrlProxyClient } from "../../src/features/observe/android";
import { IOSCtrlProxyClient } from "../../src/features/observe/ios";
import { PlatformDeviceManagerFactory } from "../../src/utils/factories/PlatformDeviceManagerFactory";
import { FakeTimer } from "../fakes/FakeTimer";
import {
  androidDevice,
  iosDevice,
  createFakeDeviceManager,
  createFakeSession,
  createFakeDaemonState,
  sendRequest,
  sendRequestAfterConnect,
} from "./helpers/inputSocketHarness";

describe("UnixSocketServer input/typeText", () => {
  let socketPath: string;
  let server: UnixSocketServer;
  let fakeTimer: FakeTimer;
  let originalAndroidGetInstance: typeof AndroidCtrlProxyClient.getInstance;
  let originalIosGetInstance: typeof IOSCtrlProxyClient.getInstance;

  beforeEach(async () => {
    socketPath = join(tmpdir(), `input-type-text-${randomUUID()}.sock`);
    fakeTimer = new FakeTimer();
    PlatformDeviceManagerFactory.reset();
    AndroidCtrlProxyClient.resetInstances();
    IOSCtrlProxyClient.resetInstances();
    originalAndroidGetInstance = AndroidCtrlProxyClient.getInstance;
    originalIosGetInstance = IOSCtrlProxyClient.getInstance;
  });

  afterEach(async () => {
    if (server) {
      await server.close();
    }
    if (existsSync(socketPath)) {
      await unlink(socketPath);
    }
    AndroidCtrlProxyClient.getInstance = originalAndroidGetInstance;
    IOSCtrlProxyClient.getInstance = originalIosGetInstance;
    PlatformDeviceManagerFactory.reset();
    AndroidCtrlProxyClient.resetInstances();
    IOSCtrlProxyClient.resetInstances();
  });

  test("routes Android text input through existing platform input infrastructure", async () => {
    const requestSetText = mock(async () => ({ success: true, totalTimeMs: 1 }));
    const requestImeAction = mock(async () => ({ success: true, totalTimeMs: 1 }));
    AndroidCtrlProxyClient.getInstance = mock(() => ({
      requestSetText,
      requestImeAction,
    })) as unknown as typeof AndroidCtrlProxyClient.getInstance;
    const createMcpClient = mock(async () => {
      throw new Error("input/typeText should not create an MCP client");
    });
    PlatformDeviceManagerFactory.setInstance(createFakeDeviceManager([androidDevice]));
    server = new UnixSocketServer(socketPath, "http://localhost:0/mcp", createFakeDaemonState(), fakeTimer);
    server.mcpClientFactory = createMcpClient;
    await server.start();

    const response = await sendRequest(socketPath, "input/typeText", {
      platform: "android",
      deviceId: "emulator-5554",
      text: "hello, Jason!",
    }, 1234);

    expect(response.success).toBe(true);
    expect(response.result).toEqual({
      action: "input/typeText",
      platform: "android",
      deviceId: "emulator-5554",
      success: true,
      textLength: 13,
      submitted: false,
    });
    expect(requestSetText).toHaveBeenCalledWith("hello, Jason!", { timeoutMs: 1234 });
    expect(requestImeAction).not.toHaveBeenCalled();
    expect(createMcpClient).not.toHaveBeenCalled();
  });

  // Issue #3351: requestSetText is ACTION_SET_TEXT, which REPLACES the focused
  // field. A client mirroring a keyboard one keystroke at a time must never
  // reach it, or typing "abc" leaves the field saying "c" and anything already
  // there is destroyed on the first key.
  test("append mode never reaches the destructive requestSetText path", async () => {
    const requestSetText = mock(async () => ({ success: true, totalTimeMs: 1 }));
    const requestImeAction = mock(async () => ({ success: true, totalTimeMs: 1 }));
    AndroidCtrlProxyClient.getInstance = mock(() => ({
      requestSetText,
      requestImeAction,
    })) as unknown as typeof AndroidCtrlProxyClient.getInstance;
    PlatformDeviceManagerFactory.setInstance(createFakeDeviceManager([androidDevice]));
    server = new UnixSocketServer(socketPath, "http://localhost:0/mcp", createFakeDaemonState(), fakeTimer);
    await server.start();

    await sendRequest(socketPath, "input/typeText", {
      platform: "android",
      deviceId: "emulator-5554",
      text: "a",
      mode: "append",
    }, 1234);

    // The request may or may not succeed here (the append path shells out to
    // adb, which this harness does not provide), but it must NOT have taken the
    // replace path. That is the property worth pinning.
    expect(requestSetText).not.toHaveBeenCalled();
  });

  test("routes iOS text input through existing platform input infrastructure", async () => {
    const requestSetText = mock(async () => ({ success: true, totalTimeMs: 1 }));
    const requestImeAction = mock(async () => ({ success: true, totalTimeMs: 1 }));
    IOSCtrlProxyClient.getInstance = mock(() => ({
      requestSetText,
      requestImeAction,
    })) as unknown as typeof IOSCtrlProxyClient.getInstance;
    PlatformDeviceManagerFactory.setInstance(createFakeDeviceManager([iosDevice]));
    server = new UnixSocketServer(socketPath, "http://localhost:0/mcp", createFakeDaemonState(), fakeTimer);
    await server.start();

    const response = await sendRequest(socketPath, "input/typeText", {
      platform: "ios",
      deviceId: "ios-sim-1",
      text: "hi there",
      submit: true,
    });

    expect(response.success).toBe(true);
    expect(response.result).toMatchObject({
      action: "input/typeText",
      platform: "ios",
      deviceId: "ios-sim-1",
      success: true,
      textLength: 8,
      submitted: true,
    });
    expect(requestSetText).toHaveBeenCalledWith("hi there", { timeoutMs: 30_000 });
    expect(requestImeAction).toHaveBeenCalledWith("done", 30_000);
  });

  test("uses the socket autolock device when deviceId is omitted", async () => {
    const requestSetText = mock(async () => ({ success: true, totalTimeMs: 1 }));
    const requestImeAction = mock(async () => ({ success: true, totalTimeMs: 1 }));
    AndroidCtrlProxyClient.getInstance = mock(() => ({
      requestSetText,
      requestImeAction,
    })) as unknown as typeof AndroidCtrlProxyClient.getInstance;
    PlatformDeviceManagerFactory.setInstance(createFakeDeviceManager([androidDevice]));
    const session = createFakeSession("session-1", "emulator-5554", "android");
    const autolockSessions = new Map([[session.sessionId, session]]);
    const mcpAutolockSessions = new Map<string, string>();
    server = new UnixSocketServer(
      socketPath,
      "http://localhost:0/mcp",
      createFakeDaemonState(autolockSessions, mcpAutolockSessions),
      fakeTimer
    );
    await server.start();

    const response = await sendRequestAfterConnect(socketPath, {
      id: randomUUID(),
      type: "mcp_request",
      method: "input/typeText",
      params: {
        platform: "android",
        text: "from session",
      },
    }, () => {
      const socketSessionId = [...((server as unknown as { sessions: Map<string, unknown> }).sessions.keys())][0];
      mcpAutolockSessions.set(socketSessionId, session.sessionId);
    });

    expect(response.success).toBe(true);
    expect(response.result).toMatchObject({
      platform: "android",
      deviceId: "emulator-5554",
      textLength: 12,
    });
    expect(requestSetText).toHaveBeenCalledWith("from session", { timeoutMs: 30_000 });
    expect(requestImeAction).not.toHaveBeenCalled();
  });

  test("serializes concurrent typeText calls for the same device", async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    const requestSetText = mock(async () => {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise<void>(resolve => {
        fakeTimer.setTimeout(resolve, 40);
      });
      inFlight -= 1;
      return { success: true, totalTimeMs: 1 };
    });
    const requestImeAction = mock(async () => ({ success: true, totalTimeMs: 1 }));
    AndroidCtrlProxyClient.getInstance = mock(() => ({
      requestSetText,
      requestImeAction,
    })) as unknown as typeof AndroidCtrlProxyClient.getInstance;
    PlatformDeviceManagerFactory.setInstance(createFakeDeviceManager([androidDevice]));
    server = new UnixSocketServer(socketPath, "http://localhost:0/mcp", createFakeDaemonState(), fakeTimer);
    await server.start();

    const firstPromise = sendRequest(socketPath, "input/typeText", {
      platform: "android",
      deviceId: "emulator-5554",
      text: "first",
    });
    const secondPromise = sendRequest(socketPath, "input/typeText", {
      platform: "android",
      deviceId: "emulator-5554",
      text: "second",
    });

    for (let i = 0; i < 10; i++) {
      await new Promise<void>(resolve => setImmediate(resolve));
    }
    fakeTimer.advanceTime(40);
    for (let i = 0; i < 10; i++) {
      await new Promise<void>(resolve => setImmediate(resolve));
    }
    fakeTimer.advanceTime(40);

    const [first, second] = await Promise.all([firstPromise, secondPromise]);

    expect(first.success).toBe(true);
    expect(second.success).toBe(true);
    expect(requestSetText).toHaveBeenCalledTimes(2);
    expect(maxInFlight).toBe(1);
    expect(inFlight).toBe(0);
  });

  test("fails typeText when execution exceeds the socket timeout budget", async () => {
    const requestSetText = mock(async () => {
      await new Promise<void>(resolve => {
        fakeTimer.setTimeout(resolve, 100);
      });
      return { success: true, totalTimeMs: 1 };
    });
    const requestImeAction = mock(async () => ({ success: true, totalTimeMs: 1 }));
    AndroidCtrlProxyClient.getInstance = mock(() => ({
      requestSetText,
      requestImeAction,
    })) as unknown as typeof AndroidCtrlProxyClient.getInstance;
    PlatformDeviceManagerFactory.setInstance(createFakeDeviceManager([androidDevice]));
    server = new UnixSocketServer(socketPath, "http://localhost:0/mcp", createFakeDaemonState(), fakeTimer);
    await server.start();

    const responsePromise = sendRequest(socketPath, "input/typeText", {
      platform: "android",
      deviceId: "emulator-5554",
      text: "slow",
    }, 1);

    for (let i = 0; i < 10; i++) {
      await new Promise<void>(resolve => setImmediate(resolve));
    }
    fakeTimer.advanceTime(1);
    for (let i = 0; i < 10; i++) {
      await new Promise<void>(resolve => setImmediate(resolve));
    }
    fakeTimer.advanceTime(99);

    const response = await responsePromise;

    expect(response.success).toBe(false);
    expect(response.error).toContain("input/typeText exceeded 1ms");
    expect(response.error).toContain("operation exceeded remaining budget 1ms");
    expect(requestSetText).toHaveBeenCalledWith("slow", { timeoutMs: 1 });
    expect(requestImeAction).not.toHaveBeenCalled();
  });

  test("keeps same-device typeText serialized until a timed-out operation settles", async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    const requestSetText = mock(async (text: string) => {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      if (text === "first") {
        await new Promise<void>(resolve => {
          fakeTimer.setTimeout(resolve, 100);
        });
      }
      inFlight -= 1;
      return { success: true, totalTimeMs: 1 };
    });
    const requestImeAction = mock(async () => ({ success: true, totalTimeMs: 1 }));
    AndroidCtrlProxyClient.getInstance = mock(() => ({
      requestSetText,
      requestImeAction,
    })) as unknown as typeof AndroidCtrlProxyClient.getInstance;
    PlatformDeviceManagerFactory.setInstance(createFakeDeviceManager([androidDevice]));
    server = new UnixSocketServer(socketPath, "http://localhost:0/mcp", createFakeDaemonState(), fakeTimer);
    await server.start();

    const firstPromise = sendRequest(socketPath, "input/typeText", {
      platform: "android",
      deviceId: "emulator-5554",
      text: "first",
    }, 1);

    for (let i = 0; i < 10; i++) {
      await new Promise<void>(resolve => setImmediate(resolve));
    }
    fakeTimer.advanceTime(1);

    const secondPromise = sendRequest(socketPath, "input/typeText", {
      platform: "android",
      deviceId: "emulator-5554",
      text: "second",
    });

    for (let i = 0; i < 10; i++) {
      await new Promise<void>(resolve => setImmediate(resolve));
    }
    expect(requestSetText).toHaveBeenCalledTimes(1);
    expect(inFlight).toBe(1);

    fakeTimer.advanceTime(99);
    for (let i = 0; i < 10; i++) {
      await new Promise<void>(resolve => setImmediate(resolve));
    }

    const [first, second] = await Promise.all([firstPromise, secondPromise]);

    expect(first.success).toBe(false);
    expect(second.success).toBe(true);
    expect(requestSetText).toHaveBeenCalledTimes(2);
    expect(maxInFlight).toBe(1);
    expect(inFlight).toBe(0);
  });

  test("fails when submit action fails after text input succeeds", async () => {
    const requestSetText = mock(async () => ({ success: true, totalTimeMs: 1 }));
    const requestImeAction = mock(async () => ({
      success: false,
      error: "return key unavailable",
      totalTimeMs: 1,
    }));
    IOSCtrlProxyClient.getInstance = mock(() => ({
      requestSetText,
      requestImeAction,
    })) as unknown as typeof IOSCtrlProxyClient.getInstance;
    PlatformDeviceManagerFactory.setInstance(createFakeDeviceManager([iosDevice]));
    server = new UnixSocketServer(socketPath, "http://localhost:0/mcp", createFakeDaemonState(), fakeTimer);
    await server.start();

    const response = await sendRequest(socketPath, "input/typeText", {
      platform: "ios",
      deviceId: "ios-sim-1",
      text: "hi there",
      submit: true,
    });

    expect(response.success).toBe(false);
    expect(response.error).toBe("return key unavailable");
    expect(requestSetText).toHaveBeenCalledWith("hi there", { timeoutMs: 30_000 });
    expect(requestImeAction).toHaveBeenCalledWith("done", 30_000);
  });

  test("charges the submit IME action against the remaining shared budget", async () => {
    const requestSetText = mock(async () => {
      await new Promise<void>(resolve => {
        fakeTimer.setTimeout(resolve, 40);
      });
      return { success: true, totalTimeMs: 1 };
    });
    const requestImeAction = mock(async () => ({ success: true, totalTimeMs: 1 }));
    AndroidCtrlProxyClient.getInstance = mock(() => ({
      requestSetText,
      requestImeAction,
    })) as unknown as typeof AndroidCtrlProxyClient.getInstance;
    PlatformDeviceManagerFactory.setInstance(createFakeDeviceManager([androidDevice]));
    server = new UnixSocketServer(socketPath, "http://localhost:0/mcp", createFakeDaemonState(), fakeTimer);
    await server.start();

    const responsePromise = sendRequest(socketPath, "input/typeText", {
      platform: "android",
      deviceId: "emulator-5554",
      text: "hello",
      submit: true,
    }, 100);

    for (let i = 0; i < 10; i++) {
      await new Promise<void>(resolve => setImmediate(resolve));
    }
    fakeTimer.advanceTime(40);
    for (let i = 0; i < 10; i++) {
      await new Promise<void>(resolve => setImmediate(resolve));
    }

    const response = await responsePromise;

    expect(response.success).toBe(true);
    // set-text consumed 40ms of the 100ms budget, so the IME action gets the
    // remaining 60ms rather than a fresh full timeout.
    expect(requestSetText).toHaveBeenCalledWith("hello", { timeoutMs: 100 });
    expect(requestImeAction).toHaveBeenCalledWith("done", 60);
  });

  test("rejects missing, empty, and non-string text with actionable errors", async () => {
    PlatformDeviceManagerFactory.setInstance(createFakeDeviceManager([androidDevice]));
    server = new UnixSocketServer(socketPath, "http://localhost:0/mcp", createFakeDaemonState(), fakeTimer);
    await server.start();

    const missing = await sendRequest(socketPath, "input/typeText", {
      platform: "android",
    });
    const empty = await sendRequest(socketPath, "input/typeText", {
      platform: "android",
      text: "",
    });
    const nonString = await sendRequest(socketPath, "input/typeText", {
      platform: "android",
      text: 123,
    });
    const nonBooleanSubmit = await sendRequest(socketPath, "input/typeText", {
      platform: "android",
      text: "hello",
      submit: "true",
    });
    // `mode` is now a supported param, but only the value "append" (#3351):
    // the other InputText modes are replace-shaped and have no meaning here.
    const unsupportedMode = await sendRequest(socketPath, "input/typeText", {
      platform: "android",
      text: "hello",
      mode: "eventAll",
    });
    const appendOnIos = await sendRequest(socketPath, "input/typeText", {
      platform: "ios",
      text: "hello",
      mode: "append",
    });
    const unsupportedImeAction = await sendRequest(socketPath, "input/typeText", {
      platform: "android",
      text: "hello",
      imeAction: "done",
    });
    const unsupportedDismissKeyboard = await sendRequest(socketPath, "input/typeText", {
      platform: "android",
      text: "hello",
      dismissKeyboard: true,
    });

    expect(missing.success).toBe(false);
    expect(missing.error).toBe("input/typeText requires non-empty string text param");
    expect(empty.success).toBe(false);
    expect(empty.error).toBe("input/typeText requires non-empty string text param");
    expect(nonString.success).toBe(false);
    expect(nonString.error).toBe("input/typeText requires non-empty string text param");
    expect(nonBooleanSubmit.success).toBe(false);
    expect(nonBooleanSubmit.error).toBe("input/typeText submit must be a boolean when provided");
    expect(unsupportedMode.success).toBe(false);
    expect(unsupportedMode.error).toBe('input/typeText mode must be "append" when provided');
    // iOS has no append-capable text primitive, so the request is REJECTED rather
    // than silently downgraded to the destructive replace path.
    expect(appendOnIos.success).toBe(false);
    expect(appendOnIos.error).toBe('input/typeText mode "append" is only supported on android');
    expect(unsupportedImeAction.success).toBe(false);
    expect(unsupportedImeAction.error).toBe("input/typeText unsupported params: imeAction");
    expect(unsupportedDismissKeyboard.success).toBe(false);
    expect(unsupportedDismissKeyboard.error).toBe("input/typeText unsupported params: dismissKeyboard");
  });
});
