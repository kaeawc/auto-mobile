import { describe, expect, test } from "bun:test";
import { AndroidCtrlProxyClient } from "../../../../src/features/observe/android";
import { CtrlProxyText } from "../../../../src/features/observe/android/CtrlProxyText";
import type { DelegateContext } from "../../../../src/features/observe/android/types";
import type { BootedDevice } from "../../../../src/models";
import { RequestManager } from "../../../../src/utils/RequestManager";
import { FakeAdbExecutor } from "../../../fakes/FakeAdbExecutor";
import { FakeTimer } from "../../../fakes/FakeTimer";
import { FakeWebSocket, WebSocketState } from "../../../fakes/FakeWebSocket";

class CapturingWebSocket extends FakeWebSocket {
  sentMessages: string[] = [];

  send(data: unknown): void {
    this.sentMessages.push(String(data));
    super.send(data);
  }
}

async function waitForSocketOpen(socket: CapturingWebSocket): Promise<void> {
  if (socket.readyState === WebSocketState.OPEN) {
    return;
  }
  await new Promise<void>((resolve) => socket.once("open", () => resolve()));
}

async function waitForRequest(
  socket: CapturingWebSocket,
  type: string,
): Promise<Record<string, unknown>> {
  for (let attempt = 0; attempt < 10; attempt++) {
    for (const message of socket.sentMessages) {
      const parsed = JSON.parse(message) as Record<string, unknown>;
      if (parsed.type === type) {
        return parsed;
      }
    }
    await new Promise((resolve) => setImmediate(resolve));
  }
  throw new Error(`No message of type ${type} in: ${socket.sentMessages.join(", ")}`);
}

describe("Android CtrlProxyText", () => {
  test("sends request_insert_text and resolves its result", async () => {
    const timer = new FakeTimer();
    timer.enableAutoAdvance();
    const sent: string[] = [];
    const requestManager = new RequestManager(timer);
    const context: DelegateContext = {
      getWebSocket: () =>
        ({
          readyState: 1,
          send: (data: string) => sent.push(data),
        }) as any,
      requestManager,
      timer,
      ensureConnected: async () => true,
      cancelScreenshotBackoff: () => {},
    };
    const delegate = new CtrlProxyText(context);

    const resultPromise = delegate.requestInsertText("value");
    await Promise.resolve();
    await Promise.resolve();
    const request = JSON.parse(sent[0] ?? "{}") as Record<string, unknown>;
    requestManager.resolve(request.requestId as string, { success: true, totalTimeMs: 2 });

    expect(request).toMatchObject({
      type: "request_insert_text",
      text: "value",
    });
    expect(await resultPromise).toMatchObject({ success: true, totalTimeMs: 2 });
  });

  test("resolves commitViaIme from a commit_text_result frame", async () => {
    const timer = new FakeTimer();
    const fakeAdb = new FakeAdbExecutor();
    fakeAdb.setCommandResponse("forward", { stdout: "8765", stderr: "" });
    fakeAdb.setScreenState(true);
    const device: BootedDevice = {
      deviceId: "test-device-commit-text",
      platform: "android",
      isEmulator: true,
      name: "Test Device",
    };
    let socket: CapturingWebSocket | null = null;
    const client = AndroidCtrlProxyClient.createForTesting(
      device,
      fakeAdb,
      (url: string) => {
        socket = new CapturingWebSocket(url, "none", 0, timer);
        return socket;
      },
      timer,
    );

    try {
      expect(await client.ensureConnected()).toBe(true);
      if (!socket) {
        throw new Error("Expected the WebSocket factory to create a socket");
      }
      await waitForSocketOpen(socket);

      const textDelegate = (client as unknown as { text: CtrlProxyText }).text;
      const resultPromise = textDelegate.commitViaIme("value", "prior-ime");
      const request = await waitForRequest(socket, "request_commit_text");
      expect(request).toMatchObject({
        type: "request_commit_text",
        text: "value",
        priorImeId: "prior-ime",
      });
      expect(request.requestId).toStartWith("commitText_");

      socket.simulateMessage(
        JSON.stringify({
          type: "commit_text_result",
          timestamp: 1,
          requestId: request.requestId,
          success: true,
          totalTimeMs: 3,
        }),
      );

      expect(await resultPromise).toEqual({
        success: true,
        totalTimeMs: 3,
        error: undefined,
        perfTiming: undefined,
      });
    } finally {
      await client.close();
    }
  });

  test("resolves setKeyboardProfile from a set_keyboard_profile_result frame", async () => {
    const timer = new FakeTimer();
    const fakeAdb = new FakeAdbExecutor();
    fakeAdb.setCommandResponse("forward", { stdout: "8765", stderr: "" });
    fakeAdb.setScreenState(true);
    const device: BootedDevice = {
      deviceId: "test-device-profile",
      platform: "android",
      isEmulator: true,
      name: "Test Device",
    };
    let socket: CapturingWebSocket | null = null;
    const client = AndroidCtrlProxyClient.createForTesting(
      device,
      fakeAdb,
      (url: string) => {
        socket = new CapturingWebSocket(url, "none", 0, timer);
        return socket;
      },
      timer,
    );
    try {
      expect(await client.ensureConnected()).toBe(true);
      if (!socket) {
        throw new Error("Expected the WebSocket factory to create a socket");
      }
      await waitForSocketOpen(socket);
      const resultPromise = client.setKeyboardProfile("samsung");
      const request = await waitForRequest(socket, "request_set_keyboard_profile");
      expect(request).toMatchObject({ profileId: "samsung" });
      expect(request.requestId).toStartWith("setKeyboardProfile_");
      socket.simulateMessage(
        JSON.stringify({
          type: "set_keyboard_profile_result",
          timestamp: 1,
          requestId: request.requestId,
          success: true,
          activeProfileId: "samsung",
          previousProfileId: "direct",
        }),
      );
      expect(await resultPromise).toEqual({
        success: true,
        activeProfileId: "samsung",
        previousProfileId: "direct",
        error: undefined,
      });
    } finally {
      await client.close();
    }
  });
});
