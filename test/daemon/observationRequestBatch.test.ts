import { describe, expect, test } from "bun:test";
import { DEFAULT_OBSERVATION_REQUEST_TIMEOUT_MS } from "../../src/daemon/deviceDataStreamSocketServer";
import {
  createPooledObservationExecutor,
  runObservationRequestBatch,
} from "../../src/daemon/observationRequestBatch";
import type { ObserveResult } from "../../src/models";
import { FakeTimer } from "../fakes/FakeTimer";
import { CountingIdGenerator } from "../../src/utils/IdGenerator";

function successfulObservation(): ObserveResult {
  return {
    observationId: "successful-observation",
    updatedAt: 0,
    screenSize: { width: 1, height: 1 },
    systemInsets: { top: 0, right: 0, bottom: 0, left: 0 },
  };
}

describe("runObservationRequestBatch", () => {
  test("times out one stalled device while observing its siblings concurrently", async () => {
    const timer = new FakeTimer();
    const started: string[] = [];
    const signals = new Map<string, AbortSignal>();

    const batch = runObservationRequestBatch(
      [{ id: "slow" }, { id: "healthy-one" }, { id: "healthy-two" }],
      async (device, signal) => {
        started.push(device.id);
        signals.set(device.id, signal);
        if (device.id === "slow") {
          return new Promise<ObserveResult>(() => undefined);
        }
        return successfulObservation();
      },
      {
        timer,
        signal: new AbortController().signal,
        perDeviceTimeoutMs: DEFAULT_OBSERVATION_REQUEST_TIMEOUT_MS,
        idGenerator: new CountingIdGenerator("batch"),
      },
    );

    await Promise.resolve();
    expect(started).toEqual(["slow", "healthy-one", "healthy-two"]);

    await timer.advanceTimeAsync(DEFAULT_OBSERVATION_REQUEST_TIMEOUT_MS);

    const observations = await batch;

    expect(observations.map(({ deviceId }) => deviceId)).toEqual([
      "slow",
      "healthy-one",
      "healthy-two",
    ]);
    expect(observations[0]?.observation.viewHierarchy).toBeUndefined();
    expect(observations[0]?.observation.error).toBe(
      `Observation request timed out after ${DEFAULT_OBSERVATION_REQUEST_TIMEOUT_MS}ms for device slow`,
    );
    expect(signals.get("slow")?.aborted).toBe(true);
    expect(signals.get("healthy-one")?.aborted).toBe(false);
    expect(signals.get("healthy-two")?.aborted).toBe(false);
    expect(observations.slice(1)).toEqual([
      { deviceId: "healthy-one", observation: successfulObservation() },
      { deviceId: "healthy-two", observation: successfulObservation() },
    ]);
  });

  test("keeps an iOS observation that completes within the full request budget", async () => {
    const timer = new FakeTimer();
    const signals = new Map<string, AbortSignal>();

    const batch = runObservationRequestBatch(
      [
        { id: "ios-nearly-complete", platform: "ios" },
        { id: "stalled-sibling", platform: "android" },
      ],
      async (device, signal) => {
        signals.set(device.id, signal);
        await timer.sleep(device.platform === "ios" ? 18_000 : 25_000);
        return successfulObservation();
      },
      {
        timer,
        signal: new AbortController().signal,
        idGenerator: new CountingIdGenerator("batch"),
      },
    );

    await timer.advanceTimeAsync(18_000);
    await timer.advanceTimeAsync(DEFAULT_OBSERVATION_REQUEST_TIMEOUT_MS - 18_000);

    const observations = await batch;

    expect(observations).toEqual([
      { deviceId: "ios-nearly-complete", observation: successfulObservation() },
      {
        deviceId: "stalled-sibling",
        observation: {
          observationId: "failed_observation_20000_batch-1",
          display: { generation: 0, key: "0", posture: "unknown", role: "unknown" },
          updatedAt: DEFAULT_OBSERVATION_REQUEST_TIMEOUT_MS,
          screenSize: { width: 0, height: 0 },
          systemInsets: { top: 0, right: 0, bottom: 0, left: 0 },
          error: `Observation request timed out after ${DEFAULT_OBSERVATION_REQUEST_TIMEOUT_MS}ms for device stalled-sibling`,
        },
      },
    ]);
    expect(signals.get("ios-nearly-complete")?.aborted).toBe(false);
    expect(signals.get("stalled-sibling")?.aborted).toBe(true);
  });

  test("returns an actionable failure without observing a quarantined device", async () => {
    const timer = new FakeTimer();
    const executed: string[] = [];

    const observations = await runObservationRequestBatch(
      [{ id: "quarantined" }, { id: "healthy" }],
      async (device) => {
        executed.push(device.id);
        return successfulObservation();
      },
      {
        timer,
        signal: new AbortController().signal,
        assertDeviceActionable: (device) => {
          if (device.id === "quarantined") {
            throw new Error("Device quarantined is not actionable to observe");
          }
        },
        idGenerator: new CountingIdGenerator("batch"),
      },
    );

    expect(executed).toEqual(["healthy"]);
    expect(observations[0]?.observation.error).toBe(
      "Device quarantined is not actionable to observe",
    );
    expect(observations[1]).toEqual({ deviceId: "healthy", observation: successfulObservation() });
  });
});

describe("pooled observation floor clock domain (issue #9895)", () => {
  const HOST_NOW_MS = 1_000_000;
  const STALE_CAPTURE_AGE_MS = 3_000;

  interface PooledTestDevice {
    id: string;
    platform: "android" | "ios";
  }

  /**
   * Models the Android hierarchy source: a capture stamped by the DEVICE clock is
   * rejected when it is older than the caller's floor, exactly as
   * `CtrlProxyHierarchy.satisfiesMinTimestamp` does. `captureAgeMs` is how old the
   * capture is in the device's own domain; 0 is a capture taken right now.
   */
  function setup(options: { skewMs: number; captureAgeMs?: number; devices: PooledTestDevice[] }) {
    const timer = new FakeTimer();
    timer.advanceTime(HOST_NOW_MS);
    const deviceNowMs = HOST_NOW_MS + options.skewMs;
    const clockReads: string[] = [];
    const observeCalls: { id: string; minTimestamp: number }[] = [];
    const executor = createPooledObservationExecutor<PooledTestDevice>({
      hostRequestStartMs: timer.now(),
      readAndroidDeviceClockMs: async (device) => {
        clockReads.push(device.id);
        return deviceNowMs;
      },
      observe: async (device, { minTimestamp }): Promise<ObserveResult> => {
        observeCalls.push({ id: device.id, minTimestamp });
        // iOS shares the host clock; Android stamps with the device clock.
        const stamp =
          device.platform === "ios" ? HOST_NOW_MS : deviceNowMs - (options.captureAgeMs ?? 0);
        const stale = stamp < minTimestamp;
        return {
          ...successfulObservation(),
          observationId: device.id,
          updatedAt: stamp,
          ...(stale ? { error: `stale: ${stamp} < ${minTimestamp}` } : {}),
        };
      },
    });
    const run = () =>
      runObservationRequestBatch(options.devices, executor, {
        timer,
        signal: new AbortController().signal,
        idGenerator: new CountingIdGenerator("batch"),
      });
    return { run, clockReads, observeCalls };
  }

  const android: PooledTestDevice[] = [{ id: "emu", platform: "android" }];

  test("accepts the current capture on the first read when the device clock is 20 s behind", async () => {
    const { run, clockReads, observeCalls } = setup({ skewMs: -20_000, devices: android });

    const [result] = await run();

    expect(result?.observation.error).toBeUndefined();
    expect(observeCalls).toEqual([{ id: "emu", minTimestamp: HOST_NOW_MS - 20_000 }]);
    expect(clockReads).toEqual(["emu"]);
  });

  test("rejects a genuinely old capture when the device clock is 5 s ahead", async () => {
    const { run, observeCalls } = setup({
      skewMs: 5_000,
      captureAgeMs: STALE_CAPTURE_AGE_MS,
      devices: android,
    });

    const [result] = await run();

    expect(observeCalls).toEqual([{ id: "emu", minTimestamp: HOST_NOW_MS + 5_000 }]);
    expect(result?.observation.error).toContain("stale");
  });

  test("keeps the same floor and call counts with no skew", async () => {
    const { run, clockReads, observeCalls } = setup({ skewMs: 0, devices: android });

    const [result] = await run();

    expect(result?.observation.error).toBeUndefined();
    expect(observeCalls).toEqual([{ id: "emu", minTimestamp: HOST_NOW_MS }]);
    expect(clockReads).toHaveLength(1);
  });

  test("reads one device clock per Android device and leaves iOS on the host floor", async () => {
    const { run, clockReads, observeCalls } = setup({
      skewMs: -20_000,
      devices: [
        { id: "emu-a", platform: "android" },
        { id: "sim", platform: "ios" },
        { id: "emu-b", platform: "android" },
      ],
    });

    await run();

    expect(clockReads).toEqual(["emu-a", "emu-b"]);
    // Devices run concurrently, so completion order is not part of the contract.
    expect([...observeCalls].sort((a, b) => a.id.localeCompare(b.id))).toEqual([
      { id: "emu-a", minTimestamp: HOST_NOW_MS - 20_000 },
      { id: "emu-b", minTimestamp: HOST_NOW_MS - 20_000 },
      { id: "sim", minTimestamp: HOST_NOW_MS },
    ]);
  });

  test("does not observe when the clock read is aborted", async () => {
    const timer = new FakeTimer();
    const controller = new AbortController();
    const observeCalls: string[] = [];
    const executor = createPooledObservationExecutor<PooledTestDevice>({
      hostRequestStartMs: 0,
      readAndroidDeviceClockMs: async (_device, signal) => {
        controller.abort();
        signal.throwIfAborted();
        return 0;
      },
      observe: async (device) => {
        observeCalls.push(device.id);
        return successfulObservation();
      },
    });

    const [result] = await runObservationRequestBatch(android, executor, {
      timer,
      signal: controller.signal,
      idGenerator: new CountingIdGenerator("batch"),
    });

    expect(observeCalls).toEqual([]);
    expect(result?.observation.error).toBeDefined();
  });
});

describe("viewer read on a held device (#10967)", () => {
  interface Device {
    id: string;
    platform: "android" | "ios";
  }

  function setup(held: ReadonlySet<string>) {
    const calls: string[] = [];
    const executor = createPooledObservationExecutor<Device>({
      hostRequestStartMs: 0,
      readAndroidDeviceClockMs: async (device) => {
        calls.push(`clock:${device.id}`);
        return 0;
      },
      observe: async (device) => {
        calls.push(`session:${device.id}`);
        return successfulObservation();
      },
      viewerRead: {
        applies: (device) => held.has(device.id),
        observe: async (device) => {
          calls.push(`read:${device.id}`);
          return successfulObservation();
        },
      },
    });
    const run = (devices: Device[]) =>
      runObservationRequestBatch(devices, executor, {
        timer: new FakeTimer(),
        signal: new AbortController().signal,
        idGenerator: new CountingIdGenerator("batch"),
      });
    return { run, calls };
  }

  test("a held device gets only the connect-only read; a free one keeps the session pipeline", async () => {
    const { run, calls } = setup(new Set(["held-emu", "held-sim"]));

    await run([
      { id: "held-emu", platform: "android" },
      { id: "held-sim", platform: "ios" },
      { id: "free-emu", platform: "android" },
    ]);

    expect([...calls].sort()).toEqual([
      "clock:free-emu",
      "read:held-emu",
      "read:held-sim",
      "session:free-emu",
    ]);
  });
});
