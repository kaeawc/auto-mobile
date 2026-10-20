import { describe, expect, test } from "bun:test";
import { createIosSimulatorOwnershipReader } from "../../../src/daemon/iosSimulatorOwnership";
import { RegistryBindingExclusion } from "../../../src/daemon/sessionBroker/provisioning/exclusion";
import {
  IosSimCapacityGate,
  type IosSimulatorOwnershipReader,
} from "../../../src/features/iosSimFleet/CapacityGate";
import type { FleetCostSource } from "../../../src/features/iosSimFleet/FleetCostCollector";
import type { FleetCostReport } from "../../../src/features/iosSimFleet/types";
import { InMemoryBootDurationHistory } from "../../../src/features/iosSimFleet/BootDurationHistory";
import {
  FleetBootInstrumentation,
  bootProfileId,
} from "../../../src/features/iosSimFleet/IosBootInstrumentation";
import { BindingDiscoveryIncompleteError } from "../../../src/daemon/sessionBroker/provisioning/refusal";
import { FakeTimer } from "../../fakes/FakeTimer";
import { FakeLogger } from "../../fakes/FakeLogger";
import { FakeBindingRegistry } from "../../fakes/FakeBindingRegistry";

class Ownership implements IosSimulatorOwnershipReader {
  readonly held = new Set(["S1", "S2"]);
  refreshes = 0;
  async refresh(): Promise<void> {
    this.refreshes += 1;
  }
  isAutoMobileOwned(udid: string): boolean {
    return this.held.has(udid);
  }
}

class Fleet implements FleetCostSource {
  report: FleetCostReport = {
    collectedAtMs: 0,
    simulators: ["S1", "S2", "FOREIGN"].map((udid) => ({
      udid,
      name: udid,
      state: "Booted",
      runtime: "iOS-18",
      quality: "no-processes",
      lastBoot: { udid, profileId: bootProfileId(), durationMs: 1, recordedAtMs: 0 },
    })),
    totals: { bootedCount: 3, measuredCount: 0, rssBytes: 0, cpuPercent: 0, diskBytes: 0 },
    host: {
      totalMemoryBytes: 64 * 1024 ** 3,
      cpuCount: 16,
      loadAverage1m: 0,
      memoryPressure: "normal",
    },
    errors: [],
  };
  async collect(): Promise<FleetCostReport> {
    return this.report;
  }
  async collectFresh(): Promise<FleetCostReport> {
    return this.report;
  }
}

function setup(limit = 3, ownership?: IosSimulatorOwnershipReader) {
  const timer = new FakeTimer();
  const fleet = new Fleet();
  const gate = new IosSimCapacityGate(fleet, timer, {
    env: { AUTOMOBILE_IOS_SIM_MAX_BOOTED: String(limit) },
    ownership,
  });
  return { timer, fleet, gate };
}

describe("iOS simulator ownership", () => {
  test("restart: a new gate classifies persisted S1/S2 as held and a foreign simulator as external", async () => {
    const ownership = new Ownership();
    const { gate } = setup(3, ownership);
    const result = await gate.admitBoot(undefined, { bootUdid: "NEW" });
    expect(result.decision).toMatchObject({
      outcome: "refuse",
      bootedCount: 3,
      heldDevices: ["S1", "S2"],
      externalDevices: ["FOREIGN"],
    });
    expect(ownership.refreshes).toBe(1);
    expect(result.releaseAdmission).toBeUndefined();
    if (result.decision.outcome !== "refuse") {
      throw new Error("expected refusal");
    }
    expect(result.decision.message).toContain("held by AutoMobile: S1, S2");
    expect(result.decision.message).toContain(
      "have no AutoMobile owner but still count toward the limit: FOREIGN",
    );
    await expect(gate.assertCapacityAvailable()).rejects.toMatchObject({
      details: {
        code: "capacity_exhausted",
        platform: "ios",
        retryable: true,
        retryAfterMs: 5000,
        limit: 3,
        booted: 3,
        heldDevices: ["S1", "S2"],
        externalDevices: ["FOREIGN"],
      },
    });
  });

  test("held-only refusal omits externalDevices and ownership is refreshed on each read", async () => {
    const ownership = new Ownership();
    const { gate, fleet } = setup(2, ownership);
    fleet.report.simulators.pop();
    expect(await gate.evaluateBoot()).toMatchObject({ heldDevices: ["S1", "S2"] });
    expect(await gate.evaluateBoot()).not.toHaveProperty("externalDevices");
    ownership.held.clear();
    expect(await gate.evaluateBoot()).toMatchObject({ externalDevices: ["S1", "S2"] });
    expect(await gate.evaluateBoot()).not.toHaveProperty("heldDevices");
  });

  test("without a reader all unadmitted devices retain their external classification", async () => {
    const { gate } = setup();
    expect(await gate.evaluateBoot()).toMatchObject({ externalDevices: ["S1", "S2", "FOREIGN"] });
    expect(await gate.evaluateBoot()).not.toHaveProperty("heldDevices");
  });

  test("warm hint excludes held simulators and the requested UDID and never logs them", async () => {
    const { gate, fleet, timer } = setup(4, new Ownership());
    // Every compatible booted device is held or is the boot's own target.
    const logger = new FakeLogger();
    const instrumentation = new FleetBootInstrumentation({
      gate,
      timer,
      logger,
      history: new InMemoryBootDurationHistory(),
    });
    let boots = 0;
    const request = { udid: "FOREIGN", runtime: "iOS-18", timeoutMs: 1000 };
    await instrumentation.run(request, async () => {
      boots += 1;
    });
    expect(logger.messages).toEqual([]);
    expect(boots).toBe(1);
    const admitted = await gate.admitBoot({ runtime: "iOS-18", excludeUdids: ["FOREIGN"] }, {});
    expect(admitted.decision.outcome).toBe("allow");
    admitted.releaseAdmission?.();
    // A genuinely available warm device still produces the hint.
    fleet.report.simulators.push({
      udid: "IDLE",
      name: "idle",
      state: "Booted",
      runtime: "iOS-18",
      quality: "no-processes",
      lastBoot: { udid: "IDLE", profileId: bootProfileId(), durationMs: 1, recordedAtMs: 0 },
    });
    await instrumentation.run(request, async () => {
      boots += 1;
    });
    expect(logger.at("info").map((entry) => entry.message)).toEqual([
      "compatible warm simulator IDLE is booted; booting FOREIGN as requested",
    ]);
    expect(boots).toBe(2);
  });

  test("ownership does not change capacity or evaluateBoot substitution policy", async () => {
    const { gate } = setup(3, new Ownership());
    expect(await gate.evaluateBoot({ runtime: "iOS-18" })).toEqual({
      outcome: "reuse-warm",
      udid: "S1",
    });
    expect((await gate.admitBoot({ runtime: "iOS-18" }, {})).decision.outcome).toBe("refuse");
  });

  test("an ownership refresh failure never labels unknown owners as external", async () => {
    const ownership: IosSimulatorOwnershipReader = {
      refresh: () => Promise.reject(new BindingDiscoveryIncompleteError("unreadable")),
      isAutoMobileOwned: () => false,
    };
    await expect(setup(3, ownership).gate.admitBoot(undefined, {})).rejects.toThrow("unreadable");
  });

  test("daemon reader is lazy and reads registry snapshot plus live session assignments", async () => {
    const timer = new FakeTimer();
    const registry = new FakeBindingRegistry(timer);
    let opens = 0;
    const bindings = new RegistryBindingExclusion(async () => {
      opens += 1;
      return registry;
    }, timer);
    let assigned = new Set(["LIVE"]);
    const reader = createIosSimulatorOwnershipReader(bindings, () => ({
      getAssignedDevices: () => assigned,
    }));
    expect(opens).toBe(0);
    // The broker snapshot carries binding/journal ownership, rather than only current executions.
    const scope = await registry.ensureScope({
      managedHostScope: "host",
      runnerNamespace: "ns",
      runnerIncarnation: "inc",
    });
    if (scope.kind !== "ready") {
      throw new Error("scope not ready");
    }
    const key = { scopeKey: scope.scope.scopeKey, bindingIndex: 0 };
    const spec = { runtime: "iOS-18" };
    await registry.initBinding(key, { role: "app", platform: "ios", requestedSpec: spec });
    await registry.commitBinding(
      key,
      { generation: 0, stableDeviceId: null },
      {
        stableDeviceId: "S1",
        deviceName: "S1",
        resolvedSpec: spec,
        specFingerprint: "fp",
        state: "ready",
      },
    );
    const journalKey = { scopeKey: scope.scope.scopeKey, bindingIndex: 1 };
    await registry.initBinding(journalKey, { role: "app", platform: "ios", requestedSpec: spec });
    const assignment = await registry.getAssignment(journalKey);
    if (!assignment) {
      throw new Error("missing assignment");
    }
    await registry.openBindingJournal(journalKey, {
      kind: "create",
      phase: "created",
      owner: { daemonId: "previous-daemon", pid: 100 },
      target: {
        oldStableId: null,
        oldName: null,
        newStableId: "S2",
        newName: "S2",
        requestedSpec: spec,
        resolvedSpec: spec,
        specFingerprint: "fp",
      },
      assignment: { kind: "state", expected: assignment, state: "provisioning" },
    });
    const restarted = setup(3, reader).gate;
    expect(opens).toBe(0);
    expect((await restarted.admitBoot(undefined, { bootUdid: "NEW" })).decision).toMatchObject({
      heldDevices: ["S1", "S2"],
      externalDevices: ["FOREIGN"],
    });
    expect(reader.isAutoMobileOwned("S1")).toBe(true);
    expect(reader.isAutoMobileOwned("S2")).toBe(true);
    expect(reader.isAutoMobileOwned("LIVE")).toBe(true);
    expect(reader.isAutoMobileOwned("FOREIGN")).toBe(false);
    assigned = new Set();
    expect(reader.isAutoMobileOwned("LIVE")).toBe(false);
    expect(opens).toBe(1);
  });
});
