import { expect, spyOn, test } from "bun:test";
import { UnixSocketServer } from "../../src/daemon/socketServer";
import type { DaemonRequest } from "../../src/daemon/types";
import { InputKey } from "../../src/features/action/InputKey";
import type { BootedDevice } from "../../src/models";
import type { Timer } from "../../src/utils/SystemTimer";
import { FakeTimer } from "../fakes/FakeTimer";

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
    const device: BootedDevice = { platform: "android", deviceId: "fake-key", name: "Fake" };
    const controller = new AbortController();
    // Call the real handler with narrow fake dependencies. No constructor,
    // listener, connection, daemon, or session lifecycle is started.
    const handler = Object.create(UnixSocketServer.prototype) as InputKeyHandler;
    handler.timer = new FakeTimer();
    handler.resolveInputTargetDevice = async () => device;
    handler.requireCurrentFrameContext = () => {};
    handler.runTrackedKeyedDeviceInput = async (method, target, operation) => {
      expect(method).toBe("input/key");
      expect(target).toBe(device);
      return operation(controller.signal);
    };
    const press = spyOn(InputKey.prototype, "press").mockImplementation(async (key) => ({
      success: true,
      key,
      keyCode: "KEYCODE_ENTER",
    }));

    try {
      const result = await handler.handleInputKey({
        id: "key-signal",
        type: "mcp_request",
        method: "input/key",
        timeoutMs: 1234,
        params: { platform: "android", deviceId: device.deviceId, key: "enter", frameContext },
      });

      expect(press).toHaveBeenCalledWith("enter", 1234, frameContext, [], {
        signal: controller.signal,
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
