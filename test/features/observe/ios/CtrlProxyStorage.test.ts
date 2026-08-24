import { beforeEach, describe, expect, test } from "bun:test";
import { IOSCtrlProxyClient } from "../../../../src/features/observe/ios";
import type { BootedDevice } from "../../../../src/models";
import {
  FakeWebSocket,
  createInstantFailureWebSocketFactory,
  WebSocketState,
} from "../../../fakes/FakeWebSocket";
import { FakeTimer } from "../../../fakes/FakeTimer";

describe("CtrlProxyStorage (iOS)", function () {
  let testDevice: BootedDevice;
  let fakeTimer: FakeTimer;
  const serverPort = 8765;

  beforeEach(function () {
    fakeTimer = new FakeTimer();
    fakeTimer.enableAutoAdvance();

    testDevice = {
      deviceId: "A1B2C3D4-E5F6-7890-ABCD-EF1234567890",
      platform: "ios",
      name: "iPhone 16 Simulator",
    };

    IOSCtrlProxyClient.resetInstances();
  });

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------

  class CapturingWebSocket extends FakeWebSocket {
    sentMessages: string[] = [];

    send(data: unknown): void {
      this.sentMessages.push(String(data));
      super.send(data);
    }
  }

  const createCapturingFactory = (
    timer?: FakeTimer,
  ): {
    factory: (url: string) => CapturingWebSocket;
    getSocket: () => CapturingWebSocket | null;
  } => {
    let socket: CapturingWebSocket | null = null;
    return {
      factory: (url: string) => {
        socket = new CapturingWebSocket(url, "none", 0, timer);
        return socket;
      },
      getSocket: () => socket,
    };
  };

  const waitForSocket = async (
    getSocket: () => CapturingWebSocket | null,
  ): Promise<CapturingWebSocket | null> => {
    for (let i = 0; i < 5; i++) {
      const s = getSocket();
      if (s) {
        return s;
      }
      await new Promise((r) => setImmediate(r));
    }
    return getSocket();
  };

  const waitForSocketOpen = async (socket: FakeWebSocket | null): Promise<void> => {
    if (!socket || socket.readyState === WebSocketState.OPEN) {
      return;
    }
    await new Promise<void>((resolve) => socket.once("open", () => resolve()));
  };

  const waitForSentMessages = async (
    socket: CapturingWebSocket | null,
    minCount = 1,
  ): Promise<void> => {
    if (!socket) {
      return;
    }
    for (let i = 0; i < 10; i++) {
      if (commandPayloads(socket).length >= minCount) {
        return;
      }
      await new Promise((r) => setImmediate(r));
    }
  };

  const syncMessageTypes = new Set([
    "set_hierarchy_poll_interval",
    "set_network_mock_rules",
    "set_network_error_simulation",
  ]);

  const commandPayloads = (socket: CapturingWebSocket): any[] =>
    socket.sentMessages
      .map((message) => JSON.parse(message))
      .filter((payload) => !syncMessageTypes.has(payload.type));

  // ---------------------------------------------------------------------------
  // listPreferenceFiles
  // ---------------------------------------------------------------------------

  describe("listPreferenceFiles", function () {
    test("sends list_preference_files request and returns files", async function () {
      const { factory, getSocket } = createCapturingFactory(fakeTimer);
      const client = IOSCtrlProxyClient.createForTesting(
        testDevice,
        serverPort,
        factory,
        fakeTimer,
      );

      try {
        const resultPromise = client.listPreferenceFiles("com.example.app");
        const socket = await waitForSocket(getSocket);
        expect(socket).not.toBeNull();
        await waitForSocketOpen(socket);
        await waitForSentMessages(socket, 1);

        const sentMsg = commandPayloads(socket!)[0];
        expect(sentMsg.type).toBe("list_preference_files");
        expect(typeof sentMsg.requestId).toBe("string");

        socket!.simulateMessage(
          JSON.stringify({
            type: "preference_files",
            requestId: sentMsg.requestId,
            success: true,
            files: [
              { name: "Standard", path: "Standard", displayName: "Standard", entryCount: 5 },
              {
                name: "group.com.example",
                path: "group.com.example",
                displayName: "group.com.example",
                entryCount: 3,
              },
            ],
            totalTimeMs: 10,
          }),
        );

        const result = await resultPromise;
        expect(result).toHaveLength(2);
        expect(result[0].name).toBe("Standard");
        expect(result[0].path).toBe("Standard");
        expect(result[0].displayName).toBe("Standard");
        expect(result[1].name).toBe("group.com.example");
        expect(result[1].path).toBe("group.com.example");
      } finally {
        await client.close();
      }
    });

    test("throws on connection failure", async function () {
      const client = IOSCtrlProxyClient.createForTesting(
        testDevice,
        serverPort,
        createInstantFailureWebSocketFactory(fakeTimer),
        fakeTimer,
      );

      try {
        await expect(client.listPreferenceFiles("com.example.app")).rejects.toThrow();
      } finally {
        await client.close();
      }
    });
  });

  // ---------------------------------------------------------------------------
  // getPreferenceEntries
  // ---------------------------------------------------------------------------

  describe("getPreferenceEntries", function () {
    test("sends get_preferences and returns entries", async function () {
      const { factory, getSocket } = createCapturingFactory(fakeTimer);
      const client = IOSCtrlProxyClient.createForTesting(
        testDevice,
        serverPort,
        factory,
        fakeTimer,
      );

      try {
        const resultPromise = client.getPreferenceEntries("com.example.app", "Standard");
        const socket = await waitForSocket(getSocket);
        await waitForSocketOpen(socket);
        await waitForSentMessages(socket, 1);

        const sentMsg = commandPayloads(socket!)[0];
        expect(sentMsg.type).toBe("get_preferences");
        expect(sentMsg.fileName).toBe("Standard");

        socket!.simulateMessage(
          JSON.stringify({
            type: "preferences",
            requestId: sentMsg.requestId,
            success: true,
            entries: [
              { key: "theme", value: "dark", type: "STRING" },
              { key: "count", value: "42", type: "INT" },
            ],
            totalTimeMs: 5,
          }),
        );

        const result = await resultPromise;
        expect(result).toHaveLength(2);
        expect(result[0].key).toBe("theme");
        expect(result[0].type).toBe("STRING");
        expect(result[1].key).toBe("count");
        expect(result[1].value).toBe("42");
      } finally {
        await client.close();
      }
    });
  });

  // ---------------------------------------------------------------------------
  // getPreference
  // ---------------------------------------------------------------------------

  describe("getPreference", function () {
    test("returns entry when found", async function () {
      const { factory, getSocket } = createCapturingFactory(fakeTimer);
      const client = IOSCtrlProxyClient.createForTesting(
        testDevice,
        serverPort,
        factory,
        fakeTimer,
      );

      try {
        const resultPromise = client.getPreference("com.example.app", "Standard", "theme");
        const socket = await waitForSocket(getSocket);
        await waitForSocketOpen(socket);
        await waitForSentMessages(socket, 1);

        const sentMsg = commandPayloads(socket!)[0];
        expect(sentMsg.type).toBe("get_preference");
        expect(sentMsg.fileName).toBe("Standard");
        expect(sentMsg.key).toBe("theme");

        socket!.simulateMessage(
          JSON.stringify({
            type: "get_preference_result",
            requestId: sentMsg.requestId,
            success: true,
            found: true,
            key: "theme",
            value: "dark",
            valueType: "STRING",
            totalTimeMs: 3,
          }),
        );

        const result = await resultPromise;
        expect(result).not.toBeNull();
        expect(result!.key).toBe("theme");
        expect(result!.value).toBe("dark");
        expect(result!.type).toBe("STRING");
      } finally {
        await client.close();
      }
    });

    test("returns null when not found", async function () {
      const { factory, getSocket } = createCapturingFactory(fakeTimer);
      const client = IOSCtrlProxyClient.createForTesting(
        testDevice,
        serverPort,
        factory,
        fakeTimer,
      );

      try {
        const resultPromise = client.getPreference("com.example.app", "Standard", "missing");
        const socket = await waitForSocket(getSocket);
        await waitForSocketOpen(socket);
        await waitForSentMessages(socket, 1);

        const sentMsg = commandPayloads(socket!)[0];

        socket!.simulateMessage(
          JSON.stringify({
            type: "get_preference_result",
            requestId: sentMsg.requestId,
            success: true,
            found: false,
            totalTimeMs: 2,
          }),
        );

        const result = await resultPromise;
        expect(result).toBeNull();
      } finally {
        await client.close();
      }
    });
  });

  // ---------------------------------------------------------------------------
  // setPreference
  // ---------------------------------------------------------------------------

  describe("setPreference", function () {
    test("sends set_preference with correct parameters", async function () {
      const { factory, getSocket } = createCapturingFactory(fakeTimer);
      const client = IOSCtrlProxyClient.createForTesting(
        testDevice,
        serverPort,
        factory,
        fakeTimer,
      );

      try {
        const resultPromise = client.setPreference(
          "com.example.app",
          "Standard",
          "theme",
          "dark",
          "STRING",
        );
        const socket = await waitForSocket(getSocket);
        await waitForSocketOpen(socket);
        await waitForSentMessages(socket, 1);

        const sentMsg = commandPayloads(socket!)[0];
        expect(sentMsg.type).toBe("set_preference");
        expect(sentMsg.fileName).toBe("Standard");
        expect(sentMsg.key).toBe("theme");
        expect(sentMsg.value).toBe("dark");
        expect(sentMsg.valueType).toBe("STRING");

        socket!.simulateMessage(
          JSON.stringify({
            type: "set_preference_result",
            requestId: sentMsg.requestId,
            success: true,
            totalTimeMs: 5,
          }),
        );

        await resultPromise; // should not throw
      } finally {
        await client.close();
      }
    });

    test("throws on failure response", async function () {
      const { factory, getSocket } = createCapturingFactory(fakeTimer);
      const client = IOSCtrlProxyClient.createForTesting(
        testDevice,
        serverPort,
        factory,
        fakeTimer,
      );

      try {
        const resultPromise = client.setPreference(
          "com.example.app",
          "Standard",
          "count",
          "bad",
          "INT",
        );
        const socket = await waitForSocket(getSocket);
        await waitForSocketOpen(socket);
        await waitForSentMessages(socket, 1);

        const sentMsg = commandPayloads(socket!)[0];

        socket!.simulateMessage(
          JSON.stringify({
            type: "set_preference_result",
            requestId: sentMsg.requestId,
            success: false,
            error: "Cannot parse 'bad' as INT",
            totalTimeMs: 2,
          }),
        );

        await expect(resultPromise).rejects.toThrow("Cannot parse");
      } finally {
        await client.close();
      }
    });
  });

  // ---------------------------------------------------------------------------
  // removePreference
  // ---------------------------------------------------------------------------

  describe("removePreference", function () {
    test("sends remove_preference request", async function () {
      const { factory, getSocket } = createCapturingFactory(fakeTimer);
      const client = IOSCtrlProxyClient.createForTesting(
        testDevice,
        serverPort,
        factory,
        fakeTimer,
      );

      try {
        const resultPromise = client.removePreference("com.example.app", "Standard", "theme");
        const socket = await waitForSocket(getSocket);
        await waitForSocketOpen(socket);
        await waitForSentMessages(socket, 1);

        const sentMsg = commandPayloads(socket!)[0];
        expect(sentMsg.type).toBe("remove_preference");
        expect(sentMsg.fileName).toBe("Standard");
        expect(sentMsg.key).toBe("theme");

        socket!.simulateMessage(
          JSON.stringify({
            type: "remove_preference_result",
            requestId: sentMsg.requestId,
            success: true,
            totalTimeMs: 3,
          }),
        );

        await resultPromise; // should not throw
      } finally {
        await client.close();
      }
    });
  });

  // ---------------------------------------------------------------------------
  // clearPreferenceStore
  // ---------------------------------------------------------------------------

  describe("clearPreferenceStore", function () {
    test("sends clear_preferences request", async function () {
      const { factory, getSocket } = createCapturingFactory(fakeTimer);
      const client = IOSCtrlProxyClient.createForTesting(
        testDevice,
        serverPort,
        factory,
        fakeTimer,
      );

      try {
        const resultPromise = client.clearPreferenceStore(
          "com.example.app",
          "com.example.settings",
        );
        const socket = await waitForSocket(getSocket);
        await waitForSocketOpen(socket);
        await waitForSentMessages(socket, 1);

        const sentMsg = commandPayloads(socket!)[0];
        expect(sentMsg.type).toBe("clear_preferences");
        expect(sentMsg.fileName).toBe("com.example.settings");

        socket!.simulateMessage(
          JSON.stringify({
            type: "clear_preferences_result",
            requestId: sentMsg.requestId,
            success: true,
            totalTimeMs: 8,
          }),
        );

        await resultPromise; // should not throw
      } finally {
        await client.close();
      }
    });
  });
});

// ---------------------------------------------------------------------------
// PARAM-1 (issue #4174, item 3): delegate-level 6 ops x 4 outcomes.
//
// The client-level round-trips above drive a real FakeWebSocket + decode; this
// block drives the CtrlProxyStorage DELEGATE directly through a real
// RequestManager + FakeTimer (test/helpers/iosDelegateHarness.ts) so the
// timeout and not-connected paths — previously untested (grep "timeout after"
// in this dir returned 0) — get an actionable, asserted failure instead of a
// silent hang. Time is fully controlled: the timeout rows fire by advancing the
// fake clock and asserting the message, never by a real 5s hang.
// ---------------------------------------------------------------------------
import {
  createIosDelegateHarness,
  type IosDelegateHarness,
} from "../../../helpers/iosDelegateHarness";
import { CtrlProxyStorage } from "../../../../src/features/observe/ios/CtrlProxyStorage";

describe("CtrlProxyStorage delegate outcomes (6 ops x 4)", () => {
  const flush = (): Promise<void> => new Promise<void>((resolve) => setImmediate(resolve));
  const TIMEOUT = 5000;

  let h: IosDelegateHarness;
  let storage: CtrlProxyStorage;

  beforeEach(() => {
    h = createIosDelegateHarness();
    storage = new CtrlProxyStorage(h.context);
  });

  interface Op {
    op: string;
    wireType: string;
    timeoutMsg: string;
    defaultErrorMsg: string;
    call: () => Promise<unknown>;
    successPayload: Record<string, unknown>;
    assertSuccess: (value: unknown) => void;
  }

  const ops: Op[] = [
    {
      op: "listPreferenceFiles",
      wireType: "list_preference_files",
      timeoutMsg: `List preference files timeout after ${TIMEOUT}ms`,
      defaultErrorMsg: "Failed to list preference files",
      call: () => storage.listPreferenceFiles("com.app", TIMEOUT),
      successPayload: {
        success: true,
        totalTimeMs: 1,
        files: [{ name: "Standard", path: "Standard", entryCount: 2 }],
      },
      assertSuccess: (value) => {
        expect(value).toEqual([{ name: "Standard", path: "Standard", entryCount: 2 }]);
      },
    },
    {
      op: "getPreferenceEntries",
      wireType: "get_preferences",
      timeoutMsg: `Get preferences timeout after ${TIMEOUT}ms`,
      defaultErrorMsg: "Failed to get preference entries",
      call: () => storage.getPreferenceEntries("com.app", "Standard", TIMEOUT),
      successPayload: {
        success: true,
        totalTimeMs: 1,
        entries: [{ key: "theme", value: "dark", type: "STRING" }],
      },
      assertSuccess: (value) => {
        expect(value).toEqual([{ key: "theme", value: "dark", type: "STRING" }]);
      },
    },
    {
      op: "getPreference",
      wireType: "get_preference",
      timeoutMsg: `Get preference timeout after ${TIMEOUT}ms`,
      defaultErrorMsg: "Failed to get preference",
      call: () => storage.getPreference("com.app", "Standard", "theme", TIMEOUT),
      successPayload: {
        success: true,
        found: true,
        totalTimeMs: 1,
        entry: { key: "theme", value: "dark", type: "STRING" },
      },
      assertSuccess: (value) => {
        expect(value).toEqual({ key: "theme", value: "dark", type: "STRING" });
      },
    },
    {
      op: "setPreference",
      wireType: "set_preference",
      timeoutMsg: `Set preference timeout after ${TIMEOUT}ms`,
      defaultErrorMsg: "Failed to set preference",
      call: () => storage.setPreference("com.app", "Standard", "theme", "dark", "STRING", TIMEOUT),
      successPayload: { success: true, totalTimeMs: 1 },
      assertSuccess: (value) => {
        expect(value).toBeUndefined();
      },
    },
    {
      op: "removePreference",
      wireType: "remove_preference",
      timeoutMsg: `Remove preference timeout after ${TIMEOUT}ms`,
      defaultErrorMsg: "Failed to remove preference",
      call: () => storage.removePreference("com.app", "Standard", "theme", TIMEOUT),
      successPayload: { success: true, totalTimeMs: 1 },
      assertSuccess: (value) => {
        expect(value).toBeUndefined();
      },
    },
    {
      op: "clearPreferenceStore",
      wireType: "clear_preferences",
      timeoutMsg: `Clear preferences timeout after ${TIMEOUT}ms`,
      defaultErrorMsg: "Failed to clear preferences",
      call: () => storage.clearPreferenceStore("com.app", "Standard", TIMEOUT),
      successPayload: { success: true, totalTimeMs: 1 },
      assertSuccess: (value) => {
        expect(value).toBeUndefined();
      },
    },
  ];

  for (const o of ops) {
    describe(o.op, () => {
      test(`sends ${o.wireType} and resolves the mapped value on success`, async () => {
        const promise = o.call();
        await flush();
        expect(h.sentMessages[0]).toMatchObject({ type: o.wireType });
        expect(typeof h.sentMessages[0].requestId).toBe("string");
        expect(h.resolveLast(o.successPayload)).toBe(true);
        o.assertSuccess(await promise);
      });

      test("throws the runner-supplied error when success is false", async () => {
        const promise = o.call();
        await flush();
        h.resolveLast({ success: false, totalTimeMs: 2, error: "runner said no" });
        await expect(promise).rejects.toThrow("runner said no");
      });

      test("throws the default message when a failure carries no error string", async () => {
        const promise = o.call();
        await flush();
        h.resolveLast({ success: false, totalTimeMs: 2 });
        await expect(promise).rejects.toThrow(o.defaultErrorMsg);
      });

      test("throws an actionable timeout message after the deadline (no silent hang)", async () => {
        const promise = o.call();
        await flush();
        // Precondition: the request is genuinely registered before the clock moves.
        expect(h.requestManager.getPendingCount()).toBe(1);
        h.advanceTime(TIMEOUT);
        await expect(promise).rejects.toThrow(o.timeoutMsg);
      });

      test("throws when not connected without sending on the wire", async () => {
        h.setConnected(false);
        await expect(o.call()).rejects.toThrow("Failed to connect to CtrlProxy");
        expect(h.sentMessages).toHaveLength(0);
      });
    });
  }
});
