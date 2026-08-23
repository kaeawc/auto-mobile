import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { UnixSocketServer } from "../../src/daemon/socketServer";
import { sendRawSocketRequest } from "./helpers/socketRequest";
import { InputKey, type InputKeyName } from "../../src/features/action/InputKey";
import { PlatformDeviceManagerFactory } from "../../src/utils/factories/PlatformDeviceManagerFactory";
import { FakeTimer } from "../fakes/FakeTimer";
import type { DaemonRequest, DaemonResponse } from "../../src/daemon/types";
import type { DeviceLabelMap, Session } from "../../src/daemon/sessionManager";
import type { BootedDevice } from "../../src/models";
import type { InputKeyResult } from "../../src/features/action/InputKey";

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

function createFakeDeviceManager(
  devices: BootedDevice[],
  succeededPlatforms: Set<"android" | "ios"> = new Set(["android", "ios"]),
) {
  return {
    getBootedDevicesDetailed: mock(async () => ({
      devices,
      succeededPlatforms,
    })),
  } as unknown as ReturnType<typeof PlatformDeviceManagerFactory.getInstance>;
}

function createFakeDaemonState() {
  return {
    isInitialized: () => true,
    getSessionManager: () => ({
      getSession: (_sessionId: string): Session | null => null,
      getDeviceLabels: (_sessionId: string): DeviceLabelMap | undefined => undefined,
      releaseSession: async () => null,
    }),
    getDevicePool: () => ({
      refreshDevices: async () => 0,
      getStats: () => ({ total: 0, idle: 0, assigned: 0, error: 0 }),
      releaseDevice: async () => {},
      resolveAutolockSessionForMcpSession: () => undefined,
    }),
  };
}

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
  let server: UnixSocketServer;
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
    server = new UnixSocketServer(
      socketPath,
      "http://localhost:0/mcp",
      createFakeDaemonState(),
      fakeTimer,
    );
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
    expect(press).toHaveBeenCalledWith("enter", 1234);
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
    server = new UnixSocketServer(
      socketPath,
      "http://localhost:0/mcp",
      createFakeDaemonState(),
      fakeTimer,
    );
    (server as unknown as { requireCurrentFrameContext: () => void }).requireCurrentFrameContext =
      () => {};
    await server.start();

    const { response } = await sendRequest(socketPath, "input/key", {
      platform: "android",
      deviceId: "emulator-5554",
      key: "enter",
      frameContext: "frame-1",
    });

    expect(response.success).toBe(true);
    expect(press).toHaveBeenCalledWith("enter", 30_000, "frame-1");
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
    server = new UnixSocketServer(
      socketPath,
      "http://localhost:0/mcp",
      createFakeDaemonState(),
      fakeTimer,
    );
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
    server = new UnixSocketServer(
      socketPath,
      "http://localhost:0/mcp",
      createFakeDaemonState(),
      fakeTimer,
    );
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
    server = new UnixSocketServer(
      socketPath,
      "http://localhost:0/mcp",
      createFakeDaemonState(),
      fakeTimer,
    );
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
    server = new UnixSocketServer(
      socketPath,
      "http://localhost:0/mcp",
      createFakeDaemonState(),
      fakeTimer,
    );
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
});
