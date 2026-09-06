import { afterEach, describe, expect, test } from "bun:test";
import { DeviceServiceClient } from "../../../src/features/observe/DeviceServiceClient";
import { CtrlProxyForwardingLeaseConflictError } from "../../../src/features/observe/shared/CtrlProxyForwardingLeaseConflictError";
import { createSuccessWebSocketFactory } from "../../fakes/FakeWebSocket";
import { FakeTimer } from "../../fakes/FakeTimer";
import type { PerformanceTracker } from "../../../src/utils/PerformanceTracker";
import { NoOpPerformanceTracker } from "../../../src/utils/PerformanceTracker";
import type WebSocket from "ws";

/**
 * Concrete subclass of DeviceServiceClient whose platform-setup failure is
 * controlled per-test (issue #6260 PRRT ft82e): RunnerReadinessService must
 * detect a CtrlProxyForwardingLeaseConflictError specifically, not any
 * connect-attempt failure.
 */
class TestDeviceServiceClient extends DeviceServiceClient {
  protected readonly logTag = "TestClient";
  setupError: Error | null = null;

  constructor(timer: FakeTimer, wsFactory: (url: string) => WebSocket) {
    super(timer, wsFactory);
  }

  protected getWebSocketUrl(): string {
    return "ws://localhost:9999/ws";
  }

  protected handleMessage(_data: WebSocket.Data): void {}

  protected onConnectionEstablished(): void {}

  protected onConnectionClosed(): void {}

  protected async setupBeforeConnect(
    _perf: PerformanceTracker,
    _signal: AbortSignal,
  ): Promise<void> {
    if (this.setupError) {
      throw this.setupError;
    }
  }

  disableAutoReconnect(): void {
    this.autoReconnectEnabled = false;
  }
}

describe("DeviceServiceClient forwarding-lease conflict detection (issue #6260 PRRT ft82e)", () => {
  let client: TestDeviceServiceClient | null = null;

  afterEach(async () => {
    if (client) {
      client.disableAutoReconnect();
      await client.close();
      client = null;
    }
  });

  test("tags a CtrlProxyForwardingLeaseConflictError as the forwarding-lease conflict", async () => {
    const timer = new FakeTimer();
    client = new TestDeviceServiceClient(timer, createSuccessWebSocketFactory());
    client.disableAutoReconnect();
    client.setupError = new CtrlProxyForwardingLeaseConflictError(
      "Another AutoMobile process (PID 71579) owns CtrlProxy forwarding for emulator-5554.",
      71579,
    );

    const connected = await client.ensureConnected(new NoOpPerformanceTracker());

    expect(connected).toBe(false);
    expect(client.getLastConnectionFailureMessage()).toContain("owns CtrlProxy forwarding");
    expect(client.isLastConnectionFailureForwardingLeaseConflict()).toBe(true);
  });

  test("does NOT tag an ordinary connect failure as the forwarding-lease conflict", async () => {
    const timer = new FakeTimer();
    client = new TestDeviceServiceClient(timer, createSuccessWebSocketFactory());
    client.disableAutoReconnect();
    client.setupError = new Error("connect ECONNREFUSED 127.0.0.1:5037");

    const connected = await client.ensureConnected(new NoOpPerformanceTracker());

    expect(connected).toBe(false);
    expect(client.getLastConnectionFailureMessage()).toContain("ECONNREFUSED");
    expect(client.isLastConnectionFailureForwardingLeaseConflict()).toBe(false);
  });

  test("clears the forwarding-lease-conflict tag once a later connect succeeds", async () => {
    const timer = new FakeTimer();
    client = new TestDeviceServiceClient(timer, createSuccessWebSocketFactory());
    client.disableAutoReconnect();
    client.setupError = new CtrlProxyForwardingLeaseConflictError(
      "Another AutoMobile process owns CtrlProxy forwarding for emulator-5554.",
      undefined,
    );
    expect(await client.ensureConnected(new NoOpPerformanceTracker())).toBe(false);
    expect(client.isLastConnectionFailureForwardingLeaseConflict()).toBe(true);

    client.setupError = null;
    expect(await client.ensureConnected(new NoOpPerformanceTracker())).toBe(true);

    expect(client.getLastConnectionFailureMessage()).toBeUndefined();
    expect(client.isLastConnectionFailureForwardingLeaseConflict()).toBe(false);
  });
});
