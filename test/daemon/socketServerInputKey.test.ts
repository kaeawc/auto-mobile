import { expect, spyOn, test } from "bun:test";
import { UnixSocketServer } from "../../src/daemon/socketServer";
import type { DaemonRequest } from "../../src/daemon/types";
import { InputKey } from "../../src/features/action/InputKey";
import { ActionableError, type BootedDevice, type ExecResult } from "../../src/models";
import { defaultAdbClientFactory } from "../../src/utils/android-cmdline-tools/AdbClientFactory";
import { McpTimeoutError } from "../../src/daemon/McpTimeoutError";
import { AndroidCtrlProxyClient } from "../../src/features/observe/android";
import type { Timer } from "../../src/utils/SystemTimer";
import { FakeTimer } from "../fakes/FakeTimer";
import { FakeAdbExecutor } from "../fakes/FakeAdbExecutor";

const device: BootedDevice = { platform: "android", deviceId: "fake-key", name: "Fake" };

function createHandler(controller: AbortController, timer = new FakeTimer()): InputKeyHandler {
  // No constructor, listener, connection, daemon, or session lifecycle is started.
  const handler = Object.create(UnixSocketServer.prototype) as InputKeyHandler;
  handler.timer = timer;
  handler.resolveInputTargetDevice = async () => device;
  handler.requireCurrentFrameContext = () => {};
  handler.runTrackedKeyedDeviceInput = async (method, target, operation) => {
    expect(method).toBe("input/key");
    expect(target).toBe(device);
    return operation(controller.signal);
  };
  return handler;
}

function keyRequest(frameContext?: string): DaemonRequest {
  return {
    id: "key-signal",
    type: "mcp_request",
    method: "input/key",
    timeoutMs: 1234,
    params: { platform: "android", deviceId: device.deviceId, key: "enter", frameContext },
  };
}

interface InputKeyHandler {
  timer: Timer;
  handleInputKey(request: DaemonRequest): Promise<unknown>;
  resolveInputTargetDevice(): Promise<BootedDevice>;
  requireCurrentFrameContext(): void;
  runTrackedKeyedDeviceInput<T>(
    method: string,
    device: BootedDevice,
    operation: (signal?: AbortSignal) => Promise<T>,
  ): Promise<T>;
}

test.each([undefined, "frame-1"])(
  "input/key forwards the tracked abort signal with frame context %s",
  async (frameContext) => {
    const controller = new AbortController();
    const handler = createHandler(controller);
    const press = spyOn(InputKey.prototype, "press").mockImplementation(async (key) => ({
      success: true,
      key,
      keyCode: "KEYCODE_ENTER",
    }));

    try {
      const result = await handler.handleInputKey(keyRequest(frameContext));

      expect(press).toHaveBeenCalledWith("enter", 1234, frameContext, [], {
        signal: controller.signal,
        onDispatch: expect.any(Function),
      });
      expect(result).toEqual({
        action: "input/key",
        platform: "android",
        deviceId: device.deviceId,
        success: true,
        key: "enter",
      });
    } finally {
      press.mockRestore();
    }
  },
);

test.each([undefined, "frame-1"])(
  "input/key reports dispatch followed by tracked cancellation with frame context %s",
  async (frameContext) => {
    const controller = new AbortController();
    const handler = createHandler(controller);
    const fakeAdb = new FakeAdbExecutor();
    const factory = spyOn(defaultAdbClientFactory, "create").mockReturnValue(fakeAdb);
    const execute = spyOn(fakeAdb, "execute").mockImplementation(async (_args, options) => {
      await options?.beforeDispatch?.(options.timeoutMs);
      controller.abort();
      throw new Error("ADB keyevent cancelled");
    });
    const validate = spyOn(
      AndroidCtrlProxyClient.prototype,
      "validateFrameContext",
    ).mockResolvedValue({
      success: true,
    });
    try {
      const result = handler.handleInputKey(keyRequest(frameContext));
      await expect(result).rejects.toBeInstanceOf(ActionableError);
      await expect(result).rejects.toThrow("Key outcome is indeterminate");
      await expect(result).rejects.toThrow("The key may have been delivered");
      await expect(result).rejects.toThrow("Do not retry automatically");
      expect(execute).toHaveBeenCalledTimes(1);
    } finally {
      validate.mockRestore();
      factory.mockRestore();
    }
  },
);

test("input/key preserves cancellation before the dispatch hook runs", async () => {
  const controller = new AbortController();
  const handler = createHandler(controller);
  const fakeAdb = new FakeAdbExecutor();
  const factory = spyOn(defaultAdbClientFactory, "create").mockReturnValue(fakeAdb);
  spyOn(fakeAdb, "execute").mockImplementation(async () => {
    controller.abort();
    throw new Error("ADB cancelled before dispatch");
  });
  try {
    await expect(handler.handleInputKey(keyRequest())).rejects.toThrow("Operation cancelled");
    expect(fakeAdb.getExecutedCommands()).toEqual([]);
  } finally {
    factory.mockRestore();
  }
});

test("input/key keeps an ordinary failure before dispatch", async () => {
  const handler = createHandler(new AbortController());
  const fakeAdb = new FakeAdbExecutor();
  const factory = spyOn(defaultAdbClientFactory, "create").mockReturnValue(fakeAdb);
  spyOn(fakeAdb, "execute").mockRejectedValue(new Error("device offline"));
  try {
    await expect(handler.handleInputKey(keyRequest())).rejects.toThrow(
      'Failed to press key "enter": device offline',
    );
    expect(fakeAdb.getExecutedCommands()).toEqual([]);
  } finally {
    factory.mockRestore();
  }
});

test.each([false, true])(
  "input/key classifies a reply deadline according to dispatch state: %s",
  async (dispatched) => {
    const timer = new FakeTimer();
    const handler = createHandler(new AbortController(), timer);
    let announceStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      announceStarted = resolve;
    });
    let finish!: (result: ExecResult) => void;
    const pending = new Promise<ExecResult>((resolve) => {
      finish = resolve;
    });
    const fakeAdb = new FakeAdbExecutor();
    const factory = spyOn(defaultAdbClientFactory, "create").mockReturnValue(fakeAdb);
    spyOn(fakeAdb, "execute").mockImplementation(async (_args, options) => {
      if (dispatched) {
        await options?.beforeDispatch?.(options.timeoutMs);
      }
      announceStarted();
      return pending;
    });
    try {
      const result = handler.handleInputKey(keyRequest());
      await started;
      timer.advanceTime(1234);
      // Settle the in-flight command after the deadline: the real timeout helper
      // retains the device queue until it settles, without starting a real socket.
      finish({ stdout: "", stderr: "" });
      await expect(result).rejects.toBeInstanceOf(dispatched ? ActionableError : McpTimeoutError);
      await expect(result).rejects.toThrow(
        dispatched ? "Key outcome is indeterminate" : "operation exceeded remaining budget",
      );
    } finally {
      finish({ stdout: "", stderr: "" });
      factory.mockRestore();
    }
  },
);
