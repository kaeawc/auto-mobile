import { beforeEach, describe, expect, test } from "bun:test";
import {
  BindingReconciler,
  DefaultManagedSpecResolver,
  type BindingReconcileRequest,
  type BindingReconcileResult,
} from "../../../../src/daemon/sessionBroker/provisioning/reconciler";
import { computeBindingResourceUsage } from "../../../../src/daemon/sessionBroker/provisioning/resourceBudget";
import {
  BINDING_JOURNAL_QUARANTINE_PROBE_MS,
  BindingJournalInFlight,
} from "../../../../src/daemon/sessionBroker/registry/bindingJournal";
import type {
  BindingJournalOwner,
  BindingKey,
} from "../../../../src/daemon/sessionBroker/registry/bindingRegistry";
import type { ExactDeviceSpecification } from "../../../../src/devices/exactDeviceProvisioning";
import { parseJournalTarget } from "../../../../src/daemon/sessionBroker/registry/bindingRegistryRows";
import { FakeBindingRegistry } from "../../../fakes/FakeBindingRegistry";
import { FakeTimer } from "../../../fakes/FakeTimer";
import {
  FakeClaims,
  FakeDeleter,
  FakeInventory,
  FakeMatcher,
  FakeProvisioner,
} from "./fixtures/reconcilerFakes";

// #14018: when the teardown workflow's bounded soft retries and its SIGTERM/SIGKILL escalation both
// failed, the journal quarantines the entry instead of re-driving the same stuck delete forever.
// The device stays charged (its process is alive); only an observed absence settles the entry.

const IOS_18 = "com.apple.CoreSimulator.SimRuntime.iOS-18-0";
const IOS_17 = "com.apple.CoreSimulator.SimRuntime.iOS-17-5";
const IPHONE_16 = "com.apple.CoreSimulator.SimDeviceType.iPhone-16";
const SPEC_18: ExactDeviceSpecification = { runtime: IOS_18, deviceType: IPHONE_16 };
const SPEC_17: ExactDeviceSpecification = { runtime: IOS_17, deviceType: IPHONE_16 };
const SCOPE = { managedHostScope: "host-a", runnerNamespace: "ns", runnerIncarnation: "inc-1" };

const owner = (daemonId: string): BindingJournalOwner => ({
  daemonId,
  pid: daemonId === "daemon-1" ? 1001 : 2002,
  processGenerationToken: `${daemonId}-start`,
});

describe("binding journal quarantine of a teardown that cannot stop the device", () => {
  let timer: FakeTimer;
  let registry: FakeBindingRegistry;
  let inventory: FakeInventory;
  let deleter: FakeDeleter;
  let provisioner: FakeProvisioner;
  let liveDaemons: Set<string>;
  let key: BindingKey;

  beforeEach(async () => {
    timer = new FakeTimer();
    timer.setCurrentTime(1_000_000);
    registry = new FakeBindingRegistry(timer);
    inventory = new FakeInventory();
    provisioner = new FakeProvisioner(inventory);
    deleter = new FakeDeleter(inventory);
    liveDaemons = new Set(["daemon-1", "daemon-2"]);
    const scope = await registry.ensureScope(SCOPE);
    if (scope.kind !== "ready") {
      throw new Error("scope setup failed");
    }
    key = { scopeKey: scope.scope.scopeKey, bindingIndex: 0 };
  });

  function daemon(daemonId: string) {
    return new BindingReconciler({
      registry,
      inventory,
      matcher: new FakeMatcher(),
      resolver: new DefaultManagedSpecResolver(),
      provisioner,
      deleter,
      claims: new FakeClaims(),
      timer,
      journal: {
        owner: owner(daemonId),
        isOwnerLive: (candidate) => liveDaemons.has(candidate.daemonId),
        inFlight: new BindingJournalInFlight(),
      },
    });
  }

  const request = (spec: ExactDeviceSpecification): BindingReconcileRequest => ({
    key,
    role: "app",
    platform: "ios",
    requestedSpec: spec,
    deadlineMs: timer.now() + 60_000,
  });

  function expectFailed(result: BindingReconcileResult) {
    if (result.outcome !== "failed") {
      throw new Error(`expected failure, got ${result.disposition}`);
    }
    return result;
  }

  /** A stuck replacement of a SPEC_17 device: the first delete fails after full escalation. */
  async function quarantine() {
    const seeded = await daemon("daemon-0").reconcile(request(SPEC_17));
    if (seeded.outcome !== "ready") {
      throw new Error("seed failed");
    }
    deleter.failWithEscalationExhausted = "emulator still running with pid 4242";
    const result = expectFailed(await daemon("daemon-1").reconcile(request(SPEC_18)));
    liveDaemons.delete("daemon-1");
    return { oldId: seeded.device.stableId, result };
  }

  test("an exhausted escalation quarantines the entry with a typed, non-retryable failure", async () => {
    const { oldId, result } = await quarantine();

    expect(result.failure).toMatchObject({ code: "cleanup_quarantined", retryable: false });
    const [entry] = await registry.listOpenBindingJournal(key);
    expect(entry).toMatchObject({
      phase: "deleting",
      attempts: 1,
      lastError: "emulator still running with pid 4242",
      nextAttemptAtMs: timer.now() + BINDING_JOURNAL_QUARANTINE_PROBE_MS,
    });
    expect(entry.target.quarantinedAtMs).toBe(timer.now());
    expect((await registry.getAssignment(key))?.state).toBe("cleanup_pending");
    expect(inventory.has(oldId)).toBe(true);
  });

  test("passes and acquisitions never re-send the delete while the device stays", async () => {
    await quarantine();
    const journal = daemon("daemon-2").journal;

    for (let minute = 0; minute < 9; minute += 1) {
      timer.advanceTime(60_000);
      expect(await journal.runPass()).toEqual({ settled: [], blocked: [], skipped: 1 });
    }
    const blockedAcquisition = expectFailed(await daemon("daemon-2").reconcile(request(SPEC_18)));

    expect(blockedAcquisition.failure).toMatchObject({
      code: "cleanup_quarantined",
      retryable: false,
    });
    expect(deleter.calls).toHaveLength(1);
  });

  test("a due probe that still sees the device re-arms the quarantine without deleting", async () => {
    await quarantine();
    const journal = daemon("daemon-2").journal;
    timer.advanceTime(BINDING_JOURNAL_QUARANTINE_PROBE_MS);

    expect((await journal.runPass()).blocked).toEqual([
      expect.objectContaining({ reason: "cleanup_quarantined" }),
    ]);

    expect(deleter.calls).toHaveLength(1);
    const [entry] = await registry.listOpenBindingJournal(key);
    expect(entry.nextAttemptAtMs).toBe(timer.now() + BINDING_JOURNAL_QUARANTINE_PROBE_MS);
    expect(entry.target.quarantinedAtMs).toBeDefined();
  });

  test("a due probe that finds the device gone settles the entry and empties the binding", async () => {
    const { oldId } = await quarantine();
    inventory.remove(oldId);
    timer.advanceTime(BINDING_JOURNAL_QUARANTINE_PROBE_MS);

    const pass = await daemon("daemon-2").journal.runPass();

    expect(pass.settled).toEqual([expect.objectContaining({ phase: "committed" })]);
    expect(deleter.calls).toHaveLength(1);
    expect(await registry.listOpenBindingJournal()).toEqual([]);
    expect(await registry.getAssignment(key)).toMatchObject({
      stableDeviceId: null,
      state: "provisioning",
    });
  });

  test("the quarantined device stays charged against capacity as a deleting commitment", async () => {
    const { oldId } = await quarantine();

    const usage = computeBindingResourceUsage({
      ...(await registry.snapshotBindingResources()),
      inventory: inventory.devices,
    });

    expect(usage.deleting).toBe(1);
    expect(usage.total).toBeGreaterThanOrEqual(1);
    expect(inventory.has(oldId)).toBe(true);
  });

  test("an ordinary failed delete keeps the identical retry behavior", async () => {
    const seeded = await daemon("daemon-0").reconcile(request(SPEC_17));
    expect(seeded.outcome).toBe("ready");
    deleter.failWith = "simctl delete failed";

    const result = expectFailed(await daemon("daemon-1").reconcile(request(SPEC_18)));

    expect(result.failure).toMatchObject({ code: "cleanup_pending", retryable: true });
    const [entry] = await registry.listOpenBindingJournal(key);
    expect(entry.target.quarantinedAtMs).toBeUndefined();
  });
});

describe("journal target codec", () => {
  test("the quarantine marker survives the persisted JSON round trip", () => {
    const target = {
      oldStableId: "a",
      oldName: null,
      newName: null,
      newStableId: null,
      requestedSpec: null,
      resolvedSpec: null,
      specFingerprint: null,
      quarantinedAtMs: 42,
    };
    expect(parseJournalTarget(JSON.stringify(target)).quarantinedAtMs).toBe(42);
    expect(
      parseJournalTarget(JSON.stringify({ ...target, quarantinedAtMs: "x" })).quarantinedAtMs,
    ).toBeUndefined();
  });
});
