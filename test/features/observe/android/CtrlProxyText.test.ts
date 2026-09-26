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
  test("commit timeout reports unknown editor state", async () => {
    const timer = new FakeTimer();
    const requestManager = new RequestManager(timer);
    const context: DelegateContext = {
      getWebSocket: () => ({ readyState: 1, send: () => {} }) as any,
      requestManager,
      timer,
      ensureConnected: async () => true,
      cancelScreenshotBackoff: () => {},
    };

    const resultPromise = new CtrlProxyText(context).commitViaIme("text", "prior");
    await Promise.resolve();
    await Promise.resolve();
    timer.advanceTime(10_000);

    expect(await resultPromise).toMatchObject({
      success: false,
      partialApplication: true,
      error: expect.stringContaining("editor state is unknown"),
    });
  });

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

  test("requests a versioned keyboard profile catalog", async () => {
    const timer = new FakeTimer();
    timer.enableAutoAdvance();
    const sent: string[] = [];
    const requestManager = new RequestManager(timer);
    const context: DelegateContext = {
      getWebSocket: () => ({ readyState: 1, send: (data: string) => sent.push(data) }) as any,
      requestManager,
      timer,
      ensureConnected: async () => true,
      cancelScreenshotBackoff: () => {},
    };
    const resultPromise = new CtrlProxyText(context).listKeyboardProfiles();
    await Promise.resolve();
    await Promise.resolve();
    const request = JSON.parse(sent[0] ?? "{}") as Record<string, unknown>;
    requestManager.resolve(request.requestId as string, {
      success: true,
      catalogId: "automobile_behavior_profiles",
      catalogVersion: 1,
      supportedCatalogVersions: [1],
      activeProfileId: "gboard",
      profiles: [],
    });

    expect(request).toMatchObject({
      type: "request_list_keyboard_profiles",
      supportedCatalogVersions: [1],
    });
    expect(await resultPromise).toMatchObject({
      success: true,
      catalogId: "automobile_behavior_profiles",
      catalogVersion: 1,
      activeProfileId: "gboard",
    });
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
        partialApplication: undefined,
        perfTiming: undefined,
      });

      socket.sentMessages.length = 0;
      const failed = textDelegate.commitViaIme("long text", "prior-ime");
      const failedRequest = await waitForRequest(socket, "request_commit_text");
      socket.simulateMessage(
        JSON.stringify({
          type: "commit_text_result",
          timestamp: 2,
          requestId: failedRequest.requestId,
          success: false,
          error: "IME commit deadline exceeded",
          totalTimeMs: 4000,
          partialApplication: true,
        }),
      );
      expect(await failed).toMatchObject({ success: false, partialApplication: true });
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

  test("resolves listKeyboardProfiles from a versioned catalog result", async () => {
    const timer = new FakeTimer();
    const fakeAdb = new FakeAdbExecutor();
    fakeAdb.setCommandResponse("forward", { stdout: "8765", stderr: "" });
    fakeAdb.setScreenState(true);
    const device: BootedDevice = {
      deviceId: "test-device-profile-catalog",
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
      const resultPromise = client.listKeyboardProfiles();
      const request = await waitForRequest(socket, "request_list_keyboard_profiles");
      expect(request).toMatchObject({ supportedCatalogVersions: [1] });
      socket.simulateMessage(
        JSON.stringify({
          type: "keyboard_profiles_result",
          timestamp: 1,
          requestId: request.requestId,
          success: true,
          catalogId: "automobile_behavior_profiles",
          catalogVersion: 1,
          supportedCatalogVersions: [1],
          activeProfileId: "samsung",
          profiles: [
            {
              id: "samsung",
              displayName: "Samsung",
              version: 1,
              evidenceStatus: "experimental",
              evidenceNote: "Real-device comparison remains pending.",
              behavior: {
                composeWords: true,
                enterStrategy: "COMMIT_NEWLINE",
                backspaceStrategy: "DELETE_SURROUNDING",
                recomposeOnCursorMove: true,
                recomposeOnBackspaceIntoWord: true,
                batchEdits: false,
              },
            },
          ],
        }),
      );
      expect(await resultPromise).toMatchObject({
        catalogId: "automobile_behavior_profiles",
        catalogVersion: 1,
        activeProfileId: "samsung",
        profiles: [{ id: "samsung", evidenceStatus: "experimental" }],
      });
    } finally {
      await client.close();
    }
  });
});
