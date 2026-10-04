import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import type WebSocket from "ws";
import { AndroidCtrlProxyClient } from "../../../../src/features/observe/android/AndroidCtrlProxyClient";
import type { BootedDevice } from "../../../../src/models";
import { FakeAdbExecutor } from "../../../fakes/FakeAdbExecutor";
import { FakeTimer } from "../../../fakes/FakeTimer";
import { FakeWebSocket } from "../../../fakes/FakeWebSocket";
import { FakeIdGenerator } from "../../../fakes/FakeIdGenerator";

// Isolate request dispatch from connection provisioning: the fake socket is already open.
describe("AndroidCtrlProxyClient input delivery", () => {
  const device: BootedDevice = { deviceId: "input-delivery", platform: "android", name: "Pixel" };
  let timer: FakeTimer;
  let socket: FakeWebSocket;
  let client: AndroidCtrlProxyClient;
  let connectionSpy: ReturnType<typeof spyOn>;
  let closedSpy: ReturnType<typeof spyOn>;

  beforeEach(async () => {
    timer = new FakeTimer();
    socket = new FakeWebSocket("ws://fake", "none", 0, timer);
    await Promise.resolve();
    client = AndroidCtrlProxyClient.createForTesting(
      device,
      new FakeAdbExecutor(),
      () => socket as unknown as WebSocket,
      timer,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      new FakeIdGenerator(),
      false,
    );
    closedSpy = spyOn(client, "onConnectionClosed").mockImplementation(() => {});
    client["ws"] = socket as unknown as WebSocket;
    client["autoReconnectEnabled"] = false;
    socket.on("message", (data: string) => {
      void client["handleMessage"](data);
    });
    socket.on("close", () => client["finishEstablishedConnection"](socket as unknown as WebSocket));
    connectionSpy = spyOn(client, "connectWebSocket").mockResolvedValue(true);
  });

  afterEach(async () => {
    connectionSpy.mockRestore();
    await client.close();
    closedSpy.mockRestore();
  });

  for (const kind of ["global_action", "clipboard"] as const) {
    test.each([
      "not connected",
      "send failure",
      "refused",
      "unsupported",
      "success",
      "timeout",
      "socket closed",
    ])(`${kind} distinguishes %s`, async (scenario) => {
      let dispatched = false;
      let releaseDispatch: () => void = () => {};
      const sent = new Promise<void>((resolve) => {
        releaseDispatch = resolve;
      });
      const onDispatch = () => {
        dispatched = true;
      };
      if (scenario === "not connected") {
        client["ws"] = null;
        connectionSpy.mockResolvedValue(false);
      }
      const send = spyOn(socket, "send").mockImplementation((data: unknown) => {
        if (scenario === "send failure") {
          throw new Error("send failed");
        }
        releaseDispatch();
        const request = JSON.parse(String(data)) as { requestId: string };
        if (["refused", "unsupported", "success"].includes(scenario)) {
          socket.simulateMessage(
            JSON.stringify(
              scenario === "unsupported"
                ? {
                    type: "error",
                    requestId: request.requestId,
                    error: `Unknown command type: request_${kind}`,
                  }
                : {
                    type: `${kind}_result`,
                    requestId: request.requestId,
                    action: kind === "clipboard" ? "paste" : "back",
                    success: scenario === "success",
                    totalTimeMs: 1,
                    error: scenario === "refused" ? "device refused" : undefined,
                  },
            ),
          );
        }
      });
      const pending =
        kind === "global_action"
          ? client.requestGlobalAction("back", 3000, undefined, undefined, undefined, onDispatch)
          : client.requestClipboard("paste", undefined, 5000, undefined, undefined, onDispatch);
      if (scenario === "timeout" || scenario === "socket closed") {
        await sent;
        // Dispatch must be reported synchronously after the successful send.
        expect(dispatched).toBe(true);
        if (scenario === "timeout") {
          timer.advanceTime(kind === "clipboard" ? 5000 : 3000);
        } else {
          socket.readyState = 3;
          socket.emit("close");
        }
      }
      const result = await pending;
      expect(dispatched).toBe(!["not connected", "send failure"].includes(scenario));
      expect(result.acknowledged).toBe(["refused", "unsupported", "success"].includes(scenario));
      expect(result.success).toBe(scenario === "success");
      expect(timer.getPendingTimeoutCount()).toBe(0);
      send.mockRestore();
    });
  }
});
