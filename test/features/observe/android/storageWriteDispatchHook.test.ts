import { createExecResult } from "../../../../src/utils/execResult";
import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { AndroidCtrlProxyManager } from "../../../../src/ctrlProxy/CtrlProxyManager";
import { AndroidCtrlProxyClient } from "../../../../src/features/observe/android";
import type { BootedDevice } from "../../../../src/models";
import { runWithAbortSignal } from "../../../../src/utils/AbortContext";
import { FakeAdbClientFactory } from "../../../fakes/FakeAdbClientFactory";
import { FakeAdbExecutor } from "../../../fakes/FakeAdbExecutor";
import { FakeTimer } from "../../../fakes/FakeTimer";
import { FakeWebSocket, WebSocketState } from "../../../fakes/FakeWebSocket";

/** #11750: storage admission belongs to the successful socket send. */

const device: BootedDevice = {
  deviceId: "hunt-storage-device",
  platform: "android",
  name: "Hunt Device",
};

class CapturingWebSocket extends FakeWebSocket {
  readonly sentTypes: string[] = [];
  readonly sentRequests: Array<{ type: string; requestId: string }> = [];
  send(data: unknown): void {
    try {
      const request = JSON.parse(String(data)) as { type: string; requestId: string };
      this.sentTypes.push(request.type);
      this.sentRequests.push(request);
    } catch {
      // Non-JSON control frame: not a device request.
    }
    super.send(data as never);
  }
}

describe("a storage write whose call was cancelled before it was sent", () => {
  let client: AndroidCtrlProxyClient;
  let socket: CapturingWebSocket;

  beforeEach(async () => {
    const timer = new FakeTimer();
    timer.enableAutoAdvance();
    const adb = new FakeAdbExecutor();
    adb.setCommandResponse("forward", createExecResult("8765", ""));
    adb.setScreenState(true);
    adb.setCommandResponse("pidof", createExecResult("4242\n", ""));
    AndroidCtrlProxyManager.resetInstances();
    AndroidCtrlProxyClient.resetInstances();
    AndroidCtrlProxyManager.getInstance(
      device,
      new FakeAdbClientFactory(),
    ).clearAvailabilityCache();
    let created: CapturingWebSocket | undefined;
    client = AndroidCtrlProxyClient.createForTesting(device, adb, {
      webSocketFactory: (url) => (created = new CapturingWebSocket(url, "none", 0, timer)),
      timer,
    });
    await client.ensureConnected();
    socket = created!;
    if (socket.readyState !== WebSocketState.OPEN) {
      await new Promise<void>((resolve) => socket.once("open", () => resolve()));
    }
    socket.sentTypes.length = 0;
    socket.sentRequests.length = 0;
  });

  afterEach(async () => {
    spyOn(client, "ensureConnected").mockRestore();
    await client.close();
    AndroidCtrlProxyClient.resetInstances();
    AndroidCtrlProxyManager.resetInstances();
  });

  for (const method of ["setPreference", "removePreference", "clearPreferenceStore"] as const) {
    function write(onDispatch: () => void): Promise<unknown> {
      const options = { onDispatch };
      return method === "setPreference"
        ? client.setPreference("com.example", "prefs", "k", "v", "STRING", options)
        : method === "removePreference"
          ? client.removePreference("com.example", "prefs", "k", options)
          : client.clearPreferenceStore("com.example", "prefs", options);
    }

    test(`${method}: cancel while connecting never dispatches`, async () => {
      const connect = Promise.withResolvers<boolean>();
      spyOn(client, "ensureConnected").mockImplementation(() => connect.promise);
      const call = new AbortController();
      let count = 0;
      const pending = runWithAbortSignal(call.signal, () => write(() => count++));
      call.abort(new Error("cancel during connect"));
      connect.resolve(true);
      await expect(pending).rejects.toThrow("cancel during connect");
      expect(count).toBe(0);
      expect(socket.sentRequests).toEqual([]);
    });

    test(`${method}: successful send dispatches once before its result`, async () => {
      let count = 0;
      const pending = write(() => count++);
      for (let i = 0; i < 20; i++) {
        await Promise.resolve();
      }
      const beforeResult = count;
      expect(socket.sentRequests).toHaveLength(1);
      const request = socket.sentRequests[0];
      socket.simulateMessage(
        JSON.stringify({
          type: `${request.type}_result`,
          requestId: request.requestId,
          success: true,
        }),
      );
      await pending;
      expect(beforeResult).toBe(1);
      expect(count).toBe(1);
    });

    for (const failure of ["missing", "closed", "send throws"] as const) {
      test(`${method}: socket ${failure} never dispatches`, async () => {
        spyOn(client, "ensureConnected").mockResolvedValue(true);
        const sendSpy = spyOn(socket, "send");
        if (failure === "missing") {
          Reflect.set(client, "ws", null);
        }
        if (failure === "closed") {
          socket.readyState = WebSocketState.CLOSED;
        }
        if (failure === "send throws") {
          sendSpy.mockImplementation(() => {
            throw new Error("send failed");
          });
        }
        let count = 0;
        try {
          await expect(write(() => count++)).rejects.toThrow();
          expect(count).toBe(0);
          expect(socket.sentRequests).toEqual([]);
        } finally {
          sendSpy.mockRestore();
          Reflect.set(client, "ws", socket);
          socket.readyState = WebSocketState.OPEN;
        }
      });
    }

    for (const failure of ["false", "throw"] as const) {
      test(`${method}: connect ${failure} never dispatches`, async () => {
        spyOn(client, "ensureConnected").mockImplementation(async () => {
          if (failure === "throw") {
            throw new Error("connect failed");
          }
          return false;
        });
        let count = 0;
        await expect(write(() => count++)).rejects.toThrow();
        expect(count).toBe(0);
        expect(socket.sentRequests).toEqual([]);
      });
    }
  }
});
