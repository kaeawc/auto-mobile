import { describe, expect, test } from "bun:test";
import type { ManagedExecutionReleaseResult } from "../../../src/daemon/managedSlots/managedExecutionRelease";
import type { ManagedSlotAcquisition } from "../../../src/daemon/managedSlots/managedSlotAcquisition";
import { ManagedSlotJournal } from "../../../src/daemon/managedSlots/slotJournal";
import {
  computeSlotScopeKey,
  type OpenSlotJournalInput,
  type SlotExecOwnerLiveness,
  type SlotJournalOwner,
  type SlotKey,
  type SlotRegistry,
  type SlotScopeIdentity,
} from "../../../src/daemon/managedSlots/slotRegistry";
import { ManagedDevicePort } from "../../../src/daemon/sessionBroker/managedDevicePort";
import { currentManagedSlotReconciler } from "../../../src/daemon/managedSlots/managedSlotExclusion";
import type { ManagedDevicePortDependencies } from "../../../src/daemon/sessionBroker/managedDevicePort";
import type { BrokerResourceRecord } from "../../../src/daemon/sessionBroker/store";
import type { ManagedSlotConfig } from "../../../src/models/managedSlotConfig";
import type { ManagedSlotsResult } from "../../../src/models/managedSlotsResult";
import { FakeSlotRegistry } from "../../fakes/FakeSlotRegistry";
import { FakeTimer } from "../../fakes/FakeTimer";
import {
  FakeClaims,
  FakeDeleter,
  FakeInventory,
  FakeMatcher,
} from "../managedSlots/fixtures/reconcilerFakes";

const SCOPE: SlotScopeIdentity = {
  managedHostScope: "broker-host",
  runnerNamespace: "private-session-broker",
  runnerIncarnation: "persistent-pool-v1",
};
const SCOPE_KEY = computeSlotScopeKey(SCOPE);
const OWNER: SlotJournalOwner = {
  daemonId: "broker-daemon",
  pid: 101,
  processGenerationToken: "broker-generation",
};
const FOREIGN_OWNER: SlotJournalOwner = {
  daemonId: "foreign-daemon",
  pid: 202,
  processGenerationToken: "foreign-generation",
};
const IOS = {
  platform: "ios",
  requirement: { platform: "ios", effective: {}, provenance: {}, original: {} },
  profile: {
    platform: "ios",
    metadataState: "current",
    simulatorDeviceTypeIdentifier: "com.apple.CoreSimulator.SimDeviceType.iPhone-17-Pro",
    modelIdentifier: "iPhone18,1",
    archetype: "phone",
    modelType: { family: "iphone", variant: "pro" },
    runtimeId: "com.apple.CoreSimulator.SimRuntime.iOS-27-0",
    osVersion: "27",
    compatibility: "supported",
  },
  provenance: {
    catalogSource: "fake-simctl",
    catalogRevision: "ios-1",
    policyVersion: "policy-1",
  },
};
const ANDROID = {
  platform: "android",
  requirement: { platform: "android", effective: {}, provenance: {}, original: {} },
  profile: {
    platform: "android",
    metadataState: "current",
    profileId: "pixel_phone",
    archetype: "phone",
    systemImagePackage: "system-images;android-35;google_apis;arm64-v8a",
    osVersion: "15",
    versionPrecision: "major",
    apiLevel: 35,
    abi: "arm64-v8a",
    flavor: "google_apis",
  },
  provenance: {
    catalogSource: "fake-sdk",
    catalogRevision: "android-1",
    policyVersion: "policy-1",
  },
};

function resource(
  profile: unknown = IOS,
  state: BrokerResourceRecord["state"] = "reserved",
): BrokerResourceRecord {
  return {
    resourceId: "resource-1",
    allocationIndex: 7,
    scopeKey: SCOPE_KEY,
    profile,
    state,
    requestId: "request-1",
    revision: 1,
    idleOrder: 0,
  };
}

function releaseResult(
  sessionId: string,
  overrides: Partial<ManagedExecutionReleaseResult> = {},
): ManagedExecutionReleaseResult {
  return {
    sessionId,
    outcome: "reusable_for_this_slot",
    settlement: "confirmed",
    alreadyReleased: false,
    cancellationRequested: 0,
    releaseForced: false,
    device: "device-1",
    slots: [],
    slotFailures: [],
    ...overrides,
  };
}

function readyResult(
  config: ManagedSlotConfig,
  overrides: Partial<ManagedSlotsResult["slots"][number]> = {},
): ManagedSlotsResult {
  const request = config.requests[0]!;
  return {
    contractVersion: 1,
    scope: { ...SCOPE, scopeKey: SCOPE_KEY },
    outcome: "ready",
    slots: [
      {
        slotIndex: request.slotIndex,
        role: request.role,
        platform: request.platform,
        assignmentGeneration: 1,
        device: { stableId: "device-1", transportId: "transport-1", name: "device-1" },
        sessionUuid: "session-1",
        requestedSpec: request.requestedSpec,
        resolvedSpec: request.requestedSpec,
        specFingerprint: { version: 1, hash: "profile" },
        disposition: "created",
        readiness: { mode: "automation", status: "automation_ready" },
        lifecycle: {},
        ...overrides,
      },
    ],
  };
}

function acquisition(
  run: (config: ManagedSlotConfig) => Promise<ManagedSlotsResult>,
): Pick<ManagedSlotAcquisition, "acquire"> {
  return { acquire: run };
}

describe("ManagedDevicePort preparation and release", () => {
  test("maps exact iOS native identifiers and private provider allocation options", async () => {
    let received: ManagedSlotConfig | undefined;
    const port = new ManagedDevicePort({
      scope: SCOPE,
      managedSlotAcquisition: acquisition(async (config) => {
        received = config;
        return readyResult(config);
      }),
      managedExecutionRelease: {
        releaseExecution: async (sessionId) => releaseResult(sessionId),
      },
      registry: {} as never,
      managedSlotJournal: {
        owner: OWNER,
        redriveSlot: async () => ({ kind: "clear", redriven: [] }),
      },
    });

    const prepared = await port.prepare(resource(), {
      livenessOwnerToken: "consumer-liveness",
      preparationTimeoutMs: 30_000,
      idleTimeoutMs: 120_000,
      executionOwnerPid: 303,
    });

    expect(received).toEqual({
      contractVersion: 1,
      ...SCOPE,
      localSlotCapacity: 1,
      requests: [
        {
          slotIndex: 7,
          role: "session-broker-device",
          platform: "ios",
          requestedSpec: {
            runtime: IOS.profile.runtimeId,
            deviceType: IOS.profile.simulatorDeviceTypeIdentifier,
          },
        },
      ],
      preparationTimeoutMs: 30_000,
      idleTimeoutMs: 120_000,
      executionOwnerPid: 303,
    });
    expect(prepared).toEqual({ sessionId: "session-1", profile: IOS.profile });
  });

  test("maps the exact Android profile and rejects inconsistent API, ABI, or flavor metadata", async () => {
    const configs: ManagedSlotConfig[] = [];
    const port = new ManagedDevicePort({
      scope: SCOPE,
      managedSlotAcquisition: acquisition(async (config) => {
        configs.push(config);
        return readyResult(config);
      }),
      managedExecutionRelease: {
        releaseExecution: async (sessionId) => releaseResult(sessionId),
      },
      registry: {} as never,
      managedSlotJournal: {
        owner: OWNER,
        redriveSlot: async () => ({ kind: "clear", redriven: [] }),
      },
    });

    expect(
      await port.prepare(resource(ANDROID), { livenessOwnerToken: "consumer-liveness" }),
    ).toMatchObject({ profile: ANDROID.profile });
    expect(configs[0]?.requests[0]).toEqual({
      slotIndex: 7,
      role: "session-broker-device",
      platform: "android",
      requestedSpec: {
        runtime: ANDROID.profile.systemImagePackage,
        deviceType: ANDROID.profile.profileId,
      },
    });

    for (const profile of [
      { ...ANDROID.profile, apiLevel: 36 },
      { ...ANDROID.profile, abi: "x86_64" },
      { ...ANDROID.profile, flavor: "google_apis_playstore" },
    ]) {
      await expect(
        port.prepare(resource({ ...ANDROID, profile }), {
          livenessOwnerToken: "consumer-liveness",
        }),
      ).rejects.toThrow("does not agree with its exact system-image package");
    }
    expect(configs).toHaveLength(1);
  });

  test("rejects a non-ready acquisition and drains any session it returned", async () => {
    const releases: string[] = [];
    const port = new ManagedDevicePort({
      scope: SCOPE,
      managedSlotAcquisition: acquisition(async (config) =>
        readyResult(config, { readiness: { mode: "automation", status: "booted" } }),
      ),
      managedExecutionRelease: {
        releaseExecution: async (sessionId) => {
          releases.push(sessionId);
          return releaseResult(sessionId);
        },
      },
      registry: {} as never,
      managedSlotJournal: {
        owner: OWNER,
        redriveSlot: async () => ({ kind: "clear", redriven: [] }),
      },
    });

    await expect(
      port.prepare(resource(), { livenessOwnerToken: "consumer-liveness" }),
    ).rejects.toThrow("did not return an automation-ready session");
    expect(releases).toEqual(["session-1"]);
  });

  test("reports settled only for confirmed release with no bookkeeping failures", async () => {
    let result = releaseResult("session-1", {
      outcome: "cleanup_pending",
      settlement: "settling",
    });
    const port = new ManagedDevicePort({
      scope: SCOPE,
      managedSlotAcquisition: acquisition(async (config) => readyResult(config)),
      managedExecutionRelease: { releaseExecution: async () => result },
      registry: {} as never,
      managedSlotJournal: {
        owner: OWNER,
        redriveSlot: async () => ({ kind: "clear", redriven: [] }),
      },
    });

    expect(await port.release("session-1")).toEqual({ settled: false });
    result = releaseResult("session-1", {
      slotFailures: [{ scopeKey: SCOPE_KEY, slotIndex: 7, error: "registry busy" }],
    });
    expect(await port.release("session-1")).toEqual({ settled: false });
    result = releaseResult("session-1");
    expect(await port.release("session-1")).toEqual({ settled: true });
  });
});

interface DestructionRig {
  key: SlotKey;
  resource: BrokerResourceRecord;
  registry: FakeSlotRegistry;
  inventory: FakeInventory;
  deleter: FakeDeleter;
  journal: ManagedSlotJournal;
  isExecOwnerLive: SlotExecOwnerLiveness;
}

async function destructionRig(
  isExecOwnerLive: SlotExecOwnerLiveness = () => true,
): Promise<DestructionRig> {
  const timer = new FakeTimer();
  const registry = new FakeSlotRegistry(timer, isExecOwnerLive);
  const ensured = await registry.ensureScope(SCOPE);
  if (ensured.kind !== "ready") {
    throw new Error(`Scope setup failed: ${ensured.kind}`);
  }
  const key = { scopeKey: SCOPE_KEY, slotIndex: 7 };
  const requestedSpec = {
    runtime: IOS.profile.runtimeId,
    deviceType: IOS.profile.simulatorDeviceTypeIdentifier,
  };
  await registry.initSlot(key, {
    role: "session-broker-device",
    platform: "ios",
    requestedSpec,
  });
  const committed = await registry.commitBinding(
    key,
    { generation: 0, stableDeviceId: null },
    {
      stableDeviceId: "UDID-1",
      deviceName: "iPhone broker 1",
      resolvedSpec: requestedSpec,
      specFingerprint: "profile",
      state: "ready",
    },
  );
  if (committed.kind !== "committed") {
    throw new Error(`Binding setup failed: ${committed.kind}`);
  }
  const inventory = new FakeInventory();
  inventory.devices.push({
    name: "iPhone broker 1",
    deviceId: "UDID-1",
    platform: "ios",
    isRunning: false,
    runtime: IOS.profile.runtimeId,
    deviceType: IOS.profile.simulatorDeviceTypeIdentifier,
  });
  const deleter = new FakeDeleter(inventory);
  const journal = new ManagedSlotJournal({
    registry,
    inventory,
    matcher: new FakeMatcher(),
    deleter,
    claims: new FakeClaims(),
    timer,
    owner: OWNER,
    isOwnerLive: () => false,
    isExecOwnerLive,
  });
  return {
    key,
    resource: resource(IOS, "destroying"),
    registry,
    inventory,
    deleter,
    journal,
    isExecOwnerLive,
  };
}

function destroyingPort(
  rig: DestructionRig,
  releaseExecution: (sessionId: string) => Promise<ManagedExecutionReleaseResult>,
  registry: Pick<
    SlotRegistry,
    "getAssignment" | "listOpenSlotJournal" | "openSlotJournal"
  > = rig.registry,
): ManagedDevicePort {
  return new ManagedDevicePort({
    scope: SCOPE,
    managedSlotAcquisition: acquisition(async (config) => readyResult(config)),
    managedExecutionRelease: { releaseExecution },
    registry,
    managedSlotJournal: rig.journal,
    isExecOwnerLive: rig.isExecOwnerLive,
  });
}

describe("ManagedDevicePort clean-reset ownership", () => {
  async function resetRig(
    reset: NonNullable<ManagedDevicePortDependencies["resetIosBaseline"]>,
    current = true,
  ) {
    const rig = await destructionRig();
    const port = new ManagedDevicePort({
      scope: SCOPE,
      managedSlotAcquisition: acquisition(async (config) => readyResult(config)),
      managedExecutionRelease: { releaseExecution: async (id) => releaseResult(id) },
      registry: rig.registry,
      managedSlotJournal: rig.journal,
      resetIosBaseline: reset,
      isCurrentReset: async () => current,
    });
    return { ...rig, port, resource: { ...rig.resource, state: "resetting" as const } };
  }

  test("qualified reset is bound to the private native identity and async ownership scope", async () => {
    const rig = await resetRig(async (device, profile, assertOwned) => {
      expect(device.deviceId).toBe("UDID-1");
      expect(profile.runtimeId).toBe(IOS.profile.runtimeId);
      expect(currentManagedSlotReconciler()).toEqual({ scopeKey: SCOPE_KEY, slotIndex: 7 });
      await assertOwned();
      return "clean";
    });
    expect(await rig.port.reset(rig.resource)).toBe("clean");
  });

  test("a stale durable reset cannot invoke native cleanup", async () => {
    let called = false;
    const rig = await resetRig(async () => {
      called = true;
      return "clean";
    }, false);
    await expect(rig.port.reset(rig.resource)).rejects.toThrow("durable resource revision");
    expect(called).toBe(false);
  });

  test("a live execution prevents resetting its device", async () => {
    let called = false;
    const rig = await resetRig(async () => {
      called = true;
      return "clean";
    });
    const assignment = await rig.registry.getAssignment(rig.key);
    if (!assignment) {
      throw new Error("Missing binding");
    }
    await rig.registry.claimExecution(rig.key, assignment, {
      ...OWNER,
      sessionUuid: "next-session",
    });
    await expect(rig.port.reset(rig.resource)).rejects.toThrow("exclusive native binding");
    expect(called).toBe(false);
  });

  test("a changed native binding cannot be returned clean after reset", async () => {
    const rig = await resetRig(async () => {
      const previous = await rig.registry.getAssignment(rig.key);
      if (!previous) {
        throw new Error("Missing binding");
      }
      await rig.registry.commitBinding(rig.key, previous, {
        stableDeviceId: "UDID-2",
        deviceName: "replacement",
        resolvedSpec: previous.resolvedSpec,
        specFingerprint: previous.specFingerprint,
        state: "ready",
      });
      return "clean";
    });
    await expect(rig.port.reset(rig.resource)).rejects.toThrow("exclusive native binding");
  });
});

describe("ManagedDevicePort destruction", () => {
  test("drains its current execution before journaled deletion and confirms absence", async () => {
    const rig = await destructionRig();
    const claimed = await rig.registry.claimExecution(
      rig.key,
      { generation: 1, stableDeviceId: "UDID-1" },
      { ...OWNER, sessionUuid: "session-1" },
    );
    expect(claimed.kind).toBe("claimed");
    const calls: string[] = [];
    const port = destroyingPort(rig, async (sessionId) => {
      calls.push(sessionId);
      await rig.registry.releaseExecution(rig.key, sessionId);
      return releaseResult(sessionId);
    });

    expect(await port.destroy(rig.resource)).toBe("absent");
    expect(calls).toEqual(["session-1"]);
    expect(rig.deleter.stableIds()).toEqual(["UDID-1"]);
    expect(await rig.registry.getAssignment(rig.key)).toMatchObject({
      stableDeviceId: null,
      execOwner: null,
    });
    expect(await rig.registry.listOpenSlotJournal(rig.key)).toEqual([]);
  });

  test("keeps capacity pending when the execution drain is incomplete", async () => {
    const rig = await destructionRig();
    await rig.registry.claimExecution(
      rig.key,
      { generation: 1, stableDeviceId: "UDID-1" },
      { ...OWNER, sessionUuid: "session-1" },
    );
    const port = destroyingPort(rig, async (sessionId) =>
      releaseResult(sessionId, { outcome: "cleanup_pending", settlement: "settling" }),
    );

    expect(await port.destroy(rig.resource)).toBe("pending");
    expect(rig.deleter.calls).toEqual([]);
    expect(await rig.registry.getAssignment(rig.key)).toMatchObject({
      stableDeviceId: "UDID-1",
      execOwner: { sessionUuid: "session-1" },
    });
  });

  test("redrives an existing journal and preserves its binding after failed deletion", async () => {
    const rig = await destructionRig();
    rig.deleter.failWith = "simulator delete failed";
    const assignment = (await rig.registry.getAssignment(rig.key))!;
    const opened = await rig.registry.openSlotJournal(rig.key, {
      kind: "replace",
      phase: "deleting",
      owner: OWNER,
      target: {
        oldStableId: assignment.stableDeviceId,
        oldName: assignment.deviceName,
        newName: null,
        newStableId: null,
        requestedSpec: assignment.requestedSpec,
        resolvedSpec: assignment.resolvedSpec,
        specFingerprint: assignment.specFingerprint,
      },
      assignment: {
        kind: "state",
        expected: assignment,
        state: "replacing",
      },
    });
    if (opened.kind !== "opened") {
      throw new Error(`Journal setup failed: ${opened.kind}`);
    }
    const port = destroyingPort(rig, async (sessionId) => releaseResult(sessionId));

    expect(await port.destroy(rig.resource)).toBe("pending");
    expect(rig.deleter.stableIds()).toEqual(["UDID-1"]);
    expect(await rig.registry.getAssignment(rig.key)).toMatchObject({
      stableDeviceId: "UDID-1",
      state: "cleanup_pending",
    });
    expect(await rig.registry.listOpenSlotJournal(rig.key)).toMatchObject([
      { id: opened.entry.id, target: { oldStableId: "UDID-1" } },
    ]);
  });

  test("keeps a live or unknown foreign process owner pending without draining it", async () => {
    const rig = await destructionRig();
    await rig.registry.claimExecution(
      rig.key,
      { generation: 1, stableDeviceId: "UDID-1" },
      { ...FOREIGN_OWNER, sessionUuid: "foreign-session" },
    );
    const releases: string[] = [];
    const port = destroyingPort(rig, async (sessionId) => {
      releases.push(sessionId);
      return releaseResult(sessionId);
    });

    expect(await port.destroy(rig.resource)).toBe("pending");
    expect(releases).toEqual([]);
    expect(rig.deleter.calls).toEqual([]);
    expect(await rig.registry.getAssignment(rig.key)).toMatchObject({
      stableDeviceId: "UDID-1",
      execOwner: { daemonId: FOREIGN_OWNER.daemonId, sessionUuid: "foreign-session" },
    });
  });

  test("lets the registry and journal fence a definitively dead prior process owner", async () => {
    const rig = await destructionRig(() => false);
    await rig.registry.claimExecution(
      rig.key,
      { generation: 1, stableDeviceId: "UDID-1" },
      { ...FOREIGN_OWNER, sessionUuid: "dead-session" },
    );
    const releases: string[] = [];
    const port = destroyingPort(rig, async (sessionId) => {
      releases.push(sessionId);
      return releaseResult(sessionId);
    });

    expect(await port.destroy(rig.resource)).toBe("absent");
    expect(releases).toEqual([]);
    expect(rig.deleter.stableIds()).toEqual(["UDID-1"]);
    expect(await rig.registry.getAssignment(rig.key)).toMatchObject({
      stableDeviceId: null,
      execOwner: null,
    });
  });

  test("does not certify an empty binding while an owner or settler remains", async () => {
    const ownerRig = await destructionRig();
    const assignment = (await ownerRig.registry.getAssignment(ownerRig.key))!;
    const emptyWithOwner = {
      ...assignment,
      stableDeviceId: null,
      execOwner: { ...OWNER, sessionUuid: "leftover-session" },
    };
    const ownerView = {
      getAssignment: async () => emptyWithOwner,
      listOpenSlotJournal: ownerRig.registry.listOpenSlotJournal.bind(ownerRig.registry),
      openSlotJournal: ownerRig.registry.openSlotJournal.bind(ownerRig.registry),
    };
    expect(
      await destroyingPort(
        ownerRig,
        async (sessionId) => releaseResult(sessionId),
        ownerView,
      ).destroy(ownerRig.resource),
    ).toBe("pending");

    const settlerRig = await destructionRig();
    const current = (await settlerRig.registry.getAssignment(settlerRig.key))!;
    const emptied = await settlerRig.registry.commitBinding(settlerRig.key, current, {
      stableDeviceId: null,
      deviceName: null,
      resolvedSpec: null,
      specFingerprint: null,
      state: "ready",
    });
    if (emptied.kind !== "committed") {
      throw new Error(`Empty binding setup failed: ${emptied.kind}`);
    }
    await settlerRig.registry.updateSlotState(settlerRig.key, emptied.assignment, "settling", {
      settler: FOREIGN_OWNER,
    });
    expect(
      await destroyingPort(settlerRig, async (sessionId) => releaseResult(sessionId)).destroy(
        settlerRig.resource,
      ),
    ).toBe("pending");
  });

  test("a stale binding fence cannot delete the binding that replaced it", async () => {
    const rig = await destructionRig();
    let raced = false;
    const racingRegistry = {
      getAssignment: rig.registry.getAssignment.bind(rig.registry),
      listOpenSlotJournal: rig.registry.listOpenSlotJournal.bind(rig.registry),
      openSlotJournal: async (key: SlotKey, input: OpenSlotJournalInput) => {
        if (!raced) {
          raced = true;
          const current = (await rig.registry.getAssignment(key))!;
          await rig.registry.updateSlotState(
            key,
            { generation: current.generation, stableDeviceId: current.stableDeviceId },
            "settling",
            { settler: FOREIGN_OWNER },
          );
        }
        return rig.registry.openSlotJournal(key, input);
      },
    };
    const port = destroyingPort(rig, async (sessionId) => releaseResult(sessionId), racingRegistry);

    expect(await port.destroy(rig.resource)).toBe("pending");
    expect(rig.deleter.calls).toEqual([]);
    expect(await rig.registry.listOpenSlotJournal(rig.key)).toEqual([]);
    expect(await rig.registry.getAssignment(rig.key)).toMatchObject({
      generation: 2,
      stableDeviceId: "UDID-1",
      state: "settling",
    });
  });
});
