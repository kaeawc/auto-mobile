import { beforeEach, describe, expect, test } from "bun:test";
import {
  DeviceForwardLeaseIdleReleaser,
  type DeviceForwardLeaseIdlePort,
} from "../../src/daemon/deviceForwardLeaseIdleReleaser";
import { FakeTimer } from "../fakes/FakeTimer";

const IDLE_MS = 60_000;

class FakeLeasePort implements DeviceForwardLeaseIdlePort {
  held = new Set<string>();
  sessions = new Map<string, string>();
  active = new Map<string, number>();
  streaming = new Set<string>();
  idle = new Map<string, number | null>();
  released: string[] = [];

  heldDeviceIds(): string[] {
    return [...this.held];
  }
  sessionForDevice(deviceId: string): string | null {
    return this.sessions.get(deviceId) ?? null;
  }
  activeExecutionCount(deviceId: string): number {
    return this.active.get(deviceId) ?? 0;
  }
  hasStreamSubscriber(deviceId: string): boolean {
    return this.streaming.has(deviceId);
  }
  idleForMs(deviceId: string): number | null {
    return this.idle.get(deviceId) ?? null;
  }
  async release(deviceId: string): Promise<void> {
    this.released.push(deviceId);
    this.held.delete(deviceId);
  }
}

describe("DeviceForwardLeaseIdleReleaser (#10497)", () => {
  let timer: FakeTimer;
  let port: FakeLeasePort;
  let releaser: DeviceForwardLeaseIdleReleaser;

  beforeEach(() => {
    timer = new FakeTimer();
    timer.setCurrentTime(0);
    port = new FakeLeasePort();
    releaser = new DeviceForwardLeaseIdleReleaser(port, IDLE_MS, timer);
    port.held.add("emulator-5600");
  });

  test("releases an idle owner's lease after the idle period", async () => {
    expect(await releaser.sweep()).toEqual([]);
    timer.setCurrentTime(IDLE_MS - 1);
    expect(await releaser.sweep()).toEqual([]);
    timer.setCurrentTime(IDLE_MS);
    expect(await releaser.sweep()).toEqual(["emulator-5600"]);
    expect(port.released).toEqual(["emulator-5600"]);
  });

  test("keeps the lease while a session, tool call, or stream subscriber uses the device", async () => {
    await releaser.sweep();
    for (const busy of [
      () => port.sessions.set("emulator-5600", "session-1"),
      () => port.active.set("emulator-5600", 1),
      () => port.streaming.add("emulator-5600"),
    ]) {
      busy();
      timer.advanceTime(IDLE_MS * 2);
      expect(await releaser.sweep()).toEqual([]);
      port.sessions.clear();
      port.active.clear();
      port.streaming.clear();
    }
    // The idle clock restarts from the last busy sweep, not from first sight.
    timer.advanceTime(IDLE_MS - 1);
    expect(await releaser.sweep()).toEqual([]);
    timer.advanceTime(1);
    expect(await releaser.sweep()).toEqual(["emulator-5600"]);
  });

  test("recent tool activity defers release even without a busy sweep", async () => {
    await releaser.sweep();
    timer.setCurrentTime(IDLE_MS * 2);
    port.idle.set("emulator-5600", 1_000);
    expect(await releaser.sweep()).toEqual([]);
    port.idle.set("emulator-5600", IDLE_MS);
    expect(await releaser.sweep()).toEqual(["emulator-5600"]);
  });

  test("runs on the injected timer once started", async () => {
    releaser.start();
    try {
      await timer.advanceTimeAsync(IDLE_MS + 15_000);
      expect(port.released).toEqual(["emulator-5600"]);
    } finally {
      await releaser.stop();
    }
  });
});
