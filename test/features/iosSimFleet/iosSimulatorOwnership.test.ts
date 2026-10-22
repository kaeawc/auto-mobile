import { describe, expect, spyOn, test } from "bun:test";
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
import { BindingRegistryUpgradePendingError } from "../../../src/daemon/sessionBroker/registry/bindingRegistryMigrations";
import { FakeTimer } from "../../fakes/FakeTimer";
import { FakeLogger } from "../../fakes/FakeLogger";
import { FakeBindingRegistry } from "../../fakes/FakeBindingRegistry";
import { logger } from "../../../src/utils/logger";

class Ownership implements IosSimulatorOwnershipReader {
  readonly held = new Set(["S1", "S2"]);
  refreshes = 0;
  failure?: Error;
  async refresh(): Promise<void> {
    this.refreshes += 1;
    if (this.failure) {
      throw this.failure;
    }
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
    expect((await gate.admitBoot(undefined, {})).decision).toMatchObject({
      heldDevices: ["S1", "S2"],
    });
    expect((await gate.admitBoot(undefined, {})).decision).not.toHaveProperty("externalDevices");
    ownership.held.clear();
    expect((await gate.admitBoot(undefined, {})).decision).toMatchObject({
      externalDevices: ["S1", "S2"],
    });
    expect((await gate.admitBoot(undefined, {})).decision).not.toHaveProperty("heldDevices");
    expect(ownership.refreshes).toBe(4);
  });

  test("reservation refreshes ownership before classifying a replacement refusal", async () => {
    const ownership = new Ownership();
    const { gate } = setup(2, ownership);
    await expect(
      gate.reserveBoot({ replacingDeviceId: "S1", timeoutMs: 1000 }),
    ).rejects.toMatchObject({
      details: { booted: 2, heldDevices: ["S2"], externalDevices: ["FOREIGN"] },
    });
    expect(ownership.refreshes).toBe(1);
    ownership.held.clear();
    await expect(
      gate.reserveBoot({ replacingDeviceId: "S1", timeoutMs: 1000 }),
    ).rejects.toMatchObject({
      details: { booted: 2, externalDevices: ["S2", "FOREIGN"] },
    });
    expect(ownership.refreshes).toBe(2);
  });

  test("reservation still refuses actual capacity when ownership cannot be refreshed", async () => {
    const ownership: IosSimulatorOwnershipReader = {
      refresh: () => Promise.reject(new BindingDiscoveryIncompleteError("unreadable")),
      isAutoMobileOwned: () => false,
    };
    await expect(setup(3, ownership).gate.reserveBoot({ timeoutMs: 1000 })).rejects.toMatchObject({
      details: { code: "capacity_exhausted", booted: 3, externalDevices: ["S1", "S2", "FOREIGN"] },
      message: expect.stringContaining("Ownership could not be read"),
    });
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

  test("an ownership refresh failure keeps a capacity refusal but qualifies external labels", async () => {
    const ownership: IosSimulatorOwnershipReader = {
      refresh: () => Promise.reject(new BindingDiscoveryIncompleteError("unreadable")),
      isAutoMobileOwned: () => false,
    };
    const result = await setup(3, ownership).gate.admitBoot(undefined, {});
    expect(result.decision).toMatchObject({
      outcome: "refuse",
      bootedCount: 3,
      externalDevices: ["S1", "S2", "FOREIGN"],
    });
    expect(result.decision).not.toHaveProperty("heldDevices");
    expect(result.releaseAdmission).toBeUndefined();
    if (result.decision.outcome !== "refuse") {
      throw new Error("expected refusal");
    }
    expect(result.decision.message).toContain("Ownership could not be read");
    expect(result.decision.message).toContain("have unconfirmed AutoMobile ownership");
    expect(result.decision.message).not.toContain("have no AutoMobile owner");
  });

  test.each(["admit", "check", "reserve"] as const)(
    "%s admits below the limit with a failing ownership reader and warns",
    async (route) => {
      const warn = spyOn(logger, "warn").mockImplementation(() => {});
      const ownership = new Ownership();
      ownership.failure = new BindingDiscoveryIncompleteError("unreadable");
      ownership.held.clear();
      const { gate } = setup(4, ownership);
      try {
        if (route === "admit") {
          const result = await gate.admitBoot(undefined, {});
          expect(result.decision.outcome).toBe("allow");
          expect(result.releaseAdmission).toBeFunction();
          result.releaseAdmission?.();
        } else if (route === "check") {
          await gate.assertCapacityAvailable();
        } else {
          const reservation = await gate.reserveBoot({ timeoutMs: 1000 });
          reservation.release();
        }
        expect(warn).toHaveBeenCalledWith(
          expect.stringContaining("ownership could not be read"),
          ownership.failure,
        );
        expect(ownership.refreshes).toBe(1);
      } finally {
        warn.mockRestore();
      }
    },
  );

  test("describeCapacity and unused evaluateBoot do not refresh ownership", async () => {
    const ownership = new Ownership();
    ownership.failure = new BindingDiscoveryIncompleteError("unreadable");
    const { gate } = setup(4, ownership);
    expect(await gate.describeCapacity()).toMatchObject({ limit: 4, booted: 3, inFlight: 0 });
    expect((await gate.evaluateBoot()).outcome).toBe("allow");
    expect(ownership.refreshes).toBe(0);
  });

  test.each(["admit", "check", "reserve"] as const)(
    "%s reads ownership after the simulator listing completes",
    async (route) => {
      let committed = false;
      let held = false;
      const ownership: IosSimulatorOwnershipReader = {
        refresh: async () => {
          held = committed;
        },
        isAutoMobileOwned: (udid) => held && udid === "S1",
      };
      const { gate, fleet } = setup(3, ownership);
      const listing = spyOn(fleet, "collectFresh").mockImplementation(async () => {
        committed = true;
        return fleet.report;
      });
      try {
        if (route === "admit") {
          expect((await gate.admitBoot(undefined, {})).decision).toMatchObject({
            heldDevices: ["S1"],
          });
        } else if (route === "check") {
          await expect(gate.assertCapacityAvailable()).rejects.toMatchObject({
            details: { heldDevices: ["S1"] },
          });
        } else {
          await expect(gate.reserveBoot({ timeoutMs: 1000 })).rejects.toMatchObject({
            details: { heldDevices: ["S1"] },
          });
        }
        expect(listing).toHaveBeenCalledTimes(1);
      } finally {
        listing.mockRestore();
      }
    },
  );

  test("a failed read keeps last-good held labels and warm exclusions, with uncertainty until recovery", async () => {
    const ownership = new Ownership();
    const { gate } = setup(3, ownership);
    await expect(gate.assertCapacityAvailable()).rejects.toMatchObject({
      details: { heldDevices: ["S1", "S2"] },
    });
    ownership.failure = new BindingDiscoveryIncompleteError("unreadable");
    const result = await gate.admitBoot(undefined, {});
    expect(result.decision).toMatchObject({
      heldDevices: ["S1", "S2"],
      externalDevices: ["FOREIGN"],
      message: expect.stringContaining("Ownership could not be read"),
    });
    const warm = setup(4, ownership).gate;
    const admitted = await warm.admitBoot({ runtime: "iOS-18", excludeUdids: ["FOREIGN"] }, {});
    expect(admitted.decision.outcome).toBe("allow");
    admitted.releaseAdmission?.();
    ownership.failure = undefined;
    ownership.held.clear();
    const recovered = await gate.admitBoot(undefined, {});
    expect(recovered.decision).toMatchObject({ externalDevices: ["S1", "S2", "FOREIGN"] });
    expect(recovered.decision).not.toHaveProperty("heldDevices");
    if (recovered.decision.outcome !== "refuse") {
      throw new Error("expected refusal");
    }
    expect(recovered.decision.message).not.toContain("Ownership could not be read");
  });

  test("a pending registry upgrade surfaces as unknown ownership, not as external devices (#14476)", async () => {
    const timer = new FakeTimer();
    const bindings = new RegistryBindingExclusion(async () => {
      throw new BindingRegistryUpgradePendingError("retirement deferred");
    }, timer);
    const reader = createIosSimulatorOwnershipReader(bindings, () => undefined);
    const warn = spyOn(logger, "warn").mockImplementation(() => {});
    try {
      await expect(reader.refresh()).rejects.toBeInstanceOf(BindingDiscoveryIncompleteError);
      const result = await setup(3, reader).gate.admitBoot(undefined, { bootUdid: "NEW" });
      expect(result.decision).toMatchObject({ outcome: "refuse", bootedCount: 3 });
      if (result.decision.outcome !== "refuse") {
        throw new Error("expected refusal");
      }
      expect(result.decision.message).toContain("Ownership could not be read");
      expect(result.decision.message).toContain("have unconfirmed AutoMobile ownership");
      expect(result.decision.message).not.toContain("have no AutoMobile owner");
      // Generic pool callers keep the established "absent" treatment of a pending upgrade.
      await bindings.refresh({ fresh: true, requireCurrent: true });
      expect(bindings.lastReadFailed()).toBe(false);
    } finally {
      warn.mockRestore();
    }
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
