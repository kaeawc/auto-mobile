import { EventEmitter } from "node:events";
import type { Socket } from "node:net";
import { expect, spyOn, test } from "bun:test";
import { UnixSocketServer } from "../../src/daemon/socketServer";
import type { DaemonStateAccess } from "../../src/daemon/daemonRequestHandlers";
import type { DaemonRequest, DaemonResponse } from "../../src/daemon/types";
import { PressButton } from "../../src/features/action/PressButton";
import type { BootedDevice, PressButtonResult } from "../../src/models";
import { FakeAdbExecutor } from "../fakes/FakeAdbExecutor";
import { FakeTimer } from "../fakes/FakeTimer";

class FakeSocket extends EventEmitter {
  destroyed = false;
  readonly responses: DaemonResponse[] = [];

  setTimeout(): this {
    return this;
  }

  write(frame: string): boolean {
    this.responses.push(JSON.parse(frame) as DaemonResponse);
    // A named pipe may report backpressure. That must not hold the next
    // device's response behind a running call.
    return false;
  }

  send(request: DaemonRequest): void {
    this.emit("data", Buffer.from(`${JSON.stringify(request)}\n`));
  }
}

test("a later pipe data event answers another device while the first call is held", async () => {
  const timer = new FakeTimer();
  const server = new UnixSocketServer(
    "unused",
    "http://localhost:0/mcp",
    {} as DaemonStateAccess,
    timer,
  );
  const first = Promise.withResolvers<DaemonResponse>();
  const firstStarted = Promise.withResolvers<void>();
  const socket = new FakeSocket();
  const request = (id: string, deviceId: string): DaemonRequest => ({
    id,
    type: "mcp_request",
    method: "tools/call",
    params: { name: "tapOn", arguments: { deviceId } },
  });
  (
    server as unknown as {
      handleRequest: (
        sessionId: string,
        socket: Socket,
        frame: DaemonRequest,
      ) => Promise<DaemonResponse>;
    }
  ).handleRequest = async (_sessionId, _socket, frame) => {
    if (frame.id === "first") {
      firstStarted.resolve();
      return first.promise;
    }
    return { id: frame.id, type: "mcp_response", success: true, result: {} };
  };
  (server as unknown as { acceptingRequests: boolean }).acceptingRequests = true;
  (server as unknown as { handleConnection: (socket: Socket) => void }).handleConnection(
    socket as unknown as Socket,
  );

  socket.send(request("first", "device-1"));
  await firstStarted.promise;
  socket.send(request("second", "device-2"));
  for (let i = 0; i < 3; i++) {
    await Promise.resolve();
  }
  expect(socket.responses.map((response) => response.id)).toEqual(["second"]);

  first.resolve({ id: "first", type: "mcp_response", success: true, result: {} });
  for (let i = 0; i < 3; i++) {
    await Promise.resolve();
  }
  expect(socket.responses.map((response) => response.id)).toEqual(["second", "first"]);
});

interface PressServerInternals {
  acceptingRequests: boolean;
  handleConnection(socket: Socket): void;
  resolveInputTargetDevice(): Promise<BootedDevice>;
  runTrackedKeyedDeviceInput<T>(
    method: string,
    device: BootedDevice,
    operation: (signal?: AbortSignal) => Promise<T>,
  ): Promise<T>;
}

test.each(["returned failure", "thrown cancellation"])(
  "cancelled input/pressButton sends a well-formed wire error for %s",
  async (contract) => {
    const timer = new FakeTimer();
    const device: BootedDevice = { platform: "android", deviceId: "fake-press", name: "Fake" };
    const server = new UnixSocketServer(
      "unused",
      "http://localhost:0/mcp",
      {} as DaemonStateAccess,
      timer,
    );
    const internals = server as unknown as PressServerInternals;
    internals.acceptingRequests = true;
    internals.resolveInputTargetDevice = async () => device;
    const controller = new AbortController();
    internals.runTrackedKeyedDeviceInput = async (_method, _device, operation) =>
      operation(controller.signal);
    const adb = new FakeAdbExecutor();
    const dispatch = spyOn(adb, "execute").mockImplementation(() =>
      Promise.resolve().then(() => {
        controller.abort();
        throw new Error("Operation cancelled");
      }),
    );
    const realPress = PressButton.prototype.press;
    const fakePress = new PressButton(device, adb, timer);
    // The parent returned this typed failure; the committed cancellation slice throws.
    const press = spyOn(PressButton.prototype, "press").mockImplementation(
      async (button, timeout, frame, signal): Promise<PressButtonResult> => {
        expect(signal).toBe(controller.signal);
        if (contract === "returned failure") {
          return {
            success: false,
            button,
            keyCode: -1,
            error: "Failed to press button: Operation cancelled",
          };
        }
        return realPress.call(fakePress, button, timeout, frame, signal);
      },
    );
    const socket = new FakeSocket();
    try {
      internals.handleConnection(socket as unknown as Socket);
      socket.send({
        id: "press-cancel",
        type: "mcp_request",
        method: "input/pressButton",
        params: { platform: "android", deviceId: device.deviceId, button: "volume_up" },
      });
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(socket.responses).toEqual([
        {
          id: "press-cancel",
          type: "mcp_response",
          success: false,
          error:
            contract === "returned failure"
              ? "Failed to press button: Operation cancelled"
              : "Operation cancelled",
        },
      ]);
      expect(dispatch.mock.calls).toHaveLength(contract === "returned failure" ? 0 : 1);
    } finally {
      press.mockRestore();
      dispatch.mockRestore();
    }
  },
);
