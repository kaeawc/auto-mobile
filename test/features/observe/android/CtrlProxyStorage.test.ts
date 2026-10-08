import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { AndroidCtrlProxyClient } from "../../../../src/features/observe/android";
import { NavigationGraphManager } from "../../../../src/features/navigation/NavigationGraphManager";
import { FakeAdbExecutor } from "../../../fakes/FakeAdbExecutor";
import { AndroidCtrlProxyManager } from "../../../../src/ctrlProxy/CtrlProxyManager";
import { FakeAdbClientFactory } from "../../../fakes/FakeAdbClientFactory";
import { BootedDevice } from "../../../../src/models";
import { FakeWebSocket, WebSocketState } from "../../../fakes/FakeWebSocket";
import { FakeTimer } from "../../../fakes/FakeTimer";
import { ProviderUnavailableError } from "../../../../src/features/storage/ProviderUnavailableError";

/**
 * End-to-end WebSocket round-trip tests for the storage subscribe/unsubscribe lifecycle on the
 * Android CtrlProxy client. These pin the wire contract between the device (which emits flat
 * packageName/fileName/subscriptionId fields) and the TS client (which awaits a resolved promise),
 * so a timeout-only resolution or a dropped field is caught here.
 */
describe("CtrlProxyStorage (Android)", function () {
  let fakeAdb: FakeAdbExecutor;
  let testDevice: BootedDevice;
  let fakeTimer: FakeTimer;
  const serverPort: number = 8765;

  beforeEach(function () {
    fakeTimer = new FakeTimer();
    fakeTimer.enableAutoAdvance();

    fakeAdb = new FakeAdbExecutor();
    fakeAdb.setCommandResponse("forward", { stdout: `${serverPort}`, stderr: "" });
    fakeAdb.setScreenState(true);

    testDevice = {
      deviceId: "test-device-storage",
      platform: "android",
      isEmulator: true,
      name: "Test Device",
    };

    AndroidCtrlProxyManager.resetInstances();
    AndroidCtrlProxyClient.resetInstances();
    AndroidCtrlProxyManager.getInstance(
      testDevice,
      new FakeAdbClientFactory(),
    ).clearAvailabilityCache();
  });

  afterEach(function () {
    NavigationGraphManager.getInstance();
  });

  class CapturingWebSocket extends FakeWebSocket {
    sentMessages: string[] = [];
    send(data: any): void {
      this.sentMessages.push(data.toString());
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

  const waitForSocketOpen = async (socket: FakeWebSocket | null): Promise<void> => {
    if (!socket || socket.readyState === WebSocketState.OPEN) {
      return;
    }
    await new Promise<void>((resolve) => socket.once("open", () => resolve()));
  };

  // The socket helpers wait on microtasks, not real turns: auto-advance fires a
  // pending request deadline whenever the test yields the event loop.
  const waitForSocket = async (
    getSocket: () => CapturingWebSocket | null,
  ): Promise<CapturingWebSocket | null> => {
    for (let i = 0; i < 100; i++) {
      const s = getSocket();
      if (s) {
        return s;
      }
      await Promise.resolve();
    }
    return getSocket();
  };

  const waitForSentMessages = async (
    socket: CapturingWebSocket | null,
    minCount = 1,
  ): Promise<void> => {
    if (!socket) {
      return;
    }
    for (let i = 0; i < 100; i++) {
      if (socket.sentMessages.length >= minCount) {
        return;
      }
      await Promise.resolve();
    }
  };

  const findSentMessage = (socket: CapturingWebSocket, type: string): any => {
    for (let i = socket.sentMessages.length - 1; i >= 0; i--) {
      try {
        const parsed = JSON.parse(socket.sentMessages[i]);
        if (parsed.type === type) {
          return parsed;
        }
      } catch {
        // skip non-JSON control frames
      }
    }
    throw new Error(`No message of type ${type} in: ${socket.sentMessages.join(", ")}`);
  };

  test("Keystore discovery round trip preserves typed state and strips unexpected fields", async () => {
    const { factory, getSocket } = createCapturingFactory(fakeTimer);
    const client = AndroidCtrlProxyClient.createForTesting(testDevice, fakeAdb, factory, fakeTimer);
    try {
      await client.ensureConnected();
      const socket = await waitForSocket(getSocket);
      await waitForSocketOpen(socket);
      socket!.simulateMessage(
        JSON.stringify({
          type: "connected",
          id: "new-apk",
          supportedCommands: ["discover_keystore"],
        }),
      );
      const count = socket!.sentMessages.length;
      const pending = client.discoverKeystore("com.example");
      await waitForSentMessages(socket, count + 1);
      const request = findSentMessage(socket!, "discover_keystore");
      const state = {
        schemaVersion: 1,
        capability: "storage.keystore",
        outcome: "disabled",
        reason: "DISABLED",
        bridgeAvailable: true,
        metadata: "supported",
        mutation: "declared_unsupported",
        deviceLocked: "locked",
        scopes: [],
      };
      socket!.simulateMessage(
        JSON.stringify({
          type: "keystore_discovery",
          requestId: request.requestId,
          state: { ...state, unexpected: "must be dropped" },
        }),
      );
      expect(await pending).toEqual(state);
      expect(request.packageName).toBe("com.example");
    } finally {
      client.close();
    }
  });

  test("old APK consistently reports unsupported Keystore discovery without sending requests", async () => {
    const { factory, getSocket } = createCapturingFactory(fakeTimer);
    const client = AndroidCtrlProxyClient.createForTesting(testDevice, fakeAdb, factory, fakeTimer);
    try {
      await client.ensureConnected();
      const socket = await waitForSocket(getSocket);
      await waitForSocketOpen(socket);
      const pending = client.discoverKeystore("com.example");
      socket!.simulateMessage(
        JSON.stringify({ type: "connected", id: "old-apk", supportedCommands: [] }),
      );
      const first = await pending;
      const second = await client.discoverKeystore("com.example");
      expect(first).toEqual(second);
      expect(first.outcome).toBe("unsupported");
      expect(first.reason).toBe("DECLARED_UNSUPPORTED");
      expect(
        socket!.sentMessages.some((message) => JSON.parse(message).type === "discover_keystore"),
      ).toBe(false);
    } finally {
      client.close();
    }
  });

  const sdkSnapshot = {
    schemaVersion: 1,
    capabilities: [
      { id: "network.control", state: "SUPPORTED" },
      { id: "storage.keystore", state: "DISABLED", reason: "off" },
    ],
    policy: { captureHeaders: false, captureBodies: true, allowMutations: false },
  };

  const openSdkCapabilitiesClient = async (supportedCommands: string[]) => {
    const { factory, getSocket } = createCapturingFactory(fakeTimer);
    const client = AndroidCtrlProxyClient.createForTesting(testDevice, fakeAdb, factory, fakeTimer);
    await client.ensureConnected();
    const socket = await waitForSocket(getSocket);
    await waitForSocketOpen(socket);
    socket!.simulateMessage(JSON.stringify({ type: "connected", id: "apk", supportedCommands }));
    return { client, socket: socket! };
  };

  const answerSdkCapabilities = async (state: unknown) => {
    const { client, socket } = await openSdkCapabilitiesClient([
      "get_sdk_capabilities",
      "sdk_capabilities_user_id_v1",
    ]);
    try {
      const count = socket.sentMessages.length;
      const pending = client.getSdkCapabilities("com.example");
      await waitForSentMessages(socket, count + 1);
      const request = findSentMessage(socket, "get_sdk_capabilities");
      expect(request.packageName).toBe("com.example");
      socket.simulateMessage(
        JSON.stringify({ type: "sdk_capabilities", requestId: request.requestId, state }),
      );
      return await pending;
    } finally {
      client.close();
    }
  };

  test("SDK capabilities round trip returns the typed snapshot and drops unknown fields", async () => {
    const result = await answerSdkCapabilities({
      schemaVersion: 1,
      outcome: "ok",
      snapshot: { ...sdkSnapshot, future: 1 },
    });
    expect(result).toEqual({ status: "available", snapshot: sdkSnapshot });
  });

  test("SDK capabilities forward a bridge-unavailable reason from the device", async () => {
    const result = await answerSdkCapabilities({
      schemaVersion: 1,
      outcome: "unavailable",
      reason: "BRIDGE_NOT_INSTALLED",
    });
    expect(result).toEqual({ status: "unavailable", reason: "BRIDGE_NOT_INSTALLED" });
  });

  test("SDK capabilities report a malformed device snapshot as unavailable", async () => {
    const result = await answerSdkCapabilities({
      schemaVersion: 1,
      outcome: "ok",
      snapshot: { schemaVersion: 1 },
    });
    expect(result).toEqual({ status: "unavailable", reason: "MALFORMED_RESPONSE" });
  });

  const sentSdkCapabilitiesRequest = async (supportedCommands: string[], userId?: number) => {
    const { client, socket } = await openSdkCapabilitiesClient(supportedCommands);
    try {
      const count = socket.sentMessages.length;
      const pending = client.getSdkCapabilities("com.example", userId);
      await waitForSentMessages(socket, count + 1);
      const request = findSentMessage(socket, "get_sdk_capabilities");
      socket.simulateMessage(
        JSON.stringify({
          type: "sdk_capabilities",
          requestId: request.requestId,
          state: { outcome: "unavailable", reason: "CROSS_USER_UNSUPPORTED" },
        }),
      );
      return { request, result: await pending };
    } finally {
      client.close();
    }
  };

  test("SDK capabilities forward the app's user to a CtrlProxy that advertises it", async () => {
    const { request, result } = await sentSdkCapabilitiesRequest(
      ["get_sdk_capabilities", "sdk_capabilities_user_id_v1"],
      10,
    );
    expect(request.userId).toBe(10);
    expect(result).toEqual({ status: "unavailable", reason: "CROSS_USER_UNSUPPORTED" });
  });

  test("SDK capabilities omit the user for a CtrlProxy without the user flag", async () => {
    const { request } = await sentSdkCapabilitiesRequest(["get_sdk_capabilities"], 10);
    expect("userId" in request).toBe(false);
  });

  test("SDK capabilities omit the user when none is known", async () => {
    const { request } = await sentSdkCapabilitiesRequest([
      "get_sdk_capabilities",
      "sdk_capabilities_user_id_v1",
    ]);
    expect("userId" in request).toBe(false);
  });

  test("an old CtrlProxy APK yields unavailable without sending a request", async () => {
    const { client, socket } = await openSdkCapabilitiesClient([]);
    try {
      expect(await client.getSdkCapabilities("com.example")).toEqual({
        status: "unavailable",
        reason: "CTRLPROXY_UNSUPPORTED",
      });
      expect(
        socket.sentMessages.some((message) => JSON.parse(message).type === "get_sdk_capabilities"),
      ).toBe(false);
    } finally {
      client.close();
    }
  });

  test.each([
    ["list_preference_files", "preference_files"],
    ["get_preferences", "preferences"],
  ])("classifies absent SDK authority in %s", async (requestType, responseType) => {
    const { factory, getSocket } = createCapturingFactory(fakeTimer);
    const client = AndroidCtrlProxyClient.createForTesting(testDevice, fakeAdb, factory, fakeTimer);
    try {
      await client.ensureConnected();
      const socket = await waitForSocket(getSocket);
      await waitForSocketOpen(socket);
      const baseCount = socket!.sentMessages.length;
      const resultPromise =
        requestType === "list_preference_files"
          ? client.listPreferenceFiles("com.example.nondebug")
          : client.getPreferenceEntries("com.example.nondebug", "prefs.xml");
      await waitForSentMessages(socket, baseCount + 1);
      const sent = findSentMessage(socket!, requestType);
      socket!.simulateMessage(
        JSON.stringify({
          type: responseType,
          requestId: sent.requestId,
          success: false,
          error: "Unknown authority com.example.nondebug.automobile.sharedprefs",
        }),
      );
      await expect(resultPromise).rejects.toBeInstanceOf(ProviderUnavailableError);
    } finally {
      await client.close();
    }
  });

  describe("subscribeStorage", function () {
    test("resolves with a subscription rebuilt from the device's flat result fields", async function () {
      const { factory, getSocket } = createCapturingFactory(fakeTimer);
      const client = AndroidCtrlProxyClient.createForTesting(
        testDevice,
        fakeAdb,
        factory,
        fakeTimer,
      );
      try {
        await client.ensureConnected();
        const socket = await waitForSocket(getSocket);
        await waitForSocketOpen(socket);

        const baseCount = socket!.sentMessages.length;
        const resultPromise = client.subscribeStorage("com.example", "settings.xml");
        await waitForSentMessages(socket, baseCount + 1);

        const sent = findSentMessage(socket!, "subscribe_storage");
        expect(sent.requestId).toBeString();
        expect(sent.requestId).toMatch(/^subscribe_storage_.+/);
        expect(JSON.parse(socket!.sentMessages[baseCount])).toEqual({
          type: "subscribe_storage",
          requestId: sent.requestId,
          packageName: "com.example",
          fileName: "settings.xml",
        });

        // The device emits flat fields (no nested `subscription` object).
        socket!.simulateMessage(
          JSON.stringify({
            type: "subscribe_storage_result",
            requestId: sent.requestId,
            success: true,
            packageName: "com.example",
            fileName: "settings.xml",
            subscriptionId: "com.example:settings.xml",
            totalTimeMs: 5,
          }),
        );

        const subscription = await resultPromise;
        expect(subscription.subscriptionId).toBe("com.example:settings.xml");
        expect(subscription.packageName).toBe("com.example");
        expect(subscription.fileName).toBe("settings.xml");
      } finally {
        await client.close();
      }
    });

    test("rejects when the device reports failure", async function () {
      const { factory, getSocket } = createCapturingFactory(fakeTimer);
      const client = AndroidCtrlProxyClient.createForTesting(
        testDevice,
        fakeAdb,
        factory,
        fakeTimer,
      );
      try {
        await client.ensureConnected();
        const socket = await waitForSocket(getSocket);
        await waitForSocketOpen(socket);

        const baseCount = socket!.sentMessages.length;
        const resultPromise = client.subscribeStorage("com.example", "settings.xml");
        await waitForSentMessages(socket, baseCount + 1);
        const sent = findSentMessage(socket!, "subscribe_storage");

        socket!.simulateMessage(
          JSON.stringify({
            type: "subscribe_storage_result",
            requestId: sent.requestId,
            success: false,
            packageName: "com.example",
            fileName: "settings.xml",
            error: "SDK not installed",
          }),
        );

        await expect(resultPromise).rejects.toThrow("SDK not installed");
      } finally {
        await client.close();
      }
    });
  });

  describe("unsubscribeStorage", function () {
    // CtrlProxyMessageHandlerTest.kt's `unsubscribe_storage with only subscriptionId resolves
    // packageName and fileName` uses the same JSON shape; changing either side must change both.
    const subscriptionId = "com.example:settings.xml";

    test("sends the subscriptionId and resolves on the device's result", async function () {
      const { factory, getSocket } = createCapturingFactory(fakeTimer);
      const client = AndroidCtrlProxyClient.createForTesting(
        testDevice,
        fakeAdb,
        factory,
        fakeTimer,
      );
      try {
        await client.ensureConnected();
        const socket = await waitForSocket(getSocket);
        await waitForSocketOpen(socket);

        const baseCount = socket!.sentMessages.length;
        const resultPromise = client.unsubscribeStorage(subscriptionId);
        await waitForSentMessages(socket, baseCount + 1);

        const sent = findSentMessage(socket!, "unsubscribe_storage");
        expect(sent.requestId).toBeString();
        expect(sent.requestId).toMatch(/^unsubscribe_storage_.+/);
        expect(JSON.parse(socket!.sentMessages[baseCount])).toEqual({
          type: "unsubscribe_storage",
          requestId: sent.requestId,
          subscriptionId,
        });

        socket!.simulateMessage(
          JSON.stringify({
            type: "unsubscribe_storage_result",
            requestId: sent.requestId,
            success: true,
            packageName: "com.example",
            fileName: "settings.xml",
            totalTimeMs: 3,
          }),
        );

        // The device result resolves the pending unsubscribe request.
        await expect(resultPromise).resolves.toBeUndefined();
      } finally {
        await client.close();
      }
    });

    test("sends the subscriptionId returned by subscribeStorage unchanged", async function () {
      const { factory, getSocket } = createCapturingFactory(fakeTimer);
      const client = AndroidCtrlProxyClient.createForTesting(
        testDevice,
        fakeAdb,
        factory,
        fakeTimer,
      );
      const packageName = "com.example";
      const fileName = "settings.xml";
      try {
        await client.ensureConnected();
        const socket = await waitForSocket(getSocket);
        await waitForSocketOpen(socket);

        const subscribeCount = socket!.sentMessages.length;
        const subscribePromise = client.subscribeStorage(packageName, fileName);
        await waitForSentMessages(socket, subscribeCount + 1);
        const subscribeRequest = findSentMessage(socket!, "subscribe_storage");
        socket!.simulateMessage(
          JSON.stringify({
            type: "subscribe_storage_result",
            requestId: subscribeRequest.requestId,
            success: true,
            packageName,
            fileName,
            subscriptionId,
            totalTimeMs: 5,
          }),
        );
        const subscription = await subscribePromise;

        const unsubscribeCount = socket!.sentMessages.length;
        const unsubscribePromise = client.unsubscribeStorage(subscription.subscriptionId);
        await waitForSentMessages(socket, unsubscribeCount + 1);
        const unsubscribeRequest = findSentMessage(socket!, "unsubscribe_storage");
        expect(unsubscribeRequest.subscriptionId).toBe(subscription.subscriptionId);
        expect(unsubscribeRequest.subscriptionId).toBe(`${packageName}:${fileName}`);
        socket!.simulateMessage(
          JSON.stringify({
            type: "unsubscribe_storage_result",
            requestId: unsubscribeRequest.requestId,
            success: true,
            packageName,
            fileName,
            totalTimeMs: 3,
          }),
        );
        await expect(unsubscribePromise).resolves.toBeUndefined();
      } finally {
        await client.close();
      }
    });
  });

  describe("getPreference", function () {
    test("resolves a found entry from the valueType wire field", async function () {
      const { factory, getSocket } = createCapturingFactory(fakeTimer);
      const client = AndroidCtrlProxyClient.createForTesting(
        testDevice,
        fakeAdb,
        factory,
        fakeTimer,
      );
      try {
        await client.ensureConnected();
        const socket = await waitForSocket(getSocket);
        await waitForSocketOpen(socket);

        const baseCount = socket!.sentMessages.length;
        const resultPromise = client.getPreference("com.example", "settings.xml", "launchCount");
        await waitForSentMessages(socket, baseCount + 1);
        const sent = findSentMessage(socket!, "get_preference");

        socket!.simulateMessage(
          JSON.stringify({
            type: "get_preference_result",
            requestId: sent.requestId,
            success: true,
            found: true,
            key: "launchCount",
            value: "3",
            valueType: "INT",
            totalTimeMs: 2,
          }),
        );

        await expect(resultPromise).resolves.toEqual({
          key: "launchCount",
          value: "3",
          type: "INT",
        });
      } finally {
        await client.close();
      }
    });
  });

  describe("listDataStores", function () {
    test("sends adapterName and resolves with the device's file list", async function () {
      const { factory, getSocket } = createCapturingFactory(fakeTimer);
      const client = AndroidCtrlProxyClient.createForTesting(
        testDevice,
        fakeAdb,
        factory,
        fakeTimer,
      );
      try {
        await client.ensureConnected();
        const socket = await waitForSocket(getSocket);
        await waitForSocketOpen(socket);

        const baseCount = socket!.sentMessages.length;
        const resultPromise = client.listDataStores("com.example", "settings");
        await waitForSentMessages(socket, baseCount + 1);

        const sent = findSentMessage(socket!, "list_data_stores");
        expect(sent.packageName).toBe("com.example");
        expect(sent.adapterName).toBe("settings");

        // DataStore descriptors reuse the SharedPreferences `preference_files` result envelope
        // (StorageResponse.FileList), disambiguated by requestId.
        socket!.simulateMessage(
          JSON.stringify({
            type: "preference_files",
            requestId: sent.requestId,
            success: true,
            packageName: "com.example",
            files: [{ name: "user_prefs", path: "", entryCount: 2 }],
            totalTimeMs: 4,
          }),
        );

        const files = await resultPromise;
        expect(files).toHaveLength(1);
        expect(files[0].name).toBe("user_prefs");
        expect(files[0].entryCount).toBe(2);
      } finally {
        await client.close();
      }
    });

    test("rejects when the device reports failure", async function () {
      const { factory, getSocket } = createCapturingFactory(fakeTimer);
      const client = AndroidCtrlProxyClient.createForTesting(
        testDevice,
        fakeAdb,
        factory,
        fakeTimer,
      );
      try {
        await client.ensureConnected();
        const socket = await waitForSocket(getSocket);
        await waitForSocketOpen(socket);

        const baseCount = socket!.sentMessages.length;
        const resultPromise = client.listDataStores("com.example", "missing");
        await waitForSentMessages(socket, baseCount + 1);
        const sent = findSentMessage(socket!, "list_data_stores");

        socket!.simulateMessage(
          JSON.stringify({
            type: "preference_files",
            requestId: sent.requestId,
            success: false,
            packageName: "com.example",
            error: "adapterName required",
          }),
        );

        await expect(resultPromise).rejects.toThrow("adapterName required");
      } finally {
        await client.close();
      }
    });
  });

  describe("getDataStore", function () {
    test("sends adapterName + storeName and resolves with the device's entries", async function () {
      const { factory, getSocket } = createCapturingFactory(fakeTimer);
      const client = AndroidCtrlProxyClient.createForTesting(
        testDevice,
        fakeAdb,
        factory,
        fakeTimer,
      );
      try {
        await client.ensureConnected();
        const socket = await waitForSocket(getSocket);
        await waitForSocketOpen(socket);

        const baseCount = socket!.sentMessages.length;
        const resultPromise = client.getDataStore("com.example", "settings", "user_prefs");
        await waitForSentMessages(socket, baseCount + 1);

        const sent = findSentMessage(socket!, "get_data_store");
        expect(sent.packageName).toBe("com.example");
        expect(sent.adapterName).toBe("settings");
        expect(sent.storeName).toBe("user_prefs");

        // DataStore entries reuse the SharedPreferences `preferences` result envelope
        // (StorageResponse.Preferences), disambiguated by requestId.
        socket!.simulateMessage(
          JSON.stringify({
            type: "preferences",
            requestId: sent.requestId,
            success: true,
            packageName: "com.example",
            entries: [{ key: "theme", value: '"dark"', type: "STRING" }],
            totalTimeMs: 6,
          }),
        );

        const entries = await resultPromise;
        expect(entries).toHaveLength(1);
        expect(entries[0].key).toBe("theme");
        expect(entries[0].type).toBe("STRING");
      } finally {
        await client.close();
      }
    });

    // Issue #5573 scope: STRING_SET / BYTE_ARRAY carry end-to-end across the wire. DataStore
    // reuses the `preferences` result envelope, so the entry `type`/`value` pass through the
    // client verbatim (STRING_SET as a JSON array string, BYTE_ARRAY as base64).
    test("carries STRING_SET and BYTE_ARRAY entries across the wire", async function () {
      const { factory, getSocket } = createCapturingFactory(fakeTimer);
      const client = AndroidCtrlProxyClient.createForTesting(
        testDevice,
        fakeAdb,
        factory,
        fakeTimer,
      );
      try {
        await client.ensureConnected();
        const socket = await waitForSocket(getSocket);
        await waitForSocketOpen(socket);

        const baseCount = socket!.sentMessages.length;
        const resultPromise = client.getDataStore("com.example", "settings", "user_prefs");
        await waitForSentMessages(socket, baseCount + 1);
        const sent = findSentMessage(socket!, "get_data_store");

        socket!.simulateMessage(
          JSON.stringify({
            type: "preferences",
            requestId: sent.requestId,
            success: true,
            packageName: "com.example",
            entries: [
              { key: "tags", value: '["a","b"]', type: "STRING_SET" },
              { key: "blob", value: "AQID", type: "BYTE_ARRAY" },
            ],
            totalTimeMs: 7,
          }),
        );

        const entries = await resultPromise;
        expect(entries).toHaveLength(2);
        expect(entries[0].type).toBe("STRING_SET");
        expect(entries[0].value).toBe('["a","b"]');
        expect(entries[1].type).toBe("BYTE_ARRAY");
        expect(entries[1].value).toBe("AQID");
      } finally {
        await client.close();
      }
    });
  });
});
