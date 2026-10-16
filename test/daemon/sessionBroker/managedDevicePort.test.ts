import { describe, expect, test } from "bun:test";
import type { BrokerExecutionReleaseResult } from "../../../src/daemon/sessionBroker/provisioning/executionRelease";
import type { BrokerDeviceAcquisition } from "../../../src/daemon/sessionBroker/provisioning/deviceAcquisition";
import { BindingJournal } from "../../../src/daemon/sessionBroker/registry/bindingJournal";
import {
  computeBindingScopeKey,
  type OpenBindingJournalInput,
  type BindingExecOwnerLiveness,
  type BindingJournalOwner,
  type BindingKey,
  type BindingRegistry,
  type BindingScopeIdentity,
} from "../../../src/daemon/sessionBroker/registry/bindingRegistry";
import { SessionBrokerFailureError } from "../../../src/daemon/sessionBroker/devicePort";
import { ManagedDevicePort } from "../../../src/daemon/sessionBroker/managedDevicePort";
import { currentBindingReconciler } from "../../../src/daemon/sessionBroker/provisioning/exclusion";
import type { ManagedDevicePortDependencies } from "../../../src/daemon/sessionBroker/managedDevicePort";
import type { BrokerResourceRecord } from "../../../src/daemon/sessionBroker/store";
import type { BrokerProvisionRequest } from "../../../src/daemon/sessionBroker/provisioning/provisionRequest";
import type { BindingsResult } from "../../../src/daemon/sessionBroker/provisioning/acquisitionResult";
import { FakeBindingRegistry } from "../../fakes/FakeBindingRegistry";
import { FakeTimer } from "../../fakes/FakeTimer";
import {
  FakeClaims,
  FakeDeleter,
  FakeInventory,
  FakeMatcher,
} from "./registry/fixtures/reconcilerFakes";

const SCOPE: BindingScopeIdentity = {
  managedHostScope: "broker-host",
  runnerNamespace: "private-session-broker",
  runnerIncarnation: "persistent-pool-v1",
};
const SCOPE_KEY = computeBindingScopeKey(SCOPE);
const OWNER: BindingJournalOwner = {
  daemonId: "broker-daemon",
  pid: 101,
  processGenerationToken: "broker-generation",
};
const FOREIGN_OWNER: BindingJournalOwner = {
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
  overrides: Partial<BrokerExecutionReleaseResult> = {},
): BrokerExecutionReleaseResult {
  return {
    sessionId,
    outcome: "reusable_for_this_binding",
    settlement: "confirmed",
    alreadyReleased: false,
    cancellationRequested: 0,
    releaseForced: false,
    device: "device-1",
    bindings: [],
    bindingFailures: [],
    ...overrides,
  };
}

function readyResult(
  config: BrokerProvisionRequest,
  overrides: Partial<BindingsResult["bindings"][number]> = {},
): BindingsResult {
  const request = config.requests[0]!;
  return {
    contractVersion: 1,
    scope: { ...SCOPE, scopeKey: SCOPE_KEY },
    outcome: "ready",
    bindings: [
      {
        bindingIndex: request.bindingIndex,
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
  run: (config: BrokerProvisionRequest) => Promise<BindingsResult>,
): Pick<BrokerDeviceAcquisition, "acquire"> {
  return { acquire: run };
}

describe("ManagedDevicePort preparation and release", () => {
  test.each(["result", "binding"] as const)(
    "preserves typed retryable acquisition failure from %s and releases its session",
    async (source) => {
      const failure = {
        code: "timeout" as const,
        retryable: true,
        message: "runner-setup timed out; retry acquisition",
        nextAction: "Retry acquisition",
      };
      const releases: string[] = [];
      const port = new ManagedDevicePort({
        scope: SCOPE,
        brokerDeviceAcquisition: acquisition((config) =>
          Promise.resolve({
            ...readyResult(config, { failure: source === "binding" ? failure : undefined }),
            outcome: "failed",
            ...(source === "result" ? { failure } : {}),
          }),
        ),
        brokerExecutionRelease: {
          releaseExecution: (id) => {
            releases.push(id);
            return Promise.resolve(releaseResult(id));
          },
        },
        registry: {} as never,
        bindingJournal: {
          owner: OWNER,
          redriveBinding: () => Promise.resolve({ kind: "clear", redriven: [] }),
        },
      });
      const rejected = port.prepare(resource(), { livenessOwnerToken: "consumer" });
      await expect(rejected).rejects.toBeInstanceOf(SessionBrokerFailureError);
      await expect(rejected).rejects.toMatchObject({
        failure: { code: "timeout", retryable: true, message: failure.message },
      });
      expect(releases).toEqual(["session-1"]);
    },
  );

  test("maps exact iOS native identifiers and private provider allocation options", async () => {
    let received: BrokerProvisionRequest | undefined;
    const port = new ManagedDevicePort({
      scope: SCOPE,
      brokerDeviceAcquisition: acquisition(async (config) => {
        received = config;
        return readyResult(config);
      }),
      brokerExecutionRelease: {
        releaseExecution: async (sessionId) => releaseResult(sessionId),
      },
      registry: {} as never,
      bindingJournal: {
        owner: OWNER,
        redriveBinding: async () => ({ kind: "clear", redriven: [] }),
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
      localBindingCapacity: 1,
      requests: [
        {
          bindingIndex: 7,
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
    const configs: BrokerProvisionRequest[] = [];
    const port = new ManagedDevicePort({
      scope: SCOPE,
      brokerDeviceAcquisition: acquisition(async (config) => {
        configs.push(config);
        return readyResult(config);
      }),
      brokerExecutionRelease: {
        releaseExecution: async (sessionId) => releaseResult(sessionId),
      },
      registry: {} as never,
      bindingJournal: {
        owner: OWNER,
        redriveBinding: async () => ({ kind: "clear", redriven: [] }),
      },
    });

    expect(
      await port.prepare(resource(ANDROID), { livenessOwnerToken: "consumer-liveness" }),
    ).toMatchObject({ profile: ANDROID.profile });
    expect(configs[0]?.requests[0]).toEqual({
      bindingIndex: 7,
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
      brokerDeviceAcquisition: acquisition(async (config) =>
        readyResult(config, { readiness: { mode: "automation", status: "booted" } }),
      ),
      brokerExecutionRelease: {
        releaseExecution: async (sessionId) => {
          releases.push(sessionId);
          return releaseResult(sessionId);
        },
      },
      registry: {} as never,
      bindingJournal: {
        owner: OWNER,
        redriveBinding: async () => ({ kind: "clear", redriven: [] }),
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
      brokerDeviceAcquisition: acquisition(async (config) => readyResult(config)),
      brokerExecutionRelease: { releaseExecution: async () => result },
      registry: {} as never,
      bindingJournal: {
        owner: OWNER,
        redriveBinding: async () => ({ kind: "clear", redriven: [] }),
      },
    });

    expect(await port.release("session-1")).toEqual({ settled: false });
    result = releaseResult("session-1", {
      bindingFailures: [{ scopeKey: SCOPE_KEY, bindingIndex: 7, error: "registry busy" }],
    });
    expect(await port.release("session-1")).toEqual({ settled: false });
    result = releaseResult("session-1");
    expect(await port.release("session-1")).toEqual({ settled: true });
  });
});

interface DestructionRig {
  key: BindingKey;
  resource: BrokerResourceRecord;
  registry: FakeBindingRegistry;
  inventory: FakeInventory;
  deleter: FakeDeleter;
  journal: BindingJournal;
  isExecOwnerLive: BindingExecOwnerLiveness;
}

async function destructionRig(
  isExecOwnerLive: BindingExecOwnerLiveness = () => true,
): Promise<DestructionRig> {
  const timer = new FakeTimer();
  const registry = new FakeBindingRegistry(timer, isExecOwnerLive);
  const ensured = await registry.ensureScope(SCOPE);
  if (ensured.kind !== "ready") {
    throw new Error(`Scope setup failed: ${ensured.kind}`);
  }
  const key = { scopeKey: SCOPE_KEY, bindingIndex: 7 };
  const requestedSpec = {
    runtime: IOS.profile.runtimeId,
    deviceType: IOS.profile.simulatorDeviceTypeIdentifier,
  };
  await registry.initBinding(key, {
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
  const journal = new BindingJournal({
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
  releaseExecution: (sessionId: string) => Promise<BrokerExecutionReleaseResult>,
  registry: Pick<
    BindingRegistry,
    "getAssignment" | "listOpenBindingJournal" | "openBindingJournal"
  > = rig.registry,
): ManagedDevicePort {
  return new ManagedDevicePort({
    scope: SCOPE,
    brokerDeviceAcquisition: acquisition(async (config) => readyResult(config)),
    brokerExecutionRelease: { releaseExecution },
    registry,
    bindingJournal: rig.journal,
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
      brokerDeviceAcquisition: acquisition(async (config) => readyResult(config)),
      brokerExecutionRelease: { releaseExecution: async (id) => releaseResult(id) },
      registry: rig.registry,
      bindingJournal: rig.journal,
      resetIosBaseline: reset,
      isCurrentReset: async () => current,
    });
    return { ...rig, port, resource: { ...rig.resource, state: "resetting" as const } };
  }

  test("qualified reset is bound to the private native identity and async ownership scope", async () => {
    const rig = await resetRig(async (device, profile, assertOwned) => {
      expect(device.deviceId).toBe("UDID-1");
      expect(profile.runtimeId).toBe(IOS.profile.runtimeId);
      expect(currentBindingReconciler()).toEqual({ scopeKey: SCOPE_KEY, bindingIndex: 7 });
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
    expect(await rig.registry.listOpenBindingJournal(rig.key)).toEqual([]);
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
    const opened = await rig.registry.openBindingJournal(rig.key, {
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
    expect(await rig.registry.listOpenBindingJournal(rig.key)).toMatchObject([
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
      listOpenBindingJournal: ownerRig.registry.listOpenBindingJournal.bind(ownerRig.registry),
      openBindingJournal: ownerRig.registry.openBindingJournal.bind(ownerRig.registry),
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
    await settlerRig.registry.updateBindingState(settlerRig.key, emptied.assignment, "settling", {
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
      listOpenBindingJournal: rig.registry.listOpenBindingJournal.bind(rig.registry),
      openBindingJournal: async (key: BindingKey, input: OpenBindingJournalInput) => {
        if (!raced) {
          raced = true;
          const current = (await rig.registry.getAssignment(key))!;
          await rig.registry.updateBindingState(
            key,
            { generation: current.generation, stableDeviceId: current.stableDeviceId },
            "settling",
            { settler: FOREIGN_OWNER },
          );
        }
        return rig.registry.openBindingJournal(key, input);
      },
    };
    const port = destroyingPort(rig, async (sessionId) => releaseResult(sessionId), racingRegistry);

    expect(await port.destroy(rig.resource)).toBe("pending");
    expect(rig.deleter.calls).toEqual([]);
    expect(await rig.registry.listOpenBindingJournal(rig.key)).toEqual([]);
    expect(await rig.registry.getAssignment(rig.key)).toMatchObject({
      generation: 2,
      stableDeviceId: "UDID-1",
      state: "settling",
    });
  });
});
