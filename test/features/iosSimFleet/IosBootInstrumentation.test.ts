import { describe, expect, test } from "bun:test";
import { InMemoryBootDurationHistory } from "../../../src/features/iosSimFleet/BootDurationHistory";
import {
  FleetBootInstrumentation,
  IOS_SIM_CAPACITY_GATE_ENV,
  bootProfileId,
} from "../../../src/features/iosSimFleet/IosBootInstrumentation";
import { createDefaultIosBootInstrumentation } from "../../../src/features/iosSimFleet/defaultIosBootInstrumentation";
import type { CapacityDecision } from "../../../src/features/iosSimFleet/CapacityGate";
import { deviceResourceProfileFingerprint } from "../../../src/utils/deviceResourceDrift";
import { FakeHostCommandExecutor } from "../../fakes/FakeHostCommandExecutor";
import { FakeSimCtlClient } from "../../fakes/FakeSimCtlClient";
import { FakeSimulatorCapacityGate } from "../../fakes/FakeSimulatorCapacityGate";
import { FakeTimer } from "../../fakes/FakeTimer";

const UDID = "BCC31307-1A19-4D67-A7F0-44FC98F78921";
const limits = { maxBooted: 1, source: "derived" } as const;
const queue: CapacityDecision = {
  outcome: "queue",
  reason: "at-capacity",
  limits,
  bootedCount: 1,
  retryAfterMs: 5_000,
  message: "1 simulator(s) booted; limit is 1",
};

function setup(gateDecision?: CapacityDecision, timesOut = false) {
  const timer = new FakeTimer();
  const history = new InMemoryBootDurationHistory();
  const gate = gateDecision
    ? new FakeSimulatorCapacityGate(timer, gateDecision, timesOut)
    : undefined;
  const instrumentation = new FleetBootInstrumentation({ history, timer, gate });
  return { timer, history, gate, instrumentation };
}

describe("FleetBootInstrumentation", () => {
  test("records the boot duration under the requested profile fingerprint", async () => {
    const { timer, history, instrumentation } = setup();
    const profile = { resources: { location: "disabled" as const } };
    await instrumentation.run({ udid: UDID, profile, timeoutMs: 60_000 }, async () => {
      timer.advanceTime(4_200);
    });
    const profileId = deviceResourceProfileFingerprint(profile);
    expect(history.latestFor(UDID)).toMatchObject({ profileId, durationMs: 4_200 });
    expect(history.recentForProfile(profileId)).toHaveLength(1);
  });

  test("a boot with no profile shares the empty-profile identity and keeps the full budget", async () => {
    const { history, instrumentation } = setup();
    let budget = 0;
    await instrumentation.run({ udid: UDID, timeoutMs: 60_000 }, async (remainingMs) => {
      budget = remainingMs;
    });
    expect(budget).toBe(60_000);
    expect(history.latestFor(UDID)?.profileId).toBe(bootProfileId());
  });

  test("a failed boot records nothing and rethrows", async () => {
    const { history, instrumentation } = setup();
    await expect(
      instrumentation.run({ udid: UDID, timeoutMs: 1_000 }, async () => {
        throw new Error("boot failed");
      }),
    ).rejects.toThrow("boot failed");
    expect(history.latestFor(UDID)).toBeUndefined();
  });

  test("time queued for capacity is deducted from the boot budget", async () => {
    const { gate, history, instrumentation } = setup({ outcome: "allow", limits, bootedCount: 0 });
    gate!.queuedWaitMs = 10_000;
    let budget = 0;
    await instrumentation.run({ udid: UDID, timeoutMs: 60_000 }, async (remainingMs) => {
      budget = remainingMs;
    });
    expect(budget).toBe(50_000);
    expect(history.latestFor(UDID)?.durationMs).toBe(0);
    expect(gate!.requests[0]).toMatchObject({ profileId: bootProfileId(), excludeUdids: [UDID] });
  });

  test("a wait that times out at capacity throws without booting", async () => {
    const { instrumentation } = setup(queue, true);
    let booted = false;
    await expect(
      instrumentation.run({ udid: UDID, timeoutMs: 1_000 }, async () => {
        booted = true;
      }),
    ).rejects.toThrow(/waiting for simulator capacity/);
    expect(booted).toBe(false);
  });

  test("a compatible warm simulator does not block the requested boot", async () => {
    const { instrumentation } = setup({ outcome: "reuse-warm", udid: "OTHER" });
    let booted = false;
    await instrumentation.run({ udid: UDID, timeoutMs: 1_000 }, async () => {
      booted = true;
    });
    expect(booted).toBe(true);
  });
});

describe("createDefaultIosBootInstrumentation", () => {
  test("never consults the host without the capacity-gate env flag", async () => {
    const simctl = new FakeSimCtlClient();
    const instrumentation = createDefaultIosBootInstrumentation({
      simctl,
      timer: new FakeTimer(),
      env: {},
    });
    await instrumentation.run({ udid: UDID, timeoutMs: 1_000 }, async () => undefined);
    expect(simctl.getMethodCalls("executeCommandArgs")).toEqual([]);
  });

  test("the env flag arms the gate, reading the inventory through the injected simctl", async () => {
    const simctl = new FakeSimCtlClient();
    simctl.setCommandArgsResult(["list", "devices", "--json"], '{"devices":{}}');
    const instrumentation = createDefaultIosBootInstrumentation({
      simctl,
      timer: new FakeTimer(),
      env: { [IOS_SIM_CAPACITY_GATE_ENV]: "1" },
      executor: new FakeHostCommandExecutor(),
    });
    // An unreadable host snapshot is non-fatal for an empty fleet.
    await instrumentation.run({ udid: UDID, timeoutMs: 1_000 }, async () => undefined);
    expect(simctl.getMethodCalls("executeCommandArgs").length).toBeGreaterThan(0);
  });
});
