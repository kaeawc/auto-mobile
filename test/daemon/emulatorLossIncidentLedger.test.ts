import { describe, expect, test } from "bun:test";
import {
  EmulatorLossIncidentLedger,
  type EmulatorLossIncidentPoolPort,
} from "../../src/daemon/emulatorLossIncidentLedger";
import type { PooledDevice } from "../../src/daemon/devicePool";
import type {
  EmulatorLossIncident,
  EmulatorLossIncidentStore,
  EmulatorLossRecoveryAttempt,
  EmulatorLossRecoverySettlement,
  EmulatorRecoveryOutcome,
  OpenEmulatorLossIncidentInput,
} from "../../src/daemon/emulatorLossIncident";
import type { RetryExecutor } from "../../src/utils/retry/RetryExecutor";
import { FakeTimer } from "../fakes/FakeTimer";

class FakeIncidentStore implements EmulatorLossIncidentStore {
  readonly incidents = new Map<string, EmulatorLossIncident>();
  openCount = 0;
  completionCount = 0;

  async open(input: OpenEmulatorLossIncidentInput): Promise<EmulatorLossIncident> {
    const incident: EmulatorLossIncident = {
      id: `incident-${++this.openCount}`,
      observedAtMs: 0,
      updatedAtMs: 0,
      deviceId: input.deviceId,
      avdName: input.avdName,
      detectionPath: input.detectionPath,
      processExit: input.processExit,
      outputTail: input.outputTail,
      lastAdbState: input.lastAdbState,
      session: input.session,
      recovery: { policy: input.recoveryPolicy, attempts: [] },
    };
    this.incidents.set(incident.id, incident);
    return incident;
  }

  async recordRecoveryAttempt(id: string, attempt: EmulatorLossRecoveryAttempt): Promise<void> {
    this.incidents.get(id)?.recovery.attempts.push(attempt);
  }

  async completeRecovery(
    id: string,
    outcome: EmulatorRecoveryOutcome,
    settlement: EmulatorLossRecoverySettlement = {},
  ): Promise<void> {
    const incident = this.incidents.get(id);
    if (incident) {
      incident.recovery.outcome = outcome;
      incident.replacementDeviceId = settlement.replacementDeviceId;
      this.completionCount++;
    }
  }

  async get(id: string): Promise<EmulatorLossIncident | undefined> {
    return this.incidents.get(id);
  }

  async list(limit?: number): Promise<EmulatorLossIncident[]> {
    return [...this.incidents.values()].slice(0, limit);
  }
}

class FakePoolPort implements EmulatorLossIncidentPoolPort {
  device: PooledDevice | null = {
    id: "emulator-5554",
    name: "Pixel",
    platform: "android",
    sessionId: null,
    status: "available",
    lastUsedAt: 0,
    assignmentCount: 0,
    errorCount: 0,
    incarnation: 1,
  };

  getDevice(_deviceId: string): PooledDevice | null {
    return this.device;
  }

  getRecoveryPolicy() {
    return { onLoss: true, maxAttempts: 2 };
  }

  getSessionForDevice(_deviceId: string): string | null {
    return null;
  }

  getSession(_sessionId: string): null {
    return null;
  }

  getProcessOutputTail(_deviceId: string): undefined {
    return undefined;
  }
}

const retryExecutor: RetryExecutor = {
  async execute() {
    throw new Error("Unused by incident ledger");
  },
  async executeOrThrow(operation) {
    return operation(1);
  },
};

function createLedger() {
  const port = new FakePoolPort();
  const store = new FakeIncidentStore();
  const timer = new FakeTimer();
  return {
    port,
    store,
    timer,
    ledger: new EmulatorLossIncidentLedger(port, store, timer, retryExecutor),
  };
}

describe("EmulatorLossIncidentLedger", () => {
  test("records an incident and creates its settlement pair", async () => {
    const { ledger, store } = createLedger();
    const id = await ledger.recordEmulatorLossIncident("emulator-5554", "device-discovery-miss");

    expect(id).toBe("incident-1");
    expect(store.openCount).toBe(1);
    expect(ledger.emulatorLossRecoverySettlements.has(id!)).toBe(true);
    expect(ledger.emulatorLossRecoveryResolvers.has(id!)).toBe(true);
  });

  test("wait resolves when the incident settles", async () => {
    const { ledger } = createLedger();
    const id = (await ledger.recordEmulatorLossIncident("emulator-5554", "device-discovery-miss"))!;
    const waiting = ledger.waitForEmulatorLossIncident(id, 10);

    ledger.settleEmulatorLossIncident(id);
    expect((await waiting)?.id).toBe(id);
    expect(ledger.emulatorLossRecoverySettlements.has(id)).toBe(false);
  });

  test("wait returns the current incident on fake timer timeout", async () => {
    const { ledger, timer } = createLedger();
    const id = (await ledger.recordEmulatorLossIncident("emulator-5554", "device-discovery-miss"))!;
    const waiting = ledger.waitForEmulatorLossIncident(id, 10);

    timer.advanceTime(10);
    expect((await waiting)?.id).toBe(id);
    expect(ledger.emulatorLossRecoverySettlements.has(id)).toBe(true);
  });

  test("finish completes recovery and clears the settlement pair", async () => {
    const { ledger, store } = createLedger();
    const id = (await ledger.recordEmulatorLossIncident("emulator-5554", "device-discovery-miss"))!;
    const settled = ledger.emulatorLossRecoverySettlements.get(id)!;

    await ledger.finishEmulatorLossIncident(id, "recovered");
    await settled;
    expect(store.completionCount).toBe(1);
    expect((await store.get(id))?.recovery.outcome).toBe("recovered");
    expect(ledger.emulatorLossRecoveryResolvers.has(id)).toBe(false);
    expect(ledger.emulatorLossRecoverySettlements.has(id)).toBe(false);
  });

  test("non-Android and missing devices do not reach the store", async () => {
    const { ledger, port, store } = createLedger();
    port.device = { ...port.device!, platform: "ios" };
    expect(
      await ledger.recordEmulatorLossIncident("emulator-5554", "device-discovery-miss"),
    ).toBeUndefined();
    port.device = null;
    expect(
      await ledger.recordEmulatorLossIncident("emulator-5554", "device-discovery-miss"),
    ).toBeUndefined();
    expect(store.openCount).toBe(0);
  });
});
