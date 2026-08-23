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
 * Private members are reached with `(client as any)` — the established pattern in the
 * sibling client suites — because the getters and context-builders are intentionally
 * private.
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
  isEmulator: true,
  name: "Test Device",
};

const iosDevice: BootedDevice = {
  deviceId: "A1B2C3D4-E5F6-7890-ABCD-EF1234567890",
  platform: "ios",
  name: "iPhone 16 Simulator",
};

function createAndroidClient(): AndroidCtrlProxyClient {
  const fakeAdb = new FakeAdbExecutor();
  fakeAdb.setCommandResponse("forward", { stdout: "8765", stderr: "" });
  fakeAdb.setScreenState(true);
  const fakeTimer = new FakeTimer();
  AndroidCtrlProxyClient.resetInstances();
  return AndroidCtrlProxyClient.createForTesting(
    androidDevice,
    fakeAdb,
    (url: string) => new FakeWebSocket(url, "none", 0, fakeTimer) as unknown as WebSocket,
    fakeTimer
  );
}

function createIosClient(): IOSCtrlProxyClient {
  const fakeTimer = new FakeTimer();
  IOSCtrlProxyClient.resetInstances();
  const factory: WebSocketFactory = (url: string) =>
    new FakeWebSocket(url, "none", 0, fakeTimer) as unknown as WebSocket;
  return IOSCtrlProxyClient.createForTesting(iosDevice, 8765, factory, fakeTimer);
}

describe("DelegateContext scaffolding (issue #5458)", () => {
  describe("Android base DelegateContext", () => {
    test("exposes exactly the shared field set", () => {
      const client = createAndroidClient();
      const ctx = (client as any).createDelegateContext();
      expect(Object.keys(ctx).sort()).toEqual([
        "cancelScreenshotBackoff",
        "ensureConnected",
        "getWebSocket",
        "requestManager",
        "timer",
      ]);
    });

    test("wires the shared fields to live client state", () => {
      const client = createAndroidClient();
      const ctx = (client as any).createDelegateContext();
      expect(ctx.requestManager).toBe((client as any).requestManager);
      expect(ctx.timer).toBe((client as any).timer);
      // Not connected yet: the WebSocket accessor mirrors the client's null socket.
      expect(ctx.getWebSocket()).toBe((client as any).ws);
      expect(typeof ctx.ensureConnected).toBe("function");
      expect(typeof ctx.cancelScreenshotBackoff).toBe("function");
    });
  });

  describe("Android HierarchyDelegateContext", () => {
    test("extends the base with the Android-specific fields", () => {
      const client = createAndroidClient();
      const ctx = (client as any).createHierarchyDelegateContext();
      expect(Object.keys(ctx).sort()).toEqual([
        "adb",
        "cancelScreenshotBackoff",
        "device",
        "ensureConnected",
        "getCachedHierarchy",
        "getLastWebSocketTimeout",
        "getWebSocket",
        "requestManager",
        "setCachedHierarchy",
        "setLastWebSocketTimeout",
        "timer",
      ]);
      expect(ctx.device).toBe((client as any).device);
      expect(ctx.adb).toBe((client as any).adb);
    });
  });

  describe("iOS base DelegateContext", () => {
    test("exposes the shared fields plus the iOS command-capability fields", () => {
      const client = createIosClient();
      const ctx = (client as any).createDelegateContext();
      expect(Object.keys(ctx).sort()).toEqual([
        "cancelScreenshotBackoff",
        "ensureConnected",
        "getReconnectStatus",
        "getSupportedCommands",
        "getWebSocket",
        "isCommandSupported",
        "requestManager",
        "timer",
        "unsupportedCommandError",
      ]);
    });

    test("wires the shared fields to live client state", () => {
      const client = createIosClient();
      const ctx = (client as any).createDelegateContext();
      expect(ctx.requestManager).toBe((client as any).requestManager);
      expect(ctx.timer).toBe((client as any).timer);
      expect(ctx.getWebSocket()).toBe((client as any).ws);
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
      const ctx = (client as any).createHierarchyDelegateContext();
      expect(Object.keys(ctx).sort()).toEqual([
        "cacheFreshTtlMs",
        "cancelScreenshotBackoff",
        "ensureConnected",
        "getCachedHierarchy",
        "getReconnectStatus",
        "getSupportedCommands",
        "getWebSocket",
        "isCommandSupported",
        "requestManager",
        "setCachedHierarchy",
        "suppressHierarchyObservationStreamPush",
        "timer",
        "unsupportedCommandError",
      ]);
    });
  });

  describe("delegate getters are cached singletons", () => {
    test("Android getters return a stable instance", () => {
      const client = createAndroidClient();
      expect((client as any).gestures).toBe((client as any).gestures);
      expect((client as any).text).toBe((client as any).text);
      expect((client as any).hierarchy).toBe((client as any).hierarchy);
      expect((client as any).storage).toBe((client as any).storage);
      expect((client as any).certificates).toBe((client as any).certificates);
      expect((client as any).focus).toBe((client as any).focus);
      expect((client as any).highlights).toBe((client as any).highlights);
      expect((client as any).packages).toBe((client as any).packages);
    });

    test("iOS getters return a stable instance", () => {
      const client = createIosClient();
      expect((client as any).gestures).toBe((client as any).gestures);
      expect((client as any).text).toBe((client as any).text);
      expect((client as any).hierarchy).toBe((client as any).hierarchy);
      expect((client as any).screenshot).toBe((client as any).screenshot);
      expect((client as any).navigation).toBe((client as any).navigation);
      expect((client as any).clipboard).toBe((client as any).clipboard);
      expect((client as any).voiceOver).toBe((client as any).voiceOver);
      expect((client as any).storage).toBe((client as any).storage);
      expect((client as any).keyboard).toBe((client as any).keyboard);
      expect((client as any).highlights).toBe((client as any).highlights);
      expect((client as any).database).toBe((client as any).database);
      expect((client as any).permissions).toBe((client as any).permissions);
    });
  });
});
