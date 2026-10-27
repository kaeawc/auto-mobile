import { describe, expect, test } from "bun:test";
import { AndroidCtrlProxyClient } from "../../../src/features/observe/android/AndroidCtrlProxyClient";
import type { CtrlProxyStorage } from "../../../src/features/observe/android/CtrlProxyStorage";
import { isCtrlProxyStorageUnavailableError } from "../../../src/features/observe/android/CtrlProxyStorage";
import {
  ctrlProxyRequests,
  serializeCtrlProxyRequest,
  SDK_CAPABILITIES_USER_ID_CAPABILITY,
} from "../../../src/features/observe/android/ctrlProxyProtocol";
import { ProviderUnavailableError } from "../../../src/features/storage/ProviderUnavailableError";
import { runWithAbortSignal } from "../../../src/utils/AbortContext";
import { CountingIdGenerator } from "../../../src/utils/IdGenerator";
import { FakeAdbExecutor } from "../../fakes/FakeAdbExecutor";
import { FakeInstalledAppsRepository } from "../../fakes/FakeInstalledAppsRepository";
import { FakeTimer } from "../../fakes/FakeTimer";
import { FakeWebSocket, WebSocketState } from "../../fakes/FakeWebSocket";

class RecordingSocket extends FakeWebSocket {
  readonly frames: string[] = [];
  sendError?: Error;
  override send(data: string): void {
    if (this.sendError) {
      throw this.sendError;
    }
    super.send(data);
    this.frames.push(data);
  }
}

async function harness() {
  const timer = new FakeTimer();
  const socket = new RecordingSocket("ws://fake", "none", 0, timer);
  const client = AndroidCtrlProxyClient.createForTesting(
    { deviceId: "storage-send-command", platform: "android", name: "Android" },
    new FakeAdbExecutor(),
    {
      webSocketFactory: () => socket,
      timer,
      installedAppsRepository: new FakeInstalledAppsRepository(),
      idGenerator: new CountingIdGenerator("delegate"),
    },
  );
  await Promise.resolve();
  timer.advanceTime(123);
  client.connectionTestHooks.socket = socket;
  client.connectionTestHooks.supportedCommands = new Set([
    "discover_keystore",
    "get_sdk_capabilities",
    SDK_CAPABILITIES_USER_ID_CAPABILITY,
  ]);
  const manager = client.connectionTestHooks.requestManager;
  const ids = new CountingIdGenerator("wire");
  manager.generateId = (prefix) => `${prefix}_${ids.next()}`;
  let connects = 0;
  let cancels = 0;
  client.ensureConnected = async () => {
    connects++;
    return true;
  };
  client.testHooks.overrideCancelScreenshotBackoff(() => {
    cancels++;
  });
  const storage = client.testHooks.storage();
  return {
    client,
    storage,
    timer,
    socket,
    manager,
    connects: () => connects,
    cancels: () => cancels,
  };
}

async function flushDispatch() {
  for (let i = 0; i < 8; i++) {
    await Promise.resolve();
  }
}

const keystoreState: Awaited<ReturnType<CtrlProxyStorage["discoverKeystore"]>> = {
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
const snapshot = {
  schemaVersion: 1,
  capabilities: [],
  policy: { captureHeaders: false, captureBodies: false, allowMutations: false },
};
const subscription = { packageName: "pkg", fileName: "prefs", subscriptionId: "pkg:prefs" };
type StorageResult = Awaited<
  ReturnType<
    CtrlProxyStorage[
      | "getPreference"
      | "listPreferenceFiles"
      | "getPreferenceEntries"
      | "discoverKeystore"
      | "getSdkCapabilities"
      | "subscribeStorage"
      | "unsubscribeStorage"
      | "setPreference"
      | "removePreference"
      | "clearPreferenceStore"]
  >
>;
const methods: Array<{
  operation: string;
  label: string;
  invoke: (storage: CtrlProxyStorage) => Promise<StorageResult>;
  frame: (
    requestId: string,
  ) => ReturnType<(typeof ctrlProxyRequests)[keyof typeof ctrlProxyRequests]>;
  literal: string;
  response: object;
  result: StorageResult;
  write?: boolean;
}> = [
  {
    operation: "list_preference_files",
    label: "List preference files",
    invoke: (s: CtrlProxyStorage) => s.listPreferenceFiles("pkg", 50),
    frame: (requestId: string) =>
      ctrlProxyRequests.listPreferenceFiles({ requestId, packageName: "pkg" }),
    literal:
      '{"type":"list_preference_files","requestId":"list_preference_files_123_delegate-1","packageName":"pkg"}',
    response: { type: "preference_files", files: [] },
    result: [],
  },
  {
    operation: "get_preferences",
    label: "Get preferences",
    invoke: (s: CtrlProxyStorage) => s.getPreferenceEntries("pkg", "prefs", 50),
    frame: (requestId: string) =>
      ctrlProxyRequests.getPreferences({ requestId, packageName: "pkg", fileName: "prefs" }),
    literal:
      '{"type":"get_preferences","requestId":"get_preferences_123_delegate-1","packageName":"pkg","fileName":"prefs"}',
    response: { type: "preferences", entries: [] },
    result: [],
  },
  {
    operation: "discover_keystore",
    label: "Keystore",
    invoke: (s: CtrlProxyStorage) => s.discoverKeystore("pkg", 50),
    frame: (requestId: string) =>
      ctrlProxyRequests.discoverKeystore({ requestId, packageName: "pkg" }),
    literal:
      '{"type":"discover_keystore","requestId":"discover_keystore_wire-1","packageName":"pkg"}',
    response: { type: "keystore_discovery", state: keystoreState },
    result: keystoreState,
  },
  {
    operation: "get_sdk_capabilities",
    label: "SDK",
    invoke: (s: CtrlProxyStorage) => s.getSdkCapabilities("pkg", 10, 50),
    frame: (requestId: string) =>
      ctrlProxyRequests.getSdkCapabilities({ requestId, packageName: "pkg", userId: 10 }),
    literal:
      '{"type":"get_sdk_capabilities","requestId":"get_sdk_capabilities_wire-1","packageName":"pkg","userId":10}',
    response: { type: "sdk_capabilities", state: { outcome: "ok", snapshot } },
    result: { status: "available", snapshot },
  },
  {
    operation: "list_data_stores",
    label: "List data stores",
    invoke: (s: CtrlProxyStorage) => s.listDataStores("pkg", "adapter", 50),
    frame: (requestId: string) =>
      ctrlProxyRequests.listDataStores({ requestId, packageName: "pkg", adapterName: "adapter" }),
    literal:
      '{"type":"list_data_stores","requestId":"list_data_stores_123_delegate-1","packageName":"pkg","adapterName":"adapter"}',
    response: { type: "preference_files", files: [] },
    result: [],
  },
  {
    operation: "get_data_store",
    label: "Get data store",
    invoke: (s: CtrlProxyStorage) => s.getDataStore("pkg", "adapter", "store", 50),
    frame: (requestId: string) =>
      ctrlProxyRequests.getDataStore({
        requestId,
        packageName: "pkg",
        adapterName: "adapter",
        storeName: "store",
      }),
    literal:
      '{"type":"get_data_store","requestId":"get_data_store_123_delegate-1","packageName":"pkg","adapterName":"adapter","storeName":"store"}',
    response: { type: "preferences", entries: [] },
    result: [],
  },
  {
    operation: "subscribe_storage",
    label: "Subscribe storage",
    invoke: (s: CtrlProxyStorage) => s.subscribeStorage("pkg", "prefs", 50),
    frame: (requestId: string) =>
      ctrlProxyRequests.subscribeStorage({ requestId, packageName: "pkg", fileName: "prefs" }),
    literal:
      '{"type":"subscribe_storage","requestId":"subscribe_storage_123_delegate-1","packageName":"pkg","fileName":"prefs"}',
    response: { type: "subscribe_storage_result", ...subscription },
    result: subscription,
  },
  {
    operation: "unsubscribe_storage",
    label: "Unsubscribe storage",
    invoke: (s: CtrlProxyStorage) => s.unsubscribeStorage("pkg:prefs", 50),
    frame: (requestId: string) =>
      ctrlProxyRequests.unsubscribeStorage({ requestId, subscriptionId: "pkg:prefs" }),
    literal:
      '{"type":"unsubscribe_storage","requestId":"unsubscribe_storage_123_delegate-1","subscriptionId":"pkg:prefs"}',
    response: { type: "unsubscribe_storage_result" },
    result: undefined,
  },
  {
    operation: "get_preference",
    label: "Get preference",
    invoke: (s: CtrlProxyStorage) => s.getPreference("pkg", "prefs", "key", 50),
    frame: (requestId: string) =>
      ctrlProxyRequests.getPreference({
        requestId,
        packageName: "pkg",
        fileName: "prefs",
        key: "key",
      }),
    literal:
      '{"type":"get_preference","requestId":"get_preference_123_delegate-1","packageName":"pkg","fileName":"prefs","key":"key"}',
    response: { type: "get_preference_result", found: false },
    result: null,
  },
  {
    operation: "set_preference",
    label: "Set preference",
    write: true,
    invoke: (s: CtrlProxyStorage) => s.setPreference("pkg", "prefs", "key", null, "STRING", 50),
    frame: (requestId: string) =>
      ctrlProxyRequests.setPreference({
        requestId,
        packageName: "pkg",
        fileName: "prefs",
        key: "key",
        value: null,
        valueType: "STRING",
      }),
    literal:
      '{"type":"set_preference","requestId":"set_preference_123_delegate-1","packageName":"pkg","fileName":"prefs","key":"key","value":null,"valueType":"STRING"}',
    response: { type: "set_preference_result" },
    result: undefined,
  },
  {
    operation: "remove_preference",
    label: "Remove preference",
    write: true,
    invoke: (s: CtrlProxyStorage) => s.removePreference("pkg", "prefs", "key", 50),
    frame: (requestId: string) =>
      ctrlProxyRequests.removePreference({
        requestId,
        packageName: "pkg",
        fileName: "prefs",
        key: "key",
      }),
    literal:
      '{"type":"remove_preference","requestId":"remove_preference_123_delegate-1","packageName":"pkg","fileName":"prefs","key":"key"}',
    response: { type: "remove_preference_result" },
    result: undefined,
  },
  {
    operation: "clear_preferences",
    label: "Clear preferences",
    write: true,
    invoke: (s: CtrlProxyStorage) => s.clearPreferenceStore("pkg", "prefs", 50),
    frame: (requestId: string) =>
      ctrlProxyRequests.clearPreferences({ requestId, packageName: "pkg", fileName: "prefs" }),
    literal:
      '{"type":"clear_preferences","requestId":"clear_preferences_123_delegate-1","packageName":"pkg","fileName":"prefs"}',
    response: { type: "clear_preferences_result" },
    result: undefined,
  },
];

for (const method of methods) {
  describe(`storage ${method.operation} sendCommand`, () => {
    const id: string = JSON.parse(method.literal).requestId;
    const isSdk = method.operation === "get_sdk_capabilities";
    const isKeystore = method.operation === "discover_keystore";
    const respond = (h: Awaited<ReturnType<typeof harness>>) =>
      h.client.testHooks.handleWebSocketMessage(
        JSON.stringify({ ...method.response, requestId: id, success: true, totalTimeMs: 7 }),
      );

    test("preserves the literal and builder frame, bypasses generic support, and correlates the reply", async () => {
      const h = await harness();
      h.client.testHooks.rejectedCommands.add(method.operation);
      const pending = method.invoke(h.storage);
      await flushDispatch();
      expect(h.socket.frames).toEqual([method.literal]);
      expect(h.socket.frames[0]).toBe(serializeCtrlProxyRequest(method.frame(id)));
      expect(h.connects()).toBe(1);
      expect(h.cancels()).toBe(0);
      await respond(h);
      expect(await pending).toEqual(method.result);
      expect(h.manager.getPendingCount()).toBe(0);
      expect(h.timer.getPendingTimeoutCount()).toBe(0);
    });

    test("preserves its timeout error or typed unavailable result", async () => {
      const h = await harness();
      const pending = method.invoke(h.storage);
      await flushDispatch();
      expect(h.manager.getPendingCount()).toBe(1);
      h.timer.advanceTime(50);
      if (isSdk) {
        expect(await pending).toEqual({ status: "unavailable", reason: "REQUEST_TIMEOUT" });
      } else if (isKeystore) {
        expect(await pending).toEqual({
          ...keystoreState,
          outcome: "unavailable",
          reason: "BRIDGE_UNAVAILABLE",
          bridgeAvailable: false,
          deviceLocked: "unknown",
        });
      } else {
        await expect(pending).rejects.toThrow(`${method.label} timeout after 50ms`);
      }
      expect(h.manager.getPendingCount()).toBe(0);
      expect(h.timer.getPendingTimeoutCount()).toBe(0);
    });

    for (const failure of ["connect", "socket", "send", "close", "response"] as const) {
      test(`settles ${failure} failure without a pending request`, async () => {
        const h = await harness();
        if (failure === "connect") {
          h.client.ensureConnected = async () => false;
        }
        if (failure === "socket") {
          h.client.connectionTestHooks.socket = null;
        }
        if (failure === "send") {
          h.socket.sendError = new Error("send failed");
        }
        const pending = method.invoke(h.storage);
        await flushDispatch();
        if (failure === "close") {
          await h.client.close();
        }
        if (failure === "response") {
          h.manager.resolveError(id, "remote failure", 7);
        }
        if (isSdk) {
          expect(await pending).toEqual({
            status: "unavailable",
            reason: failure === "response" ? "MALFORMED_RESPONSE" : "CTRLPROXY_UNREACHABLE",
          });
        } else if (isKeystore) {
          await expect(pending).rejects.toThrow("Failed to discover Android Keystore capabilities");
        } else {
          const message = {
            connect: "Failed to connect to accessibility service",
            socket: "WebSocket not connected",
            send: "send failed",
            close: "WebSocket connection closed",
            response: "remote failure",
          }[failure];
          const error = await pending.catch((error: unknown) => error);
          expect(error).toBeInstanceOf(Error);
          expect((error as Error).message).toBe(message);
          if (failure === "connect" || failure === "socket") {
            expect(isCtrlProxyStorageUnavailableError(error)).toBe(true);
          }
        }
        expect(h.manager.getPendingCount()).toBe(0);
        expect(h.timer.getPendingTimeoutCount()).toBe(0);
        if (failure === "connect" || failure === "socket" || failure === "send") {
          expect(h.socket.frames).toEqual([]);
        }
      });
    }

    for (const abortBeforeConnect of [true, false]) {
      test(`preserves ${abortBeforeConnect ? "pre-aborted" : "cancelled-while-connecting"} ambient behavior`, async () => {
        const h = await harness();
        const controller = new AbortController();
        const connect = Promise.withResolvers<boolean>();
        h.client.ensureConnected = () => connect.promise;
        if (abortBeforeConnect) {
          controller.abort(new Error("cancelled"));
        }
        const pending = runWithAbortSignal(controller.signal, () => method.invoke(h.storage));
        if (!abortBeforeConnect) {
          controller.abort(new Error("cancelled"));
        }
        connect.resolve(true);
        await flushDispatch();
        if (method.write) {
          await expect(pending).rejects.toThrow("cancelled");
          expect(h.socket.frames).toEqual([]);
        } else {
          expect(h.socket.frames).toEqual([method.literal]);
          await respond(h);
          expect(await pending).toEqual(method.result);
        }
        expect(h.manager.getPendingCount()).toBe(0);
      });
    }

    test("does not add in-flight ambient cancellation", async () => {
      const h = await harness();
      const controller = new AbortController();
      const pending = runWithAbortSignal(controller.signal, () => method.invoke(h.storage));
      await flushDispatch();
      controller.abort(new Error("cancelled after dispatch"));
      expect(h.manager.getPendingCount()).toBe(1);
      await respond(h);
      expect(await pending).toEqual(method.result);
      expect(h.manager.getPendingCount()).toBe(0);
    });
  });
}

for (const operation of ["listPreferenceFiles", "getPreferenceEntries"] as const) {
  test(`${operation} retains ProviderUnavailableError for a correlated remote error`, async () => {
    const h = await harness();
    const pending =
      operation === "listPreferenceFiles"
        ? h.storage.listPreferenceFiles("pkg")
        : h.storage.getPreferenceEntries("pkg", "prefs");
    await flushDispatch();
    h.manager.resolveError(
      h.manager.getPendingIds()[0],
      "Unknown authority pkg.automobile.sharedprefs",
    );
    await expect(pending).rejects.toBeInstanceOf(ProviderUnavailableError);
    expect(h.manager.getPendingCount()).toBe(0);
  });
}

for (const advertised of [false, true]) {
  test(`SDK userId is omitted when ${advertised ? "unspecified" : "not advertised"}`, async () => {
    const h = await harness();
    if (!advertised) {
      h.client.connectionTestHooks.supportedCommands!.delete(SDK_CAPABILITIES_USER_ID_CAPABILITY);
    }
    const pending = h.storage.getSdkCapabilities("pkg", advertised ? undefined : 10, 50);
    await flushDispatch();
    const id = "get_sdk_capabilities_wire-1";
    expect(h.socket.frames).toEqual([
      '{"type":"get_sdk_capabilities","requestId":"get_sdk_capabilities_wire-1","packageName":"pkg"}',
    ]);
    expect(h.socket.frames[0]).toBe(
      serializeCtrlProxyRequest(
        ctrlProxyRequests.getSdkCapabilities({ requestId: id, packageName: "pkg" }),
      ),
    );
    h.timer.advanceTime(50);
    await pending;
  });
}

for (const operation of ["discoverKeystore", "getSdkCapabilities"] as const) {
  test(`${operation} keeps the advertised capability precheck`, async () => {
    const h = await harness();
    h.client.connectionTestHooks.supportedCommands = new Set();
    const result = await h.storage[operation]("pkg");
    expect(result).toMatchObject(
      operation === "discoverKeystore"
        ? { outcome: "unsupported", reason: "DECLARED_UNSUPPORTED" }
        : { status: "unavailable", reason: "CTRLPROXY_UNSUPPORTED" },
    );
    expect(h.socket.frames).toEqual([]);
    expect(h.manager.getPendingCount()).toBe(0);
  });
}

test("closed socket keeps the exact unavailable error and leaves no request", async () => {
  const h = await harness();
  h.socket.readyState = WebSocketState.CLOSED;
  const error = await h.storage.listPreferenceFiles("pkg").catch((error: unknown) => error);
  expect(isCtrlProxyStorageUnavailableError(error)).toBe(true);
  expect(h.manager.getPendingCount()).toBe(0);
});

test("legacy undefined preference values stay omitted, while null remains explicit", async () => {
  const h = await harness();
  // Exercise an untyped caller without widening the public string | null signature.
  const pending: Promise<void> = Reflect.apply(h.storage.setPreference, h.storage, [
    "pkg",
    "prefs",
    "key",
    undefined,
    "STRING",
    50,
  ]);
  await flushDispatch();
  const requestId = "set_preference_123_delegate-1";
  expect(h.socket.frames).toEqual([
    '{"type":"set_preference","requestId":"set_preference_123_delegate-1","packageName":"pkg","fileName":"prefs","key":"key","valueType":"STRING"}',
  ]);
  expect(h.socket.frames[0]).toBe(
    serializeCtrlProxyRequest(
      Reflect.apply(ctrlProxyRequests.setPreference, ctrlProxyRequests, [
        {
          requestId,
          packageName: "pkg",
          fileName: "prefs",
          key: "key",
          value: undefined,
          valueType: "STRING",
        },
      ]),
    ),
  );
  h.manager.resolve(requestId, { success: true, totalTimeMs: 0 });
  await pending;
  expect(h.manager.getPendingCount()).toBe(0);
});

for (const method of methods.filter((method) => method.write)) {
  test(`${method.operation} preserves cancellation precedence when connecting returns false`, async () => {
    const h = await harness();
    const controller = new AbortController();
    h.client.ensureConnected = async () => {
      controller.abort(new Error("cancel during failed connect"));
      return false;
    };
    await expect(
      runWithAbortSignal(controller.signal, () => method.invoke(h.storage)),
    ).rejects.toThrow("cancel during failed connect");
    expect(h.socket.frames).toEqual([]);
    expect(h.manager.getPendingCount()).toBe(0);
  });
}

test("an empty correlated failure keeps the method's fallback error", async () => {
  const h = await harness();
  const pending = h.storage.listPreferenceFiles("pkg");
  await flushDispatch();
  h.manager.resolveError(h.manager.getPendingIds()[0], "", 7);
  await expect(pending).rejects.toThrow("Failed to list preference files");
  expect(h.manager.getPendingCount()).toBe(0);
});
