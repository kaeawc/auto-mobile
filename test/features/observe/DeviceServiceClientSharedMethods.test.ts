import { describe, expect, test } from "bun:test";
import type { BootedDevice } from "../../../src/models";
import { DeviceServiceClient } from "../../../src/features/observe/DeviceServiceClient";
import { AndroidCtrlProxyClient } from "../../../src/features/observe/android/AndroidCtrlProxyClient";
import { IOSCtrlProxyClient } from "../../../src/features/observe/ios/IOSCtrlProxyClient";
import { FakeAdbExecutor } from "../../fakes/FakeAdbExecutor";
import { FakeIOSCtrlProxyManager } from "../../fakes/FakeIOSCtrlProxyManager";
import { FakeTimer } from "../../fakes/FakeTimer";
import { createInstantFailureWebSocketFactory } from "../../fakes/FakeWebSocket";

const device: BootedDevice = {
  deviceId: "shared-methods-test-device",
  platform: "android",
  name: "Shared methods test device",
};

function createClients(timer: FakeTimer) {
  const factory = createInstantFailureWebSocketFactory(timer);
  return [
    AndroidCtrlProxyClient.createForTesting(device, new FakeAdbExecutor(), {
      webSocketFactory: factory,
      timer,
    }),
    IOSCtrlProxyClient.createForTesting({ ...device, platform: "ios" }, 8765, factory, timer),
  ] as const;
}

/** Exercise the base failure funnel without entering either platform's recovery state machine. */
class FailureCountingClient extends DeviceServiceClient {
  protected readonly logTag = "FailureCountingClient";
  triggers = 0;
  countFailures = true;
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
  protected override shouldCountConnectionFailure(): boolean {
    return this.countFailures;
  }
  protected override onConnectionFailureThresholdReached(): void {
    this.triggers++;
  }
  fail(): void {
    this.onConnectAttemptFailed();
  }
  markClosed(): void {
    this.closed = true;
  }
  get failureCount(): number {
    return this.consecutiveConnectionFailures;
  }
}

describe("DeviceServiceClient shared methods", () => {
  test("handshake constants remain inherited and polling stops at the same deadline", async () => {
    const timer = new FakeTimer();
    timer.enableAutoAdvance();
    const clients = createClients(timer);
    try {
      expect(AndroidCtrlProxyClient["HANDSHAKE_WAIT_TIMEOUT_MS"]).toBe(2000);
      expect(AndroidCtrlProxyClient["HANDSHAKE_POLL_INTERVAL_MS"]).toBe(50);
      for (const client of clients) {
        const started = timer.now();
        await client.connectionTestHooks.waitForHandshake();
        expect(timer.now() - started).toBe(2000);
      }
      expect(timer.getSleepHistory()).toEqual(Array(80).fill(50));
    } finally {
      for (const client of clients) {
        await client.close();
      }
    }
  });

  test("both platforms cancel an in-flight handshake poll and clear its timer", async () => {
    const timer = new FakeTimer();
    const clients = createClients(timer);
    try {
      for (const client of clients) {
        const controller = new AbortController();
        const reason = new Error("cancel handshake");
        const pending = client.connectionTestHooks.waitForHandshake(undefined, controller.signal);
        expect(timer.getPendingTimeoutCount()).toBe(1);
        controller.abort(reason);
        await expect(pending).rejects.toBe(reason);
        expect(timer.getPendingTimeoutCount()).toBe(0);
      }
    } finally {
      for (const client of clients) {
        await client.close();
      }
    }
  });

  test("only iOS checks an already-aborted signal after the handshake has arrived", async () => {
    const timer = new FakeTimer();
    const [android, ios] = createClients(timer);
    try {
      android.connectionTestHooks.supportedCommands = new Set(["request_hierarchy"]);
      ios.connectionTestHooks.supportedCommands = new Set(["request_hierarchy"]);
      const controller = new AbortController();
      const reason = new Error("already cancelled");
      controller.abort(reason);
      await android["waitForHandshake"](undefined, controller.signal);
      await expect(ios["waitForHandshake"](undefined, controller.signal)).rejects.toBe(reason);
      expect(timer.getPendingTimeoutCount()).toBe(0);
    } finally {
      await android.close();
      await ios.close();
    }
  });

  test("iOS session changes leave the manager-owned exhausted restart budget intact", async () => {
    const timer = new FakeTimer();
    const manager = new FakeIOSCtrlProxyManager(timer);
    const budget = manager.getForcedRestartBudget();
    for (let attempt = 0; attempt < 3; attempt++) {
      budget.recordFailure("restart failed", budget.tryBeginAttempt()!);
      timer.advanceTime(600_000);
    }
    const exhausted = budget.snapshot();
    expect(exhausted.state).toBe("exhausted");
    const client = IOSCtrlProxyClient.createForTesting(
      { ...device, platform: "ios" },
      8765,
      createInstantFailureWebSocketFactory(timer),
      timer,
      { serviceManagerFactory: () => manager },
    );
    try {
      client.bindSession("shared-methods-session-a");
      client.bindSession("shared-methods-session-a");
      client.bindSession("shared-methods-session-b");
      expect(client.getBoundSessionId()).toBe("shared-methods-session-b");
      expect(budget.snapshot()).toEqual(exhausted);
    } finally {
      await client.close();
    }
  });

  test("failure funnel triggers every third counted failure and respects its guards", async () => {
    const client = new FailureCountingClient(new FakeTimer());
    try {
      client.countFailures = false;
      client.fail();
      client.countFailures = true;
      for (let attempt = 1; attempt <= 6; attempt++) {
        client.fail();
        expect(client.triggers).toBe(Math.floor(attempt / 3));
      }
      client.connectionTestHooks.autoReconnectEnabled = false;
      client.fail();
      client.connectionTestHooks.autoReconnectEnabled = true;
      client.markClosed();
      client.fail();
      expect(client.failureCount).toBe(6);
    } finally {
      await client.close();
    }
  });
});
