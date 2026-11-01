import { spyOn } from "bun:test";
import { drainMicrotasks } from "../helpers/fakeTimerStepping";
import { executionTracker } from "../../src/daemon/executionTracker";
import { AndroidCtrlProxyClient } from "../../src/features/observe/android";
import { IOSCtrlProxyClient } from "../../src/features/observe/ios";
import {
  androidDevice,
  createFakeDaemonState,
  createFakeDeviceManager,
  createFakeSession,
  iosDevice,
} from "./helpers/inputSocketHarness";
import {
  createHarnessServer,
  type UnixSocketServerHarness,
} from "./helpers/UnixSocketServerHarness";
import { defaultAdbClientFactory } from "../../src/utils/android-cmdline-tools/AdbClientFactory";
import { createExecResult } from "../../src/utils/execResult";
import { FakeAdbExecutor } from "../fakes/FakeAdbExecutor";
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sendRawSocketRequest } from "./helpers/socketRequest";
import { InputKey, type InputKeyName } from "../../src/features/action/InputKey";
import { PlatformDeviceManagerFactory } from "../../src/utils/factories/PlatformDeviceManagerFactory";
import { FakeTimer } from "../fakes/FakeTimer";
import type { DaemonRequest, DaemonResponse } from "../../src/daemon/types";
import type { InputKeyResult } from "../../src/features/action/InputKey";

function sendRequest(
  socketPath: string,
  method: string,
  params: Record<string, unknown> = {},
  timeoutMs?: number,
): Promise<{ response: DaemonResponse; frameCount: number }> {
  const request: DaemonRequest = {
    id: randomUUID(),
    type: "mcp_request",
    method,
    params,
    ...(timeoutMs === undefined ? {} : { timeoutMs }),
  };
  // "drain" resolves on close with the LAST frame and the total frame count,
  // so the tests below can assert the server wrote exactly one response frame.
  return sendRawSocketRequest(socketPath, request, { resolveOn: "drain" });
}

describe("UnixSocketServer input/key", () => {
  let socketPath: string;
  let server: UnixSocketServerHarness;
  let fakeTimer: FakeTimer;
  let originalPress: typeof InputKey.prototype.press;

  beforeEach(async () => {
    socketPath = join(tmpdir(), `input-key-${randomUUID()}.sock`);
    fakeTimer = new FakeTimer();
    PlatformDeviceManagerFactory.reset();
    originalPress = InputKey.prototype.press;
  });

  afterEach(async () => {
    if (server) {
      await server.close();
    }
    if (existsSync(socketPath)) {
      await unlink(socketPath);
    }
    InputKey.prototype.press = originalPress;
    PlatformDeviceManagerFactory.reset();
    mock.restore();
    AndroidCtrlProxyClient.clearInstanceRegistryForTesting();
    IOSCtrlProxyClient.clearInstanceRegistryForTesting();
    executionTracker.clearDaemonRestartPreparation();
    executionTracker.clearDaemonMaintenancePreparation();
  });

  test("routes Android key presses without forwarding through tools/call", async () => {
    const press = mock(async (key: InputKeyName): Promise<InputKeyResult> => ({
      success: true,
      key,
      keyCode: "KEYCODE_ENTER",
    }));
    const createMcpClient = mock(async () => {
      throw new Error("input/key should not create an MCP client");
    });
    InputKey.prototype.press = press;
    PlatformDeviceManagerFactory.setInstance(createFakeDeviceManager([androidDevice]));
    server = createHarnessServer(socketPath, createFakeDaemonState(), fakeTimer);
    server.mcpClientFactory = createMcpClient;
    await server.start();

    const { response, frameCount } = await sendRequest(
      socketPath,
      "input/key",
      {
        platform: "android",
        deviceId: "emulator-5554",
        key: "enter",
      },
      1234,
    );

    expect(frameCount).toBe(1);
    expect(response.success).toBe(true);
    expect(response.result).toEqual({
      action: "input/key",
      platform: "android",
      deviceId: "emulator-5554",
      success: true,
      key: "enter",
    });
    expect(press).toHaveBeenCalledWith("enter", 1234, undefined, {
      modifiers: [],
      signal: expect.any(AbortSignal),
      onDispatch: expect.any(Function),
    });
    expect(createMcpClient).not.toHaveBeenCalled();
  });

  test("forwards an Android frame context to the key implementation", async () => {
    const press = mock(async (key: InputKeyName): Promise<InputKeyResult> => ({
      success: true,
      key,
      keyCode: "KEYCODE_ENTER",
    }));
    InputKey.prototype.press = press;
    PlatformDeviceManagerFactory.setInstance(createFakeDeviceManager([androidDevice]));
    server = createHarnessServer(socketPath, createFakeDaemonState(), fakeTimer);
    server.stubFrameContextCheck();
    await server.start();

    const { response } = await sendRequest(socketPath, "input/key", {
      platform: "android",
      deviceId: "emulator-5554",
      key: "enter",
      frameContext: "frame-1",
    });

    expect(response.success).toBe(true);
    expect(press).toHaveBeenCalledWith("enter", 30_000, "frame-1", {
      modifiers: [],
      signal: expect.any(AbortSignal),
      onDispatch: expect.any(Function),
    });
  });

  test("returns one clear unsupported-platform response for iOS", async () => {
    const press = mock(async (key: InputKeyName): Promise<InputKeyResult> => ({
      success: false,
      key,
      keyCode: "",
      error: "input/key is unsupported on ios; CtrlProxy does not expose discrete key events",
    }));
    InputKey.prototype.press = press;
    PlatformDeviceManagerFactory.setInstance(createFakeDeviceManager([iosDevice]));
    server = createHarnessServer(socketPath, createFakeDaemonState(), fakeTimer);
    await server.start();

    const { response, frameCount } = await sendRequest(socketPath, "input/key", {
      platform: "ios",
      deviceId: "ios-sim-1",
      key: "enter",
    });

    expect(frameCount).toBe(1);
    expect(response.success).toBe(false);
    expect(response.error).toBe(
      "input/key is unsupported on ios; CtrlProxy does not expose discrete key events",
    );
    expect(press).not.toHaveBeenCalled();
  });

  test("returns the iOS unsupported error without requiring iOS device discovery", async () => {
    InputKey.prototype.press = mock(async () => {
      throw new Error("iOS unsupported should be reported before routing");
    });
    PlatformDeviceManagerFactory.setInstance(createFakeDeviceManager([]));
    server = createHarnessServer(socketPath, createFakeDaemonState(), fakeTimer);
    await server.start();

    const { response, frameCount } = await sendRequest(socketPath, "input/key", {
      platform: "ios",
      key: "enter",
    });

    expect(frameCount).toBe(1);
    expect(response.success).toBe(false);
    expect(response.error).toBe(
      "input/key is unsupported on ios; CtrlProxy does not expose discrete key events",
    );
  });

  test("returns the iOS unsupported error without requiring an iOS deviceId", async () => {
    InputKey.prototype.press = mock(async () => {
      throw new Error("iOS unsupported should be reported before routing");
    });
    PlatformDeviceManagerFactory.setInstance(
      createFakeDeviceManager([
        iosDevice,
        { ...iosDevice, deviceId: "ios-sim-2", name: "iPhone 16 Pro" },
      ]),
    );
    server = createHarnessServer(socketPath, createFakeDaemonState(), fakeTimer);
    await server.start();

    const { response, frameCount } = await sendRequest(socketPath, "input/key", {
      platform: "ios",
      key: "enter",
    });

    expect(frameCount).toBe(1);
    expect(response.success).toBe(false);
    expect(response.error).toBe(
      "input/key is unsupported on ios; CtrlProxy does not expose discrete key events",
    );
  });

  test("validates the key payload and rejects modifiers in the first version", async () => {
    InputKey.prototype.press = mock(async () => {
      throw new Error("validation should fail before routing");
    });
    PlatformDeviceManagerFactory.setInstance(createFakeDeviceManager([androidDevice]));
    server = createHarnessServer(socketPath, createFakeDaemonState(), fakeTimer);
    await server.start();

    const missing = await sendRequest(socketPath, "input/key", {
      platform: "android",
    });
    const unsupported = await sendRequest(socketPath, "input/key", {
      platform: "android",
      key: "page_down",
    });
    const modifiers = await sendRequest(socketPath, "input/key", {
      platform: "android",
      key: "enter",
      modifiers: ["shift"],
    });

    expect(missing.response.success).toBe(false);
    expect(missing.response.error).toBe("input/key requires key");
    expect(missing.frameCount).toBe(1);
    expect(unsupported.response.success).toBe(false);
    expect(unsupported.response.error).toBe(
      "input/key key must be one of: enter, tab, escape, backspace, delete, arrow_up, arrow_down, arrow_left, arrow_right",
    );
    expect(unsupported.frameCount).toBe(1);
    expect(modifiers.response.success).toBe(false);
    expect(modifiers.response.error).toBe("input/key unsupported params: modifiers");
    expect(modifiers.frameCount).toBe(1);
  });
  test("tracks direct input until a session-loss drain can safely finish", async () => {
    const operationStarted = Promise.withResolvers<void>();
    const releaseOperation = Promise.withResolvers<void>();
    let sent = false;
    const adb = new FakeAdbExecutor();
    spyOn(defaultAdbClientFactory, "create").mockReturnValue(adb);
    const deviceRequest = spyOn(adb, "execute").mockImplementation(async (_args, options) => {
      await options?.beforeDispatch?.(options.timeoutMs);
      options?.signal?.throwIfAborted();
      sent = true;
      operationStarted.resolve();
      await releaseOperation.promise;
      return createExecResult("", "");
    });
    PlatformDeviceManagerFactory.setInstance(createFakeDeviceManager([androidDevice]));
    const sessionId = "direct-key-after-dispatch-session";
    const sessions = new Map([
      [sessionId, createFakeSession(sessionId, androidDevice.deviceId, "android")],
    ]);
    server = createHarnessServer(socketPath, createFakeDaemonState(sessions), fakeTimer);
    await server.start();
    const response = sendRequest(socketPath, "input/key", {
      platform: "android",
      deviceId: androidDevice.deviceId,
      key: "enter",
      sessionUuid: sessionId,
    }).then((value) => value.response);
    await operationStarted.promise;
    expect(executionTracker.hasActiveSessionUuidExecutions(sessionId)).toBe(true);
    expect(await executionTracker.cancelDeviceSessionExecutions(sessionId, "test recovery")).toBe(
      1,
    );
    let drained = false;
    const drain = executionTracker
      .waitForDeviceSessionExecutionsToEnd(sessionId, 1_000)
      .then((result) => {
        drained = result;
        return result;
      });
    await drainMicrotasks(100);
    // Dispatch is latched exactly as in the real client; drain waits for its runner reply.
    expect(drained).toBe(false);
    releaseOperation.resolve();
    expect(await drain).toBe(true);
    const failure = await response;
    expect(failure.success).toBe(false);
    expect(failure.error).toContain("indeterminate");
    expect(sent).toBe(true);
    await deviceRequest.mock.results[0]!.value;
    expect(executionTracker.hasActiveSessionUuidExecutions(sessionId)).toBe(false);
  });

  test("a direct input cancelled before dispatch lets a session-loss drain finish at once and is never sent", async () => {
    const operationStarted = Promise.withResolvers<void>();
    const releaseOperation = Promise.withResolvers<void>();
    let sent = false;
    const adb = new FakeAdbExecutor();
    spyOn(defaultAdbClientFactory, "create").mockReturnValue(adb);
    const deviceRequest = spyOn(adb, "execute").mockImplementation(async (_args, options) => {
      operationStarted.resolve();
      await releaseOperation.promise;
      await options?.beforeDispatch?.(options.timeoutMs);
      options?.signal?.throwIfAborted();
      sent = true;
      return createExecResult("", "");
    });
    PlatformDeviceManagerFactory.setInstance(createFakeDeviceManager([androidDevice]));
    const sessionId = "direct-key-before-dispatch-session";
    const sessions = new Map([
      [sessionId, createFakeSession(sessionId, androidDevice.deviceId, "android")],
    ]);
    server = createHarnessServer(socketPath, createFakeDaemonState(sessions), fakeTimer);
    await server.start();
    const response = sendRequest(socketPath, "input/key", {
      platform: "android",
      deviceId: androidDevice.deviceId,
      key: "enter",
      sessionUuid: sessionId,
    }).then((value) => value.response);
    await operationStarted.promise;
    expect(executionTracker.hasActiveSessionUuidExecutions(sessionId)).toBe(true);
    expect(await executionTracker.cancelDeviceSessionExecutions(sessionId, "test recovery")).toBe(
      1,
    );
    let drained = false;
    const drain = executionTracker
      .waitForDeviceSessionExecutionsToEnd(sessionId, 1_000)
      .then((result) => {
        drained = result;
        return result;
      });
    await drainMicrotasks(100);
    expect(drained).toBe(true);
    expect(await drain).toBe(true);
    expect((await response).success).toBe(false);
    releaseOperation.resolve();
    await expect(deviceRequest.mock.results[0]!.value).rejects.toThrow();
    await drainMicrotasks(100);
    expect(sent).toBe(false);
    expect(executionTracker.hasActiveSessionUuidExecutions(sessionId)).toBe(false);
  });
});
