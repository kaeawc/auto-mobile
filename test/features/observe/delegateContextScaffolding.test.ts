import { createExecResult } from "../../../src/utils/execResult";
/**
 * Pinning test for the delegate-context scaffolding shared by the Android and iOS
 * CtrlProxy clients (issue #5458).
 *
 * Both clients build a `DelegateContext` (and a platform-specific
 * `HierarchyDelegateContext`) and hand it to a family of lazily-constructed delegate
 * objects. The context-builders and the lazy-getter singleton pattern were previously
 * copy-pasted per client; #5458 lifts the shared scaffolding onto the
 * `DeviceServiceClient` base.
 *
 * This suite pins the observable contract that the refactor must preserve:
 *   - the exact field set of each client's base `DelegateContext`,
 *   - the wiring of those fields to live client state,
 *   - the exact field set of each client's `HierarchyDelegateContext`,
 *   - the singleton-caching semantics of the delegate getters.
 *
 * The getters and context-builders are private, so they are reached through each client's typed
 * `testHooks`.
 */

import { describe, expect, test } from "bun:test";
import { AndroidCtrlProxyClient } from "../../../src/features/observe/android";
import { IOSCtrlProxyClient } from "../../../src/features/observe/ios";
import { BootedDevice } from "../../../src/models";
import { FakeAdbExecutor } from "../../fakes/FakeAdbExecutor";
import { FakeTimer } from "../../fakes/FakeTimer";
import { FakeWebSocket } from "../../fakes/FakeWebSocket";
import type { WebSocketFactory } from "../../../src/features/observe/DeviceServiceClient";

const androidDevice: BootedDevice = {
  deviceId: "delegate-context-android",
  platform: "android",
  name: "Test Device",
};

const iosDevice: BootedDevice = {
  deviceId: "A1B2C3D4-E5F6-7890-ABCD-EF1234567890",
  platform: "ios",
  name: "iPhone 16 Simulator",
};

function createAndroidClient(): AndroidCtrlProxyClient {
  const fakeAdb = new FakeAdbExecutor();
  fakeAdb.setCommandResponse("forward", createExecResult("8765", ""));
  fakeAdb.setScreenState(true);
  const fakeTimer = new FakeTimer();
  AndroidCtrlProxyClient.resetInstances();
  return AndroidCtrlProxyClient.createForTesting(androidDevice, fakeAdb, {
    webSocketFactory: (url: string) => new FakeWebSocket(url, "none", 0, fakeTimer),
    timer: fakeTimer,
  });
}

function createIosClient(): IOSCtrlProxyClient {
  const fakeTimer = new FakeTimer();
  IOSCtrlProxyClient.resetInstances();
  const factory: WebSocketFactory = (url: string) => new FakeWebSocket(url, "none", 0, fakeTimer);
  return IOSCtrlProxyClient.createForTesting(iosDevice, 8765, {
    wsFactory: factory,
    timer: fakeTimer,
  });
}

describe("DelegateContext scaffolding (issue #5458)", () => {
  describe("Android base DelegateContext", () => {
    test("exposes exactly the shared field set", () => {
      const client = createAndroidClient();
      const ctx = client.testHooks.createDelegateContext();
      expect(Object.keys(ctx).sort()).toEqual([
        "cancelScreenshotBackoff",
        "ensureConnected",
        "getSupportedCommands",
        "getWebSocket",
        "idGenerator",
        "isCommandSupported",
        "prototypeAssetCache",
        "requestManager",
        "savedPrototypeMirror",
        "timer",
      ]);
    });

    test("wires the shared fields to live client state", () => {
      const client = createAndroidClient();
      const ctx = client.testHooks.createDelegateContext();
      expect(ctx.requestManager).toBe(client.connectionTestHooks.requestManager);
      expect(client.testHooks.injected().timer).toBe(ctx.timer);
      // Not connected yet: the WebSocket accessor mirrors the client's null socket.
      expect(ctx.getWebSocket()).toBe(client.connectionTestHooks.socket);
      expect(typeof ctx.ensureConnected).toBe("function");
      expect(typeof ctx.isCommandSupported).toBe("function");
      expect(typeof ctx.getSupportedCommands).toBe("function");
      expect(typeof ctx.cancelScreenshotBackoff).toBe("function");
    });
  });

  describe("Android HierarchyDelegateContext", () => {
    test("extends the base with the Android-specific fields", () => {
      const client = createAndroidClient();
      const ctx = client.testHooks.createHierarchyDelegateContext();
      expect(Object.keys(ctx).sort()).toEqual([
        "adb",
        "cancelScreenshotBackoff",
        "device",
        "ensureConnected",
        "getCachedHierarchy",
        "getLastWebSocketTimeout",
        "getSupportedCommands",
        "getWebSocket",
        "idGenerator",
        "isCommandSupported",
        "markObserverHierarchyRequest",
        "prototypeAssetCache",
        "requestManager",
        "savedPrototypeMirror",
        "setCachedHierarchy",
        "setLastWebSocketTimeout",
        "timer",
        "unmarkObserverHierarchyRequest",
      ]);
      expect(client.testHooks.injected().device).toBe(ctx.device);
      expect(client.testHooks.injected().adb).toBe(ctx.adb);
    });
  });

  describe("iOS base DelegateContext", () => {
    test("exposes the shared fields plus the iOS command-capability fields", () => {
      const client = createIosClient();
      const ctx = client.testHooks.createDelegateContext();
      expect(Object.keys(ctx).sort()).toEqual([
        "cancelScreenshotBackoff",
        "ensureConnected",
        "getReconnectStatus",
        "getSupportedCommands",
        "getWebSocket",
        "isCommandSupported",
        "requestManager",
        "serializeRequest",
        "timer",
        "unsupportedCommandError",
        "wireDeadlineParams",
      ]);
    });

    test("wires the shared fields to live client state", () => {
      const client = createIosClient();
      const ctx = client.testHooks.createDelegateContext();
      expect(ctx.requestManager).toBe(client.connectionTestHooks.requestManager);
      expect(client.testHooks.timer).toBe(ctx.timer);
      expect(ctx.getWebSocket()).toBe(client.connectionTestHooks.socket);
      expect(typeof ctx.ensureConnected).toBe("function");
      expect(typeof ctx.cancelScreenshotBackoff).toBe("function");
      expect(typeof ctx.getReconnectStatus).toBe("function");
      expect(typeof ctx.isCommandSupported).toBe("function");
      expect(typeof ctx.getSupportedCommands).toBe("function");
      expect(typeof ctx.unsupportedCommandError).toBe("function");
    });
  });

  describe("iOS HierarchyDelegateContext", () => {
    test("extends the base with the iOS-specific fields", () => {
      const client = createIosClient();
      const ctx = client.testHooks.createHierarchyDelegateContext();
      expect(Object.keys(ctx).sort()).toEqual([
        "cacheFreshTtlMs",
        "cancelScreenshotBackoff",
        "ensureConnected",
        "getCachedHierarchy",
        "getDeviceId",
        "getLastConnectFailure",
        "getReconnectStatus",
        "getSupportedCommands",
        "getWebSocket",
        "isCommandSupported",
        "markObserverHierarchyRequest",
        "requestManager",
        "serializeRequest",
        "setCachedHierarchy",
        "suppressHierarchyObservationStreamPush",
        "timer",
        "unmarkObserverHierarchyRequest",
        "unsupportedCommandError",
        "wireDeadlineParams",
      ]);
    });
  });

  describe("delegate getters are cached singletons", () => {
    test("Android getters return a stable instance", () => {
      const client = createAndroidClient();
      expect(client.testHooks.gestures()).toBe(client.testHooks.gestures());
      expect(client.testHooks.text()).toBe(client.testHooks.text());
      expect(client.testHooks.hierarchy()).toBe(client.testHooks.hierarchy());
      expect(client.testHooks.storage()).toBe(client.testHooks.storage());
      expect(client.testHooks.certificates()).toBe(client.testHooks.certificates());
      expect(client.testHooks.focus()).toBe(client.testHooks.focus());
      expect(client.testHooks.highlights()).toBe(client.testHooks.highlights());
      expect(client.testHooks.packages()).toBe(client.testHooks.packages());
    });

    test("iOS getters return a stable instance", () => {
      const client = createIosClient();
      expect(client.testHooks.delegates().gestures).toBe(client.testHooks.delegates().gestures);
      expect(client.testHooks.delegates().text).toBe(client.testHooks.delegates().text);
      expect(client.testHooks.delegates().hierarchy).toBe(client.testHooks.delegates().hierarchy);
      expect(client.testHooks.delegates().screenshot).toBe(client.testHooks.delegates().screenshot);
      expect(client.testHooks.delegates().navigation).toBe(client.testHooks.delegates().navigation);
      expect(client.testHooks.delegates().clipboard).toBe(client.testHooks.delegates().clipboard);
      expect(client.testHooks.delegates().voiceOver).toBe(client.testHooks.delegates().voiceOver);
      expect(client.testHooks.delegates().storage).toBe(client.testHooks.delegates().storage);
      expect(client.testHooks.delegates().keyboard).toBe(client.testHooks.delegates().keyboard);
      expect(client.testHooks.delegates().highlights).toBe(client.testHooks.delegates().highlights);
      expect(client.testHooks.delegates().database).toBe(client.testHooks.delegates().database);
      expect(client.testHooks.delegates().permissions).toBe(
        client.testHooks.delegates().permissions,
      );
    });
  });
});
