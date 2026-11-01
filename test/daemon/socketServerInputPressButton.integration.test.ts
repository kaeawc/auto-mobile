import { spyOn } from "bun:test";
import { drainMicrotasks } from "../helpers/fakeTimerStepping";
import { executionTracker } from "../../src/daemon/executionTracker";
import { AndroidCtrlProxyClient } from "../../src/features/observe/android";
import { IOSCtrlProxyClient } from "../../src/features/observe/ios";
import {
  createFakeDaemonState,
  createFakeDaemonState as createDrainDaemonState,
  createFakeDeviceManager,
  createFakeSession,
  createFakeSession as createDrainSession,
} from "./helpers/inputSocketHarness";
import { UnixSocketServerHarness } from "./helpers/UnixSocketServerHarness";
import { createAndroidTestClient } from "../helpers/androidCtrlProxyClientSpies";
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sendRawSocketRequest, sendSocketRequest } from "./helpers/socketRequest";
import { PressButton } from "../../src/features/action/PressButton";
import { PlatformDeviceManagerFactory } from "../../src/utils/factories/PlatformDeviceManagerFactory";
import { FakeTimer } from "../fakes/FakeTimer";
import type { DaemonRequest, DaemonResponse } from "../../src/daemon/types";
import type { DeviceLabelMap } from "../../src/daemon/sessionManager";
import type { BootedDevice, PressButtonResult } from "../../src/models";

const androidDevice: BootedDevice = {
  deviceId: "emulator-5554",
  name: "Pixel",
  platform: "android",
};

const iosDevice: BootedDevice = {
  deviceId: "ios-sim-1",
  name: "iPhone 16",
  platform: "ios",
};

const unexpectedDaemonState = (): never => {
  throw new Error("Unexpected daemon state access");
};

function sendRequest(
  socketPath: string,
  method: string,
  params: Record<string, unknown> = {},
  timeoutMs?: number,
): Promise<DaemonResponse> {
  return sendSocketRequest(socketPath, method, params, timeoutMs);
}

async function sendRequestAfterConnect(
  socketPath: string,
  request: DaemonRequest,
  onConnect: () => void,
): Promise<DaemonResponse> {
  const { response } = await sendRawSocketRequest(socketPath, request, { onConnect });
  return response;
}

describe("UnixSocketServer input/pressButton", () => {
  let socketPath: string;
  let server: UnixSocketServerHarness;
  let fakeTimer: FakeTimer;
  let originalPress: typeof PressButton.prototype.press;

  beforeEach(async () => {
    socketPath = join(tmpdir(), `input-press-button-${randomUUID()}.sock`);
    fakeTimer = new FakeTimer();
    PlatformDeviceManagerFactory.reset();
    originalPress = PressButton.prototype.press;
  });

  afterEach(async () => {
    if (server) {
      await server.close();
    }
    if (existsSync(socketPath)) {
      await unlink(socketPath);
    }
    PressButton.prototype.press = originalPress;
    PlatformDeviceManagerFactory.reset();
    mock.restore();
    AndroidCtrlProxyClient.clearInstanceRegistryForTesting();
    IOSCtrlProxyClient.clearInstanceRegistryForTesting();
    executionTracker.clearDaemonRestartPreparation();
    executionTracker.clearDaemonMaintenancePreparation();
  });

  test("routes Android button presses without forwarding through tools/call", async () => {
    const press = mock(async (button: string): Promise<PressButtonResult> => ({
      success: true,
      button,
      keyCode: 24,
    }));
    const createMcpClient = mock(async () => {
      throw new Error("input/pressButton should not create an MCP client");
    });
    PressButton.prototype.press = press;
    PlatformDeviceManagerFactory.setInstance(createFakeDeviceManager([androidDevice]));
    server = new UnixSocketServerHarness(socketPath, createFakeDaemonState(), fakeTimer);
    server.mcpClientFactory = createMcpClient;
    await server.start();

    const response = await sendRequest(socketPath, "input/pressButton", {
      platform: "android",
      deviceId: "emulator-5554",
      button: "volume_up",
    });

    expect(response.success).toBe(true);
    expect(response.result).toEqual({
      action: "input/pressButton",
      platform: "android",
      deviceId: "emulator-5554",
      success: true,
      button: "volume_up",
    });
    expect(press).toHaveBeenCalledWith("volume_up", {
      timeoutMs: expect.any(Number),
      signal: expect.any(AbortSignal),
      onDispatch: expect.any(Function),
    });
    expect(createMcpClient).not.toHaveBeenCalled();
  });

  test("forwards an Android frame context to the button implementation", async () => {
    const press = mock(async (button: string): Promise<PressButtonResult> => ({
      success: true,
      button,
      keyCode: 4,
    }));
    PressButton.prototype.press = press;
    PlatformDeviceManagerFactory.setInstance(createFakeDeviceManager([androidDevice]));
    server = new UnixSocketServerHarness(socketPath, createFakeDaemonState(), fakeTimer);
    server.stubFrameContextCheck();
    await server.start();

    const response = await sendRequest(socketPath, "input/pressButton", {
      platform: "android",
      deviceId: "emulator-5554",
      button: "back",
      frameContext: "frame-1",
    });

    expect(response.success).toBe(true);
    expect(press).toHaveBeenCalledWith("back", {
      timeoutMs: 30_000,
      frameContext: "frame-1",
      signal: expect.any(AbortSignal),
      onDispatch: expect.any(Function),
    });
  });

  test("routes iOS button presses through the existing pressButton implementation", async () => {
    const press = mock(async (button: string): Promise<PressButtonResult> => ({
      success: true,
      button,
      keyCode: -1,
    }));
    PressButton.prototype.press = press;
    PlatformDeviceManagerFactory.setInstance(createFakeDeviceManager([iosDevice]));
    server = new UnixSocketServerHarness(socketPath, createFakeDaemonState(), fakeTimer);
    await server.start();

    const response = await sendRequest(socketPath, "input/pressButton", {
      platform: "ios",
      deviceId: "ios-sim-1",
      button: "home",
    });

    expect(response.success).toBe(true);
    expect(response.result).toEqual({
      action: "input/pressButton",
      platform: "ios",
      deviceId: "ios-sim-1",
      success: true,
      button: "home",
    });
    expect(press).toHaveBeenCalledWith("home", {
      timeoutMs: expect.any(Number),
      signal: expect.any(AbortSignal),
      onDispatch: expect.any(Function),
    });
  });

  test("threads the client-supplied timeout budget into the button implementation", async () => {
    const press = mock(async (button: string): Promise<PressButtonResult> => ({
      success: true,
      button,
      keyCode: -1,
    }));
    PressButton.prototype.press = press;
    PlatformDeviceManagerFactory.setInstance(createFakeDeviceManager([iosDevice]));
    server = new UnixSocketServerHarness(socketPath, createFakeDaemonState(), fakeTimer);
    await server.start();

    // With the FakeTimer no wall-clock elapses in the queue, so the remaining
    // budget threaded into press() equals the client's requested timeout.
    const response = await sendRequest(
      socketPath,
      "input/pressButton",
      {
        platform: "ios",
        deviceId: "ios-sim-1",
        button: "home",
      },
      500,
    );

    expect(response.success).toBe(true);
    expect(press).toHaveBeenCalledWith("home", {
      timeoutMs: 500,
      signal: expect.any(AbortSignal),
      onDispatch: expect.any(Function),
    });
  });

  test("maps the socket app_switch contract name to the existing recent button implementation", async () => {
    const press = mock(async (button: string): Promise<PressButtonResult> => ({
      success: true,
      button,
      keyCode: -1,
    }));
    PressButton.prototype.press = press;
    PlatformDeviceManagerFactory.setInstance(createFakeDeviceManager([iosDevice]));
    server = new UnixSocketServerHarness(socketPath, createFakeDaemonState(), fakeTimer);
    await server.start();

    const response = await sendRequest(socketPath, "input/pressButton", {
      platform: "ios",
      deviceId: "ios-sim-1",
      button: "app_switch",
    });

    expect(response.success).toBe(true);
    expect(response.result).toEqual({
      action: "input/pressButton",
      platform: "ios",
      deviceId: "ios-sim-1",
      success: true,
      button: "app_switch",
    });
    expect(press).toHaveBeenCalledWith("recent", {
      timeoutMs: expect.any(Number),
      signal: expect.any(AbortSignal),
      onDispatch: expect.any(Function),
    });
  });

  test("uses the socket autolock device when deviceId is omitted", async () => {
    const press = mock(async (button: string): Promise<PressButtonResult> => ({
      success: true,
      button,
      keyCode: 4,
    }));
    PressButton.prototype.press = press;
    PlatformDeviceManagerFactory.setInstance(createFakeDeviceManager([androidDevice]));
    const session = createFakeSession("session-1", "emulator-5554", "android");
    const autolockSessions = new Map([[session.sessionId, session]]);
    const mcpAutolockSessions = new Map<string, string>();
    server = new UnixSocketServerHarness(
      socketPath,
      createFakeDaemonState(autolockSessions, mcpAutolockSessions),
      fakeTimer,
    );
    await server.start();

    const response = await sendRequestAfterConnect(
      socketPath,
      {
        id: randomUUID(),
        type: "mcp_request",
        method: "input/pressButton",
        params: {
          platform: "android",
          button: "back",
        },
      },
      () => {
        const socketSessionId = server.sessionIds[0];
        mcpAutolockSessions.set(socketSessionId, session.sessionId);
      },
    );

    expect(response.success).toBe(true);
    expect(response.result).toMatchObject({
      platform: "android",
      deviceId: "emulator-5554",
      button: "back",
    });
    expect(press).toHaveBeenCalledWith("back", {
      timeoutMs: expect.any(Number),
      signal: expect.any(AbortSignal),
      onDispatch: expect.any(Function),
    });
  });

  test("propagates clear unsupported platform-gap errors from the button implementation", async () => {
    const press = mock(async (button: string): Promise<PressButtonResult> => ({
      success: false,
      button,
      keyCode: -1,
      error: "iOS has no menu hardware button",
    }));
    PressButton.prototype.press = press;
    PlatformDeviceManagerFactory.setInstance(createFakeDeviceManager([iosDevice]));
    server = new UnixSocketServerHarness(socketPath, createFakeDaemonState(), fakeTimer);
    await server.start();

    const response = await sendRequest(socketPath, "input/pressButton", {
      platform: "ios",
      deviceId: "ios-sim-1",
      button: "menu",
    });

    expect(response.success).toBe(false);
    expect(response.error).toBe("iOS has no menu hardware button");
    expect(press).toHaveBeenCalledWith("menu", {
      timeoutMs: expect.any(Number),
      signal: expect.any(AbortSignal),
      onDispatch: expect.any(Function),
    });
  });

  test("forwards the tracked session abort signal to press on the bound-session path (#6289)", async () => {
    // A bound session makes runTrackedDeviceInput start an execution and hand its
    // abort controller's signal to the operation. That tracked signal MUST reach
    // press() as its fourth argument, otherwise session teardown mid-home-press
    // leaves the ADB dispatch and foreground reads running.
    let receivedSignal: AbortSignal | undefined;
    const press = mock(
      async (
        button: string,
        options: { signal?: AbortSignal } = {},
      ): Promise<PressButtonResult> => {
        receivedSignal = options.signal;
        return { success: true, button, keyCode: 3 };
      },
    );
    PressButton.prototype.press = press;
    PlatformDeviceManagerFactory.setInstance(createFakeDeviceManager([androidDevice]));

    // Stable sessionManager/devicePool references (createFakeDaemonState builds
    // fresh objects per getter call, so bound-session hooks would not survive).
    const sessionManager = {
      hasSession: () => false,
      getSession: () => null,
      getDeviceLabels: (): DeviceLabelMap | undefined => undefined,
      releaseSession: async () => null,
      getSessionForDevice: (deviceId: string) =>
        deviceId === "emulator-5554" ? "session-uuid-1" : null,
    };
    const devicePool = {
      refreshDevices: async () => 0,
      getStats: () => ({ total: 0, idle: 0, assigned: 0, error: 0 }),
      releaseDevice: async () => {},
      resolveAutolockSessionForMcpSession: () => undefined,
      assertSessionReadyForAutomation: () => {},
    };
    const daemonState = {
      isInitialized: () => true,
      getDeviceSessionRegistry: unexpectedDaemonState,
      getSessionManager: () => sessionManager,
      getDevicePool: () => devicePool,
    };

    server = new UnixSocketServerHarness(socketPath, daemonState, fakeTimer);
    await server.start();

    const response = await sendRequest(socketPath, "input/pressButton", {
      platform: "android",
      deviceId: "emulator-5554",
      button: "home",
      // The device is held, so only its holder may press (#10698).
      sessionUuid: "session-uuid-1",
    });

    expect(response.success).toBe(true);
    expect(press).toHaveBeenCalledWith("home", {
      timeoutMs: expect.any(Number),
      signal: expect.any(AbortSignal),
      onDispatch: expect.any(Function),
    });
    expect(receivedSignal).toBeInstanceOf(AbortSignal);
  });

  test("rejects enter before calling the platform button handler", async () => {
    const press = mock(async (button: string): Promise<PressButtonResult> => ({
      success: false,
      button,
      keyCode: -1,
      error: "Unsupported button: enter",
    }));
    PressButton.prototype.press = press;
    PlatformDeviceManagerFactory.setInstance(createFakeDeviceManager([androidDevice]));
    server = new UnixSocketServerHarness(socketPath, createFakeDaemonState(), fakeTimer);
    await server.start();

    const response = await sendRequest(socketPath, "input/pressButton", {
      platform: "android",
      deviceId: "emulator-5554",
      button: "enter",
    });

    expect(response.success).toBe(false);
    expect(response.error).toBe(
      "input/pressButton button must be one of: home, back, menu, power, volume_up, volume_down, recent, app_switch",
    );
    expect(press).not.toHaveBeenCalled();
  });

  test("rejects missing, non-string, and unsupported button values with actionable errors", async () => {
    PlatformDeviceManagerFactory.setInstance(createFakeDeviceManager([androidDevice]));
    server = new UnixSocketServerHarness(socketPath, createFakeDaemonState(), fakeTimer);
    await server.start();

    const missing = await sendRequest(socketPath, "input/pressButton", {
      platform: "android",
    });
    const nonString = await sendRequest(socketPath, "input/pressButton", {
      platform: "android",
      button: 4,
    });
    const unsupported = await sendRequest(socketPath, "input/pressButton", {
      platform: "android",
      button: "camera",
    });

    expect(missing.success).toBe(false);
    expect(missing.error).toBe("input/pressButton requires button");
    expect(nonString.success).toBe(false);
    expect(nonString.error).toBe("input/pressButton requires button");
    expect(unsupported.success).toBe(false);
    expect(unsupported.error).toBe(
      "input/pressButton button must be one of: home, back, menu, power, volume_up, volume_down, recent, app_switch",
    );
  });
  test("tracks direct input until a session-loss drain can safely finish", async () => {
    const operationStarted = Promise.withResolvers<void>();
    const releaseOperation = Promise.withResolvers<void>();
    let sent = false;
    const client = createAndroidTestClient(androidDevice);
    spyOn(AndroidCtrlProxyClient, "getInstance").mockReturnValue(client);
    spyOn(client, "getScreenScaleMetadata").mockReturnValue(null);
    const deviceRequest = spyOn(client, "requestGlobalAction").mockImplementation(
      async (...args: Parameters<typeof client.requestGlobalAction>) => {
        args[3]?.signal?.throwIfAborted();
        args[3]?.onDispatch?.();
        sent = true;
        operationStarted.resolve();
        await releaseOperation.promise;
        return { success: true, totalTimeMs: 1, action: "global" };
      },
    );
    PlatformDeviceManagerFactory.setInstance(createFakeDeviceManager([androidDevice]));
    const sessionId = "direct-pressButton-after-dispatch-session";
    const sessions = new Map([
      [sessionId, createDrainSession(sessionId, androidDevice.deviceId, "android")],
    ]);
    server = new UnixSocketServerHarness(socketPath, createDrainDaemonState(sessions), fakeTimer);
    await server.start();
    const response = sendRequest(socketPath, "input/pressButton", {
      platform: "android",
      deviceId: androidDevice.deviceId,
      button: "back",
      sessionUuid: sessionId,
    });
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
    const client = createAndroidTestClient(androidDevice);
    spyOn(AndroidCtrlProxyClient, "getInstance").mockReturnValue(client);
    spyOn(client, "getScreenScaleMetadata").mockReturnValue(null);
    const deviceRequest = spyOn(client, "requestGlobalAction").mockImplementation(
      async (...args: Parameters<typeof client.requestGlobalAction>) => {
        operationStarted.resolve();
        await releaseOperation.promise;
        args[3]?.signal?.throwIfAborted();
        args[3]?.onDispatch?.();
        sent = true;
        return { success: true, totalTimeMs: 1, action: "global" };
      },
    );
    PlatformDeviceManagerFactory.setInstance(createFakeDeviceManager([androidDevice]));
    const sessionId = "direct-pressButton-before-dispatch-session";
    const sessions = new Map([
      [sessionId, createDrainSession(sessionId, androidDevice.deviceId, "android")],
    ]);
    server = new UnixSocketServerHarness(socketPath, createDrainDaemonState(sessions), fakeTimer);
    await server.start();
    const response = sendRequest(socketPath, "input/pressButton", {
      platform: "android",
      deviceId: androidDevice.deviceId,
      button: "back",
      sessionUuid: sessionId,
    });
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
