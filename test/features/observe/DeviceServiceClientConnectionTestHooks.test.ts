import { describe, expect, test } from "bun:test";
import { DeviceServiceClient } from "../../../src/features/observe/DeviceServiceClient";
import { FakeTimer } from "../../fakes/FakeTimer";
import { createInstantFailureWebSocketFactory } from "../../fakes/FakeWebSocket";

/** Minimal concrete client: the hooks are base-class plumbing, independent of either platform. */
class HookedClient extends DeviceServiceClient {
  protected readonly logTag = "HookedClient";
  constructor(timer: FakeTimer) {
    super(timer, createInstantFailureWebSocketFactory(timer));
  }
  protected getWebSocketUrl(): string {
    return "ws://fake.invalid";
  }
  protected handleMessage(): void {}
  protected onConnectionEstablished(): void {}
  protected onConnectionClosed(): void {}
  protected async setupBeforeConnect(): Promise<void> {}
  protected cancelScreenshotBackoff(): void {}
}

describe("DeviceServiceClient connectionTestHooks state (#11865)", () => {
  test("reads report a fresh client's connection bookkeeping", async () => {
    const client = new HookedClient(new FakeTimer());
    try {
      const hooks = client.connectionTestHooks;
      expect(hooks.autoReconnectEnabled).toBe(true);
      expect(hooks.supportedCommands).toBeNull();
      expect(hooks.isConnecting).toBe(false);
      expect(hooks.pendingConnectJoiners).toBe(0);
      expect(hooks.inFlightConnectPromise).toBeNull();
      expect(hooks.reconnectTimeoutId).toBeNull();
      expect(hooks.connectionAttempts).toBe(0);
      expect(hooks.lastConnectionAttempt).toBe(0);
    } finally {
      await client.close();
    }
  });

  test("writes reach the client and earlier hook objects read them live", async () => {
    const timer = new FakeTimer();
    timer.setCurrentTime(5_000);
    const client = new HookedClient(timer);
    try {
      const earlier = client.connectionTestHooks;
      client.connectionTestHooks.supportedCommands = new Set(["tap", "request_hierarchy"]);
      expect(client.getCachedSupportedCommands()).toEqual(["request_hierarchy", "tap"]);
      expect(earlier.supportedCommands).toEqual(new Set(["tap", "request_hierarchy"]));

      client.connectionTestHooks.connectionAttempts = 99;
      client.connectionTestHooks.lastConnectionAttempt = 5_000;
      expect(client.getReconnectStatus()).toMatchObject({
        state: "cooldown",
        connectionAttempts: 99,
      });
      expect(earlier.connectionAttempts).toBe(99);

      client.connectionTestHooks.autoReconnectEnabled = false;
      expect(earlier.autoReconnectEnabled).toBe(false);

      client.connectionTestHooks.supportedCommands = null;
      expect(client.getCachedSupportedCommands()).toBeNull();
    } finally {
      await client.close();
    }
  });
});
