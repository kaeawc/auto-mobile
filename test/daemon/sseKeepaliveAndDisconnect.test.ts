import { describe, expect, test } from "bun:test";
import { evaluateDeviceDisconnects } from "../../src/daemon/disconnectMonitor";
import { FakeTimer } from "../fakes/FakeTimer";


const SSE_KEEPALIVE_INTERVAL_MS = 30_000;
const DEVICE_DISCONNECT_POLL_INTERVAL_MS = 5000;
const DEVICE_DISCONNECT_MISS_THRESHOLD = 3;


class FakeResponse {
  headersSent = true;
  writableEnded = false;
  destroyed = false;
  written: string[] = [];
  listeners: Map<string, Array<() => void>> = new Map();

  write(data: string): void {
    this.written.push(data);
  }

  on(event: string, callback: () => void): void {
    if (!this.listeners.has(event)) {
      this.listeners.set(event, []);
    }
    this.listeners.get(event)!.push(callback);
  }

  emit(event: string): void {
    for (const cb of this.listeners.get(event) ?? []) {
      cb();
    }
  }
}


describe("SSE keepalive timer", () => {

  test("writes keepalive comment every interval while response is writable", () => {
    const timer = new FakeTimer();
    const res = new FakeResponse();

    timer.setInterval(() => {
      if (res.headersSent && !res.writableEnded && !res.destroyed) {
        res.write(":keepalive\n\n");
      }
    }, SSE_KEEPALIVE_INTERVAL_MS);

    timer.advanceTime(SSE_KEEPALIVE_INTERVAL_MS);
    expect(res.written).toEqual([":keepalive\n\n"]);

    timer.advanceTime(SSE_KEEPALIVE_INTERVAL_MS);
    expect(res.written).toEqual([":keepalive\n\n", ":keepalive\n\n"]);
  });

  test("does not write keepalive before headers are sent", () => {
    const timer = new FakeTimer();
    const res = new FakeResponse();
    res.headersSent = false;

    timer.setInterval(() => {
      if (res.headersSent && !res.writableEnded && !res.destroyed) {
        res.write(":keepalive\n\n");
      }
    }, SSE_KEEPALIVE_INTERVAL_MS);

    timer.advanceTime(SSE_KEEPALIVE_INTERVAL_MS);
    expect(res.written).toEqual([]);
  });

  test("does not write keepalive after response ends", () => {
    const timer = new FakeTimer();
    const res = new FakeResponse();

    timer.setInterval(() => {
      if (res.headersSent && !res.writableEnded && !res.destroyed) {
        res.write(":keepalive\n\n");
      }
    }, SSE_KEEPALIVE_INTERVAL_MS);

    timer.advanceTime(SSE_KEEPALIVE_INTERVAL_MS);
    expect(res.written.length).toBe(1);

    res.writableEnded = true;
    timer.advanceTime(SSE_KEEPALIVE_INTERVAL_MS);
    expect(res.written.length).toBe(1);
  });

  test("does not write keepalive after response is destroyed", () => {
    const timer = new FakeTimer();
    const res = new FakeResponse();

    timer.setInterval(() => {
      if (res.headersSent && !res.writableEnded && !res.destroyed) {
        res.write(":keepalive\n\n");
      }
    }, SSE_KEEPALIVE_INTERVAL_MS);

    timer.advanceTime(SSE_KEEPALIVE_INTERVAL_MS);
    expect(res.written.length).toBe(1);

    res.destroyed = true;
    timer.advanceTime(SSE_KEEPALIVE_INTERVAL_MS);
    expect(res.written.length).toBe(1);
  });

  test("clearKeepalive stops the interval", () => {
    const timer = new FakeTimer();
    const res = new FakeResponse();

    const keepaliveTimer = timer.setInterval(() => {
      if (res.headersSent && !res.writableEnded && !res.destroyed) {
        res.write(":keepalive\n\n");
      }
    }, SSE_KEEPALIVE_INTERVAL_MS);

    const clearKeepalive = () => timer.clearInterval(keepaliveTimer);
    res.on("close", clearKeepalive);

    timer.advanceTime(SSE_KEEPALIVE_INTERVAL_MS);
    expect(res.written.length).toBe(1);

    res.emit("close");
    timer.advanceTime(SSE_KEEPALIVE_INTERVAL_MS);
    expect(res.written.length).toBe(1);
  });
});


describe("disconnect monitor miss counting", () => {

  const runDisconnectPoll = (
    deviceDisconnectMisses: Map<string, number>,
    bootedDeviceIds: Set<string>,
    candidateDeviceIds: Set<string>,
    succeededPlatforms: Set<string> = new Set(),
    candidatePlatforms: Map<string, string> = new Map(),
    candidateIncarnations: Map<string, number> = new Map(),
    deviceDisconnectMissIncarnations: Map<string, number> = new Map(),
  ): { disconnected: string[]; skippedAllDiscoveryFailed: boolean } => {
    return evaluateDeviceDisconnects({
      deviceDisconnectMisses,
      confirmedDisconnectedDeviceIds: new Set(),
      bootedDeviceIds,
      candidateDeviceIds,
      succeededPlatforms: succeededPlatforms as Set<"android" | "ios">,
      candidatePlatforms: candidatePlatforms as Map<string, "android" | "ios">,
      candidateIncarnations,
      deviceDisconnectMissIncarnations,
      missThreshold: DEVICE_DISCONNECT_MISS_THRESHOLD,
    });
  };

  test("resets miss count when device appears in booted list", () => {
    const misses = new Map<string, number>();
    misses.set("device-1", 2);

    runDisconnectPoll(misses, new Set(["device-1"]), new Set(["device-1"]));
    expect(misses.has("device-1")).toBe(false);
  });

  test("increments miss count when device is absent", () => {
    const misses = new Map<string, number>();

    runDisconnectPoll(misses, new Set(), new Set(["device-1"]));
    // No platform discovery succeeded, so retain the tracked device.
    expect(misses.has("device-1")).toBe(false);

    // Simulate ADB returning some devices but not ours
    runDisconnectPoll(misses, new Set(["other"]), new Set(["device-1"]));
    expect(misses.get("device-1")).toBe(1);

    runDisconnectPoll(misses, new Set(["other"]), new Set(["device-1"]));
    expect(misses.get("device-1")).toBe(2);
  });

  test("reports disconnect after threshold consecutive misses", () => {
    const misses = new Map<string, number>();

    for (let i = 1; i < DEVICE_DISCONNECT_MISS_THRESHOLD; i++) {
      const result = runDisconnectPoll(misses, new Set(["other"]), new Set(["device-1"]));
      expect(result.disconnected).toEqual([]);
    }

    const result = runDisconnectPoll(misses, new Set(["other"]), new Set(["device-1"]));
    expect(result.disconnected).toEqual(["device-1"]);
  });

  test("miss-counts an Android candidate when Android discovery succeeds empty", () => {
    const misses = new Map<string, number>();

    const result = runDisconnectPoll(
      misses,
      new Set(),
      new Set(["device-1"]),
      new Set(["android"]),
      new Map([["device-1", "android"]]),
    );

    expect(result.skippedAllDiscoveryFailed).toBe(false);
    expect(result.disconnected).toEqual([]);
    expect(misses.get("device-1")).toBe(1);
  });

  test("miss-counts an iOS candidate when iOS discovery succeeds empty", () => {
    const misses = new Map<string, number>();

    const result = runDisconnectPoll(
      misses,
      new Set(),
      new Set(["sim-1"]),
      new Set(["ios"]),
      new Map([["sim-1", "ios"]]),
    );

    expect(result.skippedAllDiscoveryFailed).toBe(false);
    expect(result.disconnected).toEqual([]);
    expect(misses.get("sim-1")).toBe(1);
  });

  test("retains candidates without misses when all platform discovery fails", () => {
    const misses = new Map<string, number>([["device-1", 2]]);

    const result = runDisconnectPoll(
      misses,
      new Set(),
      new Set(["device-1"]),
      new Set(),
      new Map([["device-1", "android"]]),
    );

    expect(result.skippedAllDiscoveryFailed).toBe(true);
    expect(result.disconnected).toEqual([]);
    expect(misses.get("device-1")).toBe(2);
  });

  test("miss-counts only candidates whose platform discovery succeeds", () => {
    const misses = new Map<string, number>();

    const result = runDisconnectPoll(
      misses,
      new Set(),
      new Set(["device-1", "sim-1"]),
      new Set(["android"]),
      new Map([
        ["device-1", "android"],
        ["sim-1", "ios"],
      ]),
    );

    expect(result.skippedAllDiscoveryFailed).toBe(false);
    expect(result.disconnected).toEqual([]);
    expect(misses.get("device-1")).toBe(1);
    expect(misses.has("sim-1")).toBe(false);
  });

  test("forced missing devices bypass the all-discovery-failed guard", () => {
    const result = evaluateDeviceDisconnects({
      deviceDisconnectMisses: new Map(),
      confirmedDisconnectedDeviceIds: new Set(),
      forceDisconnectedDeviceIds: new Set(["emulator-5554"]),
      bootedDeviceIds: new Set(),
      candidateDeviceIds: new Set(["emulator-5554"]),
      succeededPlatforms: new Set(["android" as const]),
      candidatePlatforms: new Map([["emulator-5554", "android" as const]]),
      missThreshold: DEVICE_DISCONNECT_MISS_THRESHOLD,
    });

    expect(result.skippedAllDiscoveryFailed).toBe(false);
    expect(result.disconnected).toEqual(["emulator-5554"]);
  });

  test("fresh booted scan clears a stale forced missing flag", () => {
    const forceDisconnectedDeviceIds = new Set(["emulator-5554"]);
    const result = evaluateDeviceDisconnects({
      deviceDisconnectMisses: new Map(),
      confirmedDisconnectedDeviceIds: new Set(),
      forceDisconnectedDeviceIds,
      bootedDeviceIds: new Set(["emulator-5554"]),
      candidateDeviceIds: new Set(["emulator-5554"]),
      succeededPlatforms: new Set(["android" as const]),
      candidatePlatforms: new Map([["emulator-5554", "android" as const]]),
      missThreshold: DEVICE_DISCONNECT_MISS_THRESHOLD,
    });

    expect(result.skippedAllDiscoveryFailed).toBe(false);
    expect(result.disconnected).toEqual([]);
    expect(forceDisconnectedDeviceIds.has("emulator-5554")).toBe(false);
  });

  test("skips candidates from platforms whose discovery did not succeed", () => {
    const misses = new Map<string, number>();
    misses.set("sim-1", 2);

    // Android discovery succeeded; iOS discovery did not, so the iOS
    // simulator must not be miss-counted toward disconnect.
    const result = runDisconnectPoll(
      misses,
      new Set(["emulator-5554"]),
      new Set(["sim-1"]),
      new Set(["android"]),
      new Map([["sim-1", "ios"]]),
    );

    expect(result.skippedAllDiscoveryFailed).toBe(false);
    expect(result.disconnected).toEqual([]);
    expect(misses.has("sim-1")).toBe(false);
  });

  test("miss-counts a device once its platform discovery succeeds", () => {
    const misses = new Map<string, number>();

    // iOS discovery succeeded but reported zero simulators, so an iOS
    // device that is genuinely gone should now be miss-counted.
    const result = runDisconnectPoll(
      misses,
      new Set(["emulator-5554"]),
      new Set(["sim-1"]),
      new Set(["android", "ios"]),
      new Map([["sim-1", "ios"]]),
    );

    expect(result.skippedAllDiscoveryFailed).toBe(false);
    expect(misses.get("sim-1")).toBe(1);
  });

  test("miss count resets after device reappears then starts over", () => {
    const misses = new Map<string, number>();

    runDisconnectPoll(misses, new Set(["other"]), new Set(["device-1"]));
    runDisconnectPoll(misses, new Set(["other"]), new Set(["device-1"]));
    expect(misses.get("device-1")).toBe(2);

    runDisconnectPoll(misses, new Set(["device-1"]), new Set(["device-1"]));
    expect(misses.has("device-1")).toBe(false);

    runDisconnectPoll(misses, new Set(["other"]), new Set(["device-1"]));
    expect(misses.get("device-1")).toBe(1);
  });

  test("does not carry misses from a replaced device incarnation", () => {
    const misses = new Map<string, number>([["sim-1", 2]]);
    const candidateIncarnations = new Map<string, number>([["sim-1", 2]]);
    const deviceDisconnectMissIncarnations = new Map<string, number>([["sim-1", 1]]);

    const result = runDisconnectPoll(
      misses,
      new Set(["emulator-5554"]),
      new Set(["sim-1"]),
      new Set(["android", "ios"]),
      new Map([["sim-1", "ios"]]),
      candidateIncarnations,
      deviceDisconnectMissIncarnations,
    );

    expect(result.disconnected).toEqual([]);
    expect(misses.get("sim-1")).toBe(1);
    expect(deviceDisconnectMissIncarnations.get("sim-1")).toBe(2);
  });

  test("keeps returning a threshold-missed stale candidate until caller settles cleanup", () => {
    const misses = new Map<string, number>();
    const confirmedDisconnectedDeviceIds = new Set<string>();
    const input = {
      deviceDisconnectMisses: misses,
      confirmedDisconnectedDeviceIds,
      bootedDeviceIds: new Set(["other"]),
      candidateDeviceIds: new Set(["device-1"]),
      succeededPlatforms: new Set(["android" as const, "ios" as const]),
      candidatePlatforms: new Map([["device-1", "android" as const]]),
      missThreshold: DEVICE_DISCONNECT_MISS_THRESHOLD,
    };

    expect(evaluateDeviceDisconnects(input).disconnected).toEqual([]);
    expect(evaluateDeviceDisconnects(input).disconnected).toEqual([]);
    expect(evaluateDeviceDisconnects(input).disconnected).toEqual(["device-1"]);
    expect(confirmedDisconnectedDeviceIds.has("device-1")).toBe(false);
    expect(misses.get("device-1")).toBe(DEVICE_DISCONNECT_MISS_THRESHOLD);

    expect(evaluateDeviceDisconnects(input).disconnected).toEqual(["device-1"]);
    expect(misses.get("device-1")).toBe(DEVICE_DISCONNECT_MISS_THRESHOLD);

    confirmedDisconnectedDeviceIds.add("device-1");

    expect(evaluateDeviceDisconnects(input).disconnected).toEqual([]);
    expect(misses.has("device-1")).toBe(false);
  });

  test("clears settled disconnect state when the device reappears", () => {
    const confirmedDisconnectedDeviceIds = new Set(["device-1"]);
    const misses = new Map<string, number>();

    evaluateDeviceDisconnects({
      deviceDisconnectMisses: misses,
      confirmedDisconnectedDeviceIds,
      bootedDeviceIds: new Set(["device-1"]),
      candidateDeviceIds: new Set(["device-1"]),
      succeededPlatforms: new Set(["android" as const]),
      candidatePlatforms: new Map([["device-1", "android" as const]]),
      missThreshold: DEVICE_DISCONNECT_MISS_THRESHOLD,
    });

    expect(confirmedDisconnectedDeviceIds.has("device-1")).toBe(false);
  });

  test("fires at poll interval using FakeTimer", () => {
    const timer = new FakeTimer();
    let pollCount = 0;

    timer.setInterval(() => {
      pollCount++;
    }, DEVICE_DISCONNECT_POLL_INTERVAL_MS);

    expect(pollCount).toBe(0);

    timer.advanceTime(DEVICE_DISCONNECT_POLL_INTERVAL_MS);
    expect(pollCount).toBe(1);

    timer.advanceTime(DEVICE_DISCONNECT_POLL_INTERVAL_MS);
    expect(pollCount).toBe(2);

    timer.advanceTime(DEVICE_DISCONNECT_POLL_INTERVAL_MS);
    expect(pollCount).toBe(3);
  });
});
