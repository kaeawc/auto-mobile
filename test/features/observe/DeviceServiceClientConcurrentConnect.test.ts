import { afterEach, describe, expect, test } from "bun:test";
import type WebSocket from "ws";
import { DeviceServiceClient } from "../../../src/features/observe/DeviceServiceClient";
import type { PerformanceTracker } from "../../../src/utils/PerformanceTracker";
import { NoOpPerformanceTracker } from "../../../src/utils/PerformanceTracker";
import { FakeTimer } from "../../fakes/FakeTimer";
import { FakeWebSocket } from "../../fakes/FakeWebSocket";

class TestDeviceServiceClient extends DeviceServiceClient {
  protected readonly logTag = "TestConcurrentConnectClient";
  private readonly setup: (signal: AbortSignal) => Promise<void>;

  constructor(
    timer: FakeTimer,
    wsFactory: (url: string) => WebSocket,
    setup: (signal: AbortSignal) => Promise<void> = async () => {},
    config: { connectionTimeoutMs?: number } = {},
  ) {
    super(timer, wsFactory, config);
    this.setup = setup;
    this.autoReconnectEnabled = false;
  }

  protected getWebSocketUrl(): string {
    return "ws://localhost:9999/ws";
  }

  protected handleMessage(_data: WebSocket.Data): void {}

  protected onConnectionEstablished(): void {}

  protected onConnectionClosed(): void {}

  protected async setupBeforeConnect(
    _perf: PerformanceTracker,
    signal: AbortSignal,
  ): Promise<void> {
    await this.setup(signal);
  }
}

async function settleMicrotasks(turns = 12): Promise<void> {
  for (let turn = 0; turn < turns; turn++) {
    await Promise.resolve();
  }
}

describe("DeviceServiceClient concurrent connect", () => {
  let client: TestDeviceServiceClient | null = null;

  afterEach(async () => {
    if (client) {
      await client.close();
      client = null;
    }
  });

  test("concurrent callers share one connection attempt", async () => {
    const timer = new FakeTimer();
    let socketCount = 0;
    client = new TestDeviceServiceClient(timer, (url) => {
      socketCount++;
      return new FakeWebSocket(url, "none", 0, timer);
    });

    const first = client.ensureConnected(new NoOpPerformanceTracker());
    const second = client.ensureConnected(new NoOpPerformanceTracker());

    expect(await Promise.all([first, second])).toEqual([true, true]);
    expect(socketCount).toBe(1);
  });

  test("a failed attempt is cleared so a later caller can retry", async () => {
    const timer = new FakeTimer();
    let socketCount = 0;
    client = new TestDeviceServiceClient(timer, (url) => {
      socketCount++;
      return new FakeWebSocket(url, socketCount === 1 ? "instant" : "none", 0, timer);
    });

    expect(await client.ensureConnected(new NoOpPerformanceTracker())).toBe(false);
    expect(await client.ensureConnected(new NoOpPerformanceTracker())).toBe(true);
    expect(socketCount).toBe(2);
  });

  test("a hung connect times out every concurrent waiter", async () => {
    const timer = new FakeTimer();
    let setupStarted = false;
    client = new TestDeviceServiceClient(
      timer,
      (url) => new FakeWebSocket(url, "none", 0, timer),
      (signal) =>
        new Promise<void>((_resolve, reject) => {
          setupStarted = true;
          signal.addEventListener("abort", () => reject(new Error("setup timed out")), {
            once: true,
          });
        }),
      { connectionTimeoutMs: 25 },
    );

    const first = client.ensureConnected(new NoOpPerformanceTracker());
    const second = client.ensureConnected(new NoOpPerformanceTracker());
    await settleMicrotasks();
    expect(setupStarted).toBe(true);

    timer.advanceTime(25);
    expect(await Promise.all([first, second])).toEqual([false, false]);
  });
});
