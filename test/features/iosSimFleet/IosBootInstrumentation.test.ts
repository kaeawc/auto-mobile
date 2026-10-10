import { describe, expect, test } from "bun:test";
import { InMemoryBootDurationHistory } from "../../../src/features/iosSimFleet/BootDurationHistory";
import {
  FleetBootInstrumentation,
  IOS_SIM_CAPACITY_GATE_ENV,
  bootProfileId,
} from "../../../src/features/iosSimFleet/IosBootInstrumentation";
import {
  createDefaultIosBootInstrumentation,
  createIosSimCapacityGate,
} from "../../../src/features/iosSimFleet/defaultIosBootInstrumentation";
import { BOOT_CAPACITY_GATE_ENV } from "../../../src/features/bootAdmission/BootAdmissionGate";
import { BootCapacityExhaustedError } from "../../../src/models/BootCapacityExhaustedError";
import type { CapacityDecision } from "../../../src/features/iosSimFleet/CapacityGate";
import { deviceResourceProfileFingerprint } from "../../../src/utils/deviceResourceDrift";
import { FakeHostCommandExecutor } from "../../fakes/FakeHostCommandExecutor";
import { FakeSimCtlClient } from "../../fakes/FakeSimCtlClient";
import { FakeSimulatorCapacityGate } from "../../fakes/FakeSimulatorCapacityGate";
import { FakeTimer } from "../../fakes/FakeTimer";

const UDID = "BCC31307-1A19-4D67-A7F0-44FC98F78921";
const limits = { maxBooted: 1, source: "derived" } as const;
const queue: CapacityDecision = {
  outcome: "refuse",
  reason: "at-capacity",
  limits,
  bootedCount: 1,
  retryAfterMs: 5_000,
  message: "1 simulator(s) booted; limit is 1",
};

function setup(gateDecision?: CapacityDecision) {
  const timer = new FakeTimer();
  const history = new InMemoryBootDurationHistory();
  const gate = gateDecision ? new FakeSimulatorCapacityGate(timer, gateDecision) : undefined;
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

  test("an admitted boot keeps the caller's full budget", async () => {
    const { gate, history, instrumentation } = setup({ outcome: "allow", limits, bootedCount: 0 });
    let budget = 0;
    await instrumentation.run({ udid: UDID, timeoutMs: 60_000 }, async (remainingMs) => {
      budget = remainingMs;
    });
    expect(budget).toBe(60_000);
    expect(history.latestFor(UDID)?.durationMs).toBe(0);
    expect(gate!.requests[0]).toMatchObject({ profileId: bootProfileId(), excludeUdids: [UDID] });
  });

  test("a boot at capacity is refused at once without booting", async () => {
    const { instrumentation } = setup(queue);
    let booted = false;
    await expect(
      instrumentation.run({ udid: UDID, timeoutMs: 1_000 }, async () => {
        booted = true;
      }),
    ).rejects.toThrow(BootCapacityExhaustedError);
    expect(booted).toBe(false);
  });

  // #11064: the boot path's signal reaches the capacity check, and an admitted
  // boot holds its slot only until the boot ends, success or failure.
  test("threads the boot signal into the capacity check and releases the admission after boot", async () => {
    const { gate, instrumentation } = setup({ outcome: "allow", limits, bootedCount: 0 });
    const controller = new AbortController();
    let admittedDuringBoot = 0;
    await instrumentation.run(
      { udid: UDID, timeoutMs: 1_000, signal: controller.signal },
      async () => {
        admittedDuringBoot = gate!.admitted;
      },
    );
    expect(gate!.admitOptions[0]).toMatchObject({ signal: controller.signal, bootUdid: UDID });
    expect(admittedDuringBoot).toBe(1);
    expect(gate!.admitted).toBe(0);
  });

  test("a failed boot still releases its capacity admission", async () => {
    const { gate, instrumentation } = setup({ outcome: "allow", limits, bootedCount: 0 });
    await expect(
      instrumentation.run({ udid: UDID, timeoutMs: 1_000 }, async () => {
        throw new Error("boot failed");
      }),
    ).rejects.toThrow("boot failed");
    expect(gate!.admitted).toBe(0);
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

describe("createIosSimCapacityGate", () => {
  function gateFor(env: NodeJS.ProcessEnv) {
    const simctl = new FakeSimCtlClient();
    simctl.setCommandArgsResult(["list", "devices", "--json"], '{"devices":{}}');
    const gate = createIosSimCapacityGate({
      simctl,
      timer: new FakeTimer(),
      history: new InMemoryBootDurationHistory(),
      env,
      executor: new FakeHostCommandExecutor(),
    });
    return { simctl, gate };
  }

  // #11181: the gate is on by default.
  test("arms the gate by default, reading the inventory through the injected simctl", async () => {
    const { simctl, gate } = gateFor({});
    expect(gate).toBeDefined();
    const instrumentation = createDefaultIosBootInstrumentation({ timer: new FakeTimer(), gate });
    // An unreadable host snapshot is non-fatal for an empty fleet.
    await instrumentation.run({ udid: UDID, timeoutMs: 1_000 }, async () => undefined);
    expect(simctl.getMethodCalls("executeCommandArgs").length).toBeGreaterThan(0);
  });

  test("the shared opt-out disables it", () => {
    expect(gateFor({ [BOOT_CAPACITY_GATE_ENV]: "0" }).gate).toBeUndefined();
  });

  test("the iOS override wins over the shared switch in both directions", () => {
    expect(gateFor({ [IOS_SIM_CAPACITY_GATE_ENV]: "0" }).gate).toBeUndefined();
    expect(
      gateFor({ [BOOT_CAPACITY_GATE_ENV]: "0", [IOS_SIM_CAPACITY_GATE_ENV]: "1" }).gate,
    ).toBeDefined();
  });
});
