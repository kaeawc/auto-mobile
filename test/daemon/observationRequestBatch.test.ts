import { describe, expect, test } from "bun:test";
import { DEFAULT_OBSERVATION_REQUEST_TIMEOUT_MS } from "../../src/daemon/deviceDataStreamSocketServer";
import { runObservationRequestBatch } from "../../src/daemon/observationRequestBatch";
import type { ObserveResult } from "../../src/models";
import { FakeTimer } from "../fakes/FakeTimer";

function successfulObservation(): ObserveResult {
  return {
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
      },
    );

    expect(executed).toEqual(["healthy"]);
    expect(observations[0]?.observation.error).toBe(
      "Device quarantined is not actionable to observe",
    );
    expect(observations[1]).toEqual({ deviceId: "healthy", observation: successfulObservation() });
  });
});
