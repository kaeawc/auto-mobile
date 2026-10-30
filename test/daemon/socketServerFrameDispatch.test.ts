import { createHarnessServer } from "./helpers/UnixSocketServerHarness";
import { createFakeDaemonState } from "./helpers/inputSocketHarness";
import { expect, spyOn, test } from "bun:test";
import type { DaemonRequest, DaemonResponse } from "../../src/daemon/types";
import { PressButton } from "../../src/features/action/PressButton";
import type { BootedDevice, PressButtonResult } from "../../src/models";
import { FakeAdbExecutor } from "../fakes/FakeAdbExecutor";
import { FakeTimer } from "../fakes/FakeTimer";
import { NonThrowingFakeSocket as FakeSocket } from "../fakes/FakeNetServer";

test("a later pipe data event answers another device while the first call is held", async () => {
  const timer = new FakeTimer();
  const server = createHarnessServer("unused", createFakeDaemonState(), timer);
  const first = Promise.withResolvers<DaemonResponse>();
  const firstStarted = Promise.withResolvers<void>();
  const socket = new FakeSocket();
  socket.writeReturnValue = false;
  const request = (id: string, deviceId: string): DaemonRequest => ({
    id,
    type: "mcp_request",
    method: "tools/call",
    params: { name: "tapOn", arguments: { deviceId } },
  });
  server.requestHandler = async (_sessionId, _socket, frame) => {
    if (frame.id === "first") {
      firstStarted.resolve();
      return first.promise;
    }
    return { id: frame.id, type: "mcp_response", success: true, result: {} };
  };
  server.allowRequests();
  server.connect(socket);

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

test.each(["returned failure", "thrown cancellation"])(
  "cancelled input/pressButton sends a well-formed wire error for %s",
  async (contract) => {
    const timer = new FakeTimer();
    const device: BootedDevice = { platform: "android", deviceId: "fake-press", name: "Fake" };
    const server = createHarnessServer("unused", createFakeDaemonState(), timer);
    server.allowRequests();
    server.inputTargetDeviceResolver = async () => device;
    const controller = new AbortController();
    server.runKeyedInputWith(controller.signal);
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
      async (button, options = {}): Promise<PressButtonResult> => {
        expect(options.signal).toBe(controller.signal);
        if (contract === "returned failure") {
          return {
            success: false,
            button,
            keyCode: -1,
            error: "Failed to press button: Operation cancelled",
          };
        }
        return realPress.call(fakePress, button, options);
      },
    );
    const socket = new FakeSocket();
    socket.writeReturnValue = false;
    try {
      server.connect(socket);
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
