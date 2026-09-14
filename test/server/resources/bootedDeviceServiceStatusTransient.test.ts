import { afterEach, describe, expect, test } from "bun:test";
import { FakeTimer } from "../../fakes/FakeTimer";
import {
  enrichDeviceServiceStatuses,
  probeServiceStatusWithBudget,
  setServiceStatusProbe,
  type ServiceStatusProbe,
} from "../../../src/server/bootedDeviceResources";
import type { DeviceServiceStatus } from "../../../src/server/bootedDeviceResources";

// A booted iOS simulator entry as the resource builds it from discovery, before service-status
// enrichment. `readiness.unknown` and `capabilities.automation === null` are the freshly-discovered
// defaults; a transient probe failure must leave them untouched (#7053).
function bootedIosDevice(deviceId: string) {
  return {
    name: "iPhone 15 Pro",
    platform: "ios" as const,
    deviceId,
    identity: { stableId: deviceId, connectionId: deviceId },
    source: "local" as const,
    isVirtual: true,
    status: "booted" as const,
    lifecycleState: "booted" as const,
    readiness: { state: "unknown" as const },
    capabilities: { automation: null },
  };
}

const readyServiceStatus: DeviceServiceStatus = {
  installed: true,
  enabled: true,
  running: true,
  installedSha256: null,
  expectedSha256: "",
  isCompatible: true,
  supportedCommandsComplete: true,
  supportedFeaturesComplete: true,
};

const neverSettles: ServiceStatusProbe = () => new Promise<never>(() => {});

describe("booted iOS service-status transient handling (#7053)", () => {
  afterEach(() => {
    setServiceStatusProbe(null);
  });

  test("a hung service-status probe yields a transient timeout diagnostic, not a settled status", async () => {
    const timer = new FakeTimer();
    const device = bootedIosDevice("SIM-A");
    const outcomePromise = probeServiceStatusWithBudget(
      device,
      neverSettles,
      timer.now() + 5000,
      timer,
    );
    // Fire the bounded wait: the probe never resolves, so the deadline must win.
    timer.advanceTime(5000);
    const outcome = await outcomePromise;

    expect(outcome.status).toBeUndefined();
    expect(outcome.diagnostic).toEqual({
      state: "timeout",
      reason: "Service-status probe did not settle within 5000ms",
    });
  });

  test("a thrown probe (loopback refused/reset) yields a transient unreachable diagnostic", async () => {
    const timer = new FakeTimer();
    const probe: ServiceStatusProbe = () =>
      Promise.reject(new Error("connect ECONNREFUSED 127.0.0.1"));
    const outcome = await probeServiceStatusWithBudget(
      bootedIosDevice("SIM-A"),
      probe,
      timer.now() + 5000,
      timer,
    );

    expect(outcome.status).toBeUndefined();
    expect(outcome.diagnostic?.state).toBe("unreachable");
    expect(outcome.diagnostic?.reason).toContain("ECONNREFUSED");
  });

  test("respects the caller deadline budget: an already-elapsed budget returns immediately without probing", async () => {
    const timer = new FakeTimer();
    let probeCalls = 0;
    const probe: ServiceStatusProbe = () => {
      probeCalls++;
      return new Promise<never>(() => {});
    };
    const outcome = await probeServiceStatusWithBudget(
      bootedIosDevice("SIM-A"),
      probe,
      timer.now(),
      timer,
    );

    expect(probeCalls).toBe(0);
    expect(outcome.diagnostic?.state).toBe("timeout");
  });

  test("bounds the wait by the remaining budget, not a fixed default", async () => {
    const timer = new FakeTimer();
    const outcomePromise = probeServiceStatusWithBudget(
      bootedIosDevice("SIM-A"),
      neverSettles,
      timer.now() + 100,
      timer,
    );
    // Only 100ms of budget remains; advancing that far must trip the deadline.
    timer.advanceTime(100);
    const outcome = await outcomePromise;

    expect(outcome.diagnostic).toEqual({
      state: "timeout",
      reason: "Service-status probe did not settle within 100ms",
    });
  });

  test("enrichment keeps a booted simulator in the list with a transient marker when its probe times out", async () => {
    const timer = new FakeTimer();
    setServiceStatusProbe(neverSettles);
    const devices = [bootedIosDevice("SIM-A")];

    const enriched = enrichDeviceServiceStatuses(devices, timer);
    timer.advanceTime(5000);
    await enriched;

    // Present, still one device, still booted — not dropped.
    expect(devices).toHaveLength(1);
    expect(devices[0].deviceId).toBe("SIM-A");
    expect(devices[0].status).toBe("booted");
    // Transient marker attached; readiness untouched (never demoted to not_ready).
    expect(devices[0].serviceStatusDiagnostic?.state).toBe("timeout");
    expect(devices[0].serviceStatus).toBeUndefined();
    expect(devices[0].readiness).toEqual({ state: "unknown" });
  });

  test("two consecutive observations do not flap presence: timeout then success both keep the device present", async () => {
    // Observation 1: probe hangs -> device present with a transient timeout marker.
    const timer1 = new FakeTimer();
    setServiceStatusProbe(neverSettles);
    const devices1 = [bootedIosDevice("SIM-A")];
    const enriched1 = enrichDeviceServiceStatuses(devices1, timer1);
    timer1.advanceTime(5000);
    await enriched1;

    expect(devices1).toHaveLength(1);
    expect(devices1[0].serviceStatusDiagnostic?.state).toBe("timeout");

    // Observation 2: probe recovers -> device still present, now with a real status and no marker.
    const timer2 = new FakeTimer();
    setServiceStatusProbe(async () => readyServiceStatus);
    const devices2 = [bootedIosDevice("SIM-A")];
    await enrichDeviceServiceStatuses(devices2, timer2);

    expect(devices2).toHaveLength(1);
    expect(devices2[0].deviceId).toBe("SIM-A");
    expect(devices2[0].serviceStatus).toEqual(readyServiceStatus);
    expect(devices2[0].serviceStatusDiagnostic).toBeUndefined();
  });
});
