import { SessionBroker } from "../../../src/daemon/sessionBroker/broker";
import { openSqliteBindingRegistry } from "../../../src/daemon/sessionBroker/registry/sqliteBindingRegistry";
import { iosCatalog, iosDefaults } from "../../devices/sessionRequirements/fixtures";
import { FakeIdGenerator } from "../../fakes/FakeIdGenerator";
import {
  BindingReconciler,
  DefaultManagedSpecResolver,
  bindingDeviceName,
} from "../../../src/daemon/sessionBroker/provisioning/reconciler";
import { ProvisionDeviceError } from "../../../src/devices/exactDeviceProvisioning";
import { describe, expect, spyOn, test } from "bun:test";
import { logger } from "../../../src/utils/logger";
import type { BrokerExecutionReleaseResult } from "../../../src/daemon/sessionBroker/provisioning/executionRelease";
import { BrokerDeviceAcquisition } from "../../../src/daemon/sessionBroker/provisioning/deviceAcquisition";
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
import type {
  TaskLeaseKeepalive,
  TaskLeaseHoldRequest,
} from "../../../src/daemon/tasks/taskLeaseKeepalive";
import { FakeDeviceMutationJournal } from "../../fakes/FakeDeviceMutationJournal";
import { drainUntilQuiescent } from "../../helpers/fakeTimerStepping";
import type { DeviceMutationScope } from "../../../src/daemon/sessionBroker/mutations/types";
import {
  FakeClaims,
  FakeDeleter,
  FakeInventory,
  FakeMatcher,
  FakeProvisioner,
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
  } as const,
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

class RecordingLeaseKeepalive implements TaskLeaseKeepalive {
  readonly requests: TaskLeaseHoldRequest[] = [];
  held = false;
  releases = 0;

  hold(request: TaskLeaseHoldRequest): () => void {
    this.requests.push(request);
    this.held = true;
    return () => {
      this.held = false;
      this.releases++;
    };
  }
}

describe("ManagedDevicePort preparation and release", () => {
  test("does not hold a lease when acquisition throws before the session is ready", async () => {
    const leaseKeepalive = new RecordingLeaseKeepalive();
    const dependencies: ManagedDevicePortDependencies = {
      scope: SCOPE,
      timer: new FakeTimer(),
      leaseKeepalive,
      brokerDeviceAcquisition: acquisition(async () => {
        throw new Error("acquisition failed");
      }),
      brokerExecutionRelease: { releaseExecution: async (id) => releaseResult(id) },
      registry: new FakeBindingRegistry(new FakeTimer()),
      bindingJournal: {
        owner: OWNER,
        redriveBinding: async () => ({ kind: "clear", redriven: [] }),
      },
    };
    await expect(
      new ManagedDevicePort(dependencies).prepare(resource(), { livenessOwnerToken: "token" }),
    ).rejects.toThrow("acquisition failed");
    expect(leaseKeepalive.requests).toEqual([]);
    expect(leaseKeepalive.releases).toBe(0);
  });

  test.each(["success", "optional failure", "deadline failure"])(
    "holds the lease during Android baseline capture and releases after %s",
    async (outcome) => {
      const leaseKeepalive = new RecordingLeaseKeepalive();
      const timer = new FakeTimer();
      const captureError = new Error("snapshot save failed");
      let heldDuringCapture = false;
      const dependencies: ManagedDevicePortDependencies = {
        scope: SCOPE,
        timer,
        leaseKeepalive,
        brokerDeviceAcquisition: acquisition(async (config) => readyResult(config)),
        brokerExecutionRelease: { releaseExecution: async (id) => releaseResult(id) },
        registry: new FakeBindingRegistry(timer),
        bindingJournal: {
          owner: OWNER,
          redriveBinding: async () => ({ kind: "clear", redriven: [] }),
        },
        resetBaseline: {
          android: {
            canCapture: true,
            capture: async () => {
              heldDuringCapture = leaseKeepalive.held;
              if (outcome === "deadline failure") {
                timer.advanceTime(1000);
              }
              if (outcome !== "success") {
                throw captureError;
              }
            },
            forget: async () => {},
            reset: async () => "clean",
          },
        },
      };
      const warn = spyOn(logger, "warn").mockImplementation(() => {});
      try {
        const preparation = new ManagedDevicePort(dependencies).prepare(resource(ANDROID), {
          livenessOwnerToken: "token",
          preparationTimeoutMs: 1000,
        });
        if (outcome === "deadline failure") {
          await expect(preparation).rejects.toThrow("exceeded preparation deadline");
        } else {
          expect((await preparation).sessionId).toBe("session-1");
        }
        expect(heldDuringCapture).toBe(true);
        expect(leaseKeepalive.requests).toEqual([
          { taskId: "request-1", ownerKey: "session-broker", sessionUuid: "session-1" },
        ]);
        expect(leaseKeepalive.held).toBe(false);
        expect(leaseKeepalive.releases).toBe(1);
        if (outcome === "optional failure") {
          expect(warn).toHaveBeenCalledWith(
            expect.stringContaining(captureError.message),
            captureError,
          );
        }
      } finally {
        warn.mockRestore();
      }
    },
  );

  test("binds the exact broker mutation scope, shared with the iOS reset scope, before returning a ready session", async () => {
    const scopes: DeviceMutationScope[] = [];
    const port = new ManagedDevicePort({
      scope: SCOPE,
      timer: new FakeTimer(),
      brokerDeviceAcquisition: acquisition(async (config) => readyResult(config)),
      brokerExecutionRelease: { releaseExecution: async (id) => releaseResult(id) },
      registry: new FakeBindingRegistry(new FakeTimer()),
      bindingJournal: {
        owner: OWNER,
        redriveBinding: async () => ({ kind: "clear", redriven: [] }),
      },
      bindMutationRecorder: (scope) => {
        scopes.push(scope);
      },
    });
    expect(await port.prepare(resource(), { livenessOwnerToken: "consumer" })).toMatchObject({
      sessionId: "session-1",
    });
    expect(scopes).toEqual([
      {
        sessionUuid: "session-1",
        deviceId: "device-1",
        incarnation: JSON.stringify([SCOPE_KEY, 7, "device-1"]),
      },
    ]);
  });

  test("a mutation recorder binding failure warns and returns the ready session without releasing it", async () => {
    const releases: string[] = [];
    const port = new ManagedDevicePort({
      scope: SCOPE,
      timer: new FakeTimer(),
      brokerDeviceAcquisition: acquisition(async (config) => readyResult(config)),
      brokerExecutionRelease: {
        releaseExecution: async (id) => {
          releases.push(id);
          return releaseResult(id);
        },
      },
      registry: new FakeBindingRegistry(new FakeTimer()),
      bindingJournal: {
        owner: OWNER,
        redriveBinding: async () => ({ kind: "clear", redriven: [] }),
      },
      bindMutationRecorder: () => {
        throw new Error("missing live session");
      },
    });
    const warn = spyOn(logger, "warn").mockImplementation(() => {});
    try {
      expect(await port.prepare(resource(), { livenessOwnerToken: "consumer" })).toMatchObject({
        sessionId: "session-1",
      });
      expect(releases).toEqual([]);
      expect(warn).toHaveBeenCalledWith(
        "Failed to bind broker device mutation recorder; acquiring without recording",
        expect.objectContaining({ message: "missing live session" }),
      );
    } finally {
      warn.mockRestore();
    }
  });

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

  test("maps exact iOS native identifiers and hands the create retry reserve to provisioning", async () => {
    let received: BrokerProvisionRequest | undefined;
    // Provisioning alone decides adopt, reuse, or create, so prepare reads no binding first.
    const registry: ManagedDevicePortDependencies["registry"] = {
      getAssignment: async () => {
        throw new Error("Unexpected binding read");
      },
      listOpenBindingJournal: async () => [],
      openBindingJournal: async () => {
        throw new Error("Unexpected journal write");
      },
    };
    const port = new ManagedDevicePort({
      scope: SCOPE,
      timer: new FakeTimer(),
      brokerDeviceAcquisition: acquisition(async (config) => {
        received = config;
        return readyResult(config);
      }),
      brokerExecutionRelease: {
        releaseExecution: async (sessionId) => releaseResult(sessionId),
      },
      registry,
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
      createRetryReserveMs: 10_000,
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

  test("applies a requested manufacturer profile to the prepared session's device (#14058)", async () => {
    const applied: unknown[] = [];
    let routed = false;
    const port = new ManagedDevicePort({
      scope: SCOPE,
      brokerDeviceAcquisition: acquisition(async (config) => readyResult(config)),
      brokerExecutionRelease: { releaseExecution: async (sessionId) => releaseResult(sessionId) },
      registry: {} as never,
      bindingJournal: {
        owner: OWNER,
        redriveBinding: async () => ({ kind: "clear", redriven: [] }),
      },
      manufacturerProfileApplier: {
        apply: async (device, profile, sessionId) => {
          applied.push({ device, profile, sessionId });
          const summary = { id: profile.manufacturerProfile, version: 1, displayName: "Samsung" };
          return routed
            ? {
                message: "route",
                deviceId: device.deviceId,
                action: "apply",
                catalogVersion: 1,
                persona: summary,
                status: "route_to_real_device",
                capabilities: [],
              }
            : {
                message: "applied",
                deviceId: device.deviceId,
                action: "apply",
                catalogVersion: 1,
                persona: summary,
                status: "applied",
                facets: [],
                nonEmulatable: [],
              };
        },
      },
    });
    const deviceProfile = { manufacturerProfile: "samsung-oneui" } as const;

    await port.prepare(resource(ANDROID), { livenessOwnerToken: "token", deviceProfile });
    expect(applied).toEqual([
      {
        device: { platform: "android", name: "device-1", deviceId: "transport-1" },
        profile: deviceProfile,
        sessionId: "session-1",
      },
    ]);
    await port.prepare(resource(ANDROID), { livenessOwnerToken: "token" });
    expect(applied).toHaveLength(1);

    routed = true;
    await expect(
      port.prepare(resource(ANDROID), { livenessOwnerToken: "token", deviceProfile }),
    ).rejects.toThrow("route");
  });

  test("rejects a non-ready acquisition and drains any session it returned", async () => {
    const releases: string[] = [];
    const leaseKeepalive = new RecordingLeaseKeepalive();
    const port = new ManagedDevicePort({
      scope: SCOPE,
      leaseKeepalive,
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
    expect(leaseKeepalive.requests).toEqual([]);
    expect(leaseKeepalive.releases).toBe(0);
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
    reset: NonNullable<NonNullable<ManagedDevicePortDependencies["resetBaseline"]>["ios"]>,
    current = true,
  ) {
    const rig = await destructionRig();
    const port = new ManagedDevicePort({
      scope: SCOPE,
      brokerDeviceAcquisition: acquisition(async (config) => readyResult(config)),
      brokerExecutionRelease: { releaseExecution: async (id) => releaseResult(id) },
      registry: rig.registry,
      bindingJournal: rig.journal,
      resetBaseline: { ios: reset },
      isCurrentReset: async () => current,
    });
    return { ...rig, port, resource: { ...rig.resource, state: "resetting" as const } };
  }

  test("qualified reset is bound to the private native identity and async ownership scope", async () => {
    const rig = await resetRig(async (device, profile, assertOwned, _signal, context) => {
      expect(device.deviceId).toBe("UDID-1");
      expect(profile.runtimeId).toBe(IOS.profile.runtimeId);
      expect(currentBindingReconciler()).toEqual({ scopeKey: SCOPE_KEY, bindingIndex: 7 });
      expect(context?.resource.requestId).toBe("request-1");
      expect(context?.scope).toEqual({
        deviceId: "UDID-1",
        incarnation: JSON.stringify([SCOPE_KEY, 7, "UDID-1"]),
      });
      await assertOwned();
      return "clean";
    });
    expect(await rig.port.reset(rig.resource)).toBe("clean");
  });

  test("pool-entry baseline capture runs before exposing the owned execution session", async () => {
    const rig = await destructionRig();
    const leaseKeepalive = new RecordingLeaseKeepalive();
    const assignment = await rig.registry.getAssignment(rig.key);
    if (!assignment) {
      throw new Error("Missing binding");
    }
    await rig.registry.claimExecution(rig.key, assignment, { ...OWNER, sessionUuid: "session-1" });
    let captures = 0;
    const port = new ManagedDevicePort({
      scope: SCOPE,
      timer: new FakeTimer(),
      registry: rig.registry,
      bindingJournal: rig.journal,
      brokerDeviceAcquisition: acquisition(async (config) => readyResult(config)),
      brokerExecutionRelease: { releaseExecution: async (id) => releaseResult(id) },
      captureIosBaseline: async (context) => {
        expect(leaseKeepalive.held).toBe(true);
        await context.assertOwned();
        captures++;
        expect(context.scope).toEqual({
          deviceId: "UDID-1",
          incarnation: JSON.stringify([SCOPE_KEY, 7, "UDID-1"]),
          sessionUuid: "session-1",
        });
      },
      leaseKeepalive,
    });
    expect(
      (await port.prepare({ ...rig.resource, state: "reserved" }, { livenessOwnerToken: "token" }))
        .sessionId,
    ).toBe("session-1");
    expect(captures).toBe(1);
    expect(leaseKeepalive.requests).toEqual([
      { taskId: "request-1", ownerKey: "session-broker", sessionUuid: "session-1" },
    ]);
    expect(leaseKeepalive.held).toBe(false);
    expect(leaseKeepalive.releases).toBe(1);
  });

  test("a failed optional baseline capture does not release the acquired session", async () => {
    const rig = await destructionRig();
    const leaseKeepalive = new RecordingLeaseKeepalive();
    let heldDuringCapture = false;
    const assignment = await rig.registry.getAssignment(rig.key);
    if (!assignment) {
      throw new Error("Missing binding");
    }
    await rig.registry.claimExecution(rig.key, assignment, { ...OWNER, sessionUuid: "session-1" });
    let releases = 0;
    const port = new ManagedDevicePort({
      scope: SCOPE,
      timer: new FakeTimer(),
      registry: rig.registry,
      bindingJournal: rig.journal,
      brokerDeviceAcquisition: acquisition(async (config) => readyResult(config)),
      brokerExecutionRelease: {
        releaseExecution: async (id) => {
          releases++;
          return releaseResult(id);
        },
      },
      captureIosBaseline: async () => {
        heldDuringCapture = leaseKeepalive.held;
        throw new DOMException("inventory timed out", "TimeoutError");
      },
      leaseKeepalive,
    });
    expect(
      (
        await port.prepare(
          { ...rig.resource, state: "reserved" },
          { livenessOwnerToken: "owner-token" },
        )
      ).sessionId,
    ).toBe("session-1");
    expect(releases).toBe(0);
    expect(heldDuringCapture).toBe(true);
    expect(leaseKeepalive.held).toBe(false);
    expect(leaseKeepalive.releases).toBe(1);
  });

  test("the captured baseline survives a settling generation bump but not a replacement UDID", async () => {
    const rig = await destructionRig();
    const timer = new FakeTimer();
    const journal = new FakeDeviceMutationJournal(timer);
    const baseline = { completeKinds: ["installed-app"], observations: [], unobservable: [] };
    const assignment = (await rig.registry.getAssignment(rig.key))!;
    await rig.registry.claimExecution(rig.key, assignment, { ...OWNER, sessionUuid: "session-1" });
    let capturedIncarnation: string | undefined;
    let resets = 0;
    const port = new ManagedDevicePort({
      scope: SCOPE,
      timer,
      registry: rig.registry,
      bindingJournal: rig.journal,
      brokerDeviceAcquisition: acquisition(async (config) => readyResult(config)),
      brokerExecutionRelease: { releaseExecution: async (id) => releaseResult(id) },
      captureIosBaseline: async (context) => {
        await context.assertOwned();
        capturedIncarnation = context.scope.incarnation;
        await journal.captureBaseline(context.scope, baseline);
      },
      isCurrentReset: async () => true,
      resetBaseline: {
        ios: async (_device, _profile, assertOwned, _signal, context) => {
          await assertOwned();
          resets++;
          expect(await journal.getBaseline(context!.scope)).toEqual(resets === 1 ? baseline : null);
          expect(context!.scope.incarnation === capturedIncarnation).toBe(resets === 1);
          return "clean";
        },
      },
    });
    await port.prepare({ ...rig.resource, state: "reserved" }, { livenessOwnerToken: "token" });
    const fenced = await rig.registry.updateBindingState(rig.key, assignment, "settling", {
      settler: OWNER,
    });
    expect(fenced.kind).toBe("updated");
    if (fenced.kind !== "updated") {
      throw new Error("Missing settling fence");
    }
    expect(fenced.assignment.generation).toBe(assignment.generation + 1);
    await rig.registry.releaseExecution(rig.key, "session-1");
    await rig.registry.updateBindingState(rig.key, fenced.assignment, "ready");
    await port.reset({ ...rig.resource, state: "resetting" });
    const current = (await rig.registry.getAssignment(rig.key))!;
    await rig.registry.commitBinding(rig.key, current, {
      stableDeviceId: "UDID-2",
      deviceName: "iPhone broker 1",
      resolvedSpec: current.resolvedSpec,
      specFingerprint: current.specFingerprint,
      state: "ready",
    });
    await port.reset({ ...rig.resource, state: "resetting" });
    expect(resets).toBe(2);
  });

  test.each(["spent", "pending"] as const)(
    "iOS baseline capture honors a %s preparation budget and fences late writes",
    async (budget) => {
      const rig = await destructionRig();
      const timer = new FakeTimer();
      const assignment = (await rig.registry.getAssignment(rig.key))!;
      await rig.registry.claimExecution(rig.key, assignment, {
        ...OWNER,
        sessionUuid: "session-1",
      });
      const finishCapture = Promise.withResolvers<void>();
      let captureSignal: AbortSignal | undefined;
      let captures = 0;
      let writes = 0;
      const settled = Promise.withResolvers<void>();
      const port = new ManagedDevicePort({
        scope: SCOPE,
        timer,
        registry: rig.registry,
        bindingJournal: rig.journal,
        brokerDeviceAcquisition: acquisition(async (config) => {
          timer.advanceTime(budget === "spent" ? 50 : 20);
          return readyResult(config);
        }),
        brokerExecutionRelease: { releaseExecution: async (id) => releaseResult(id) },
        captureIosBaseline: async (context) => {
          captures++;
          captureSignal = context.signal;
          try {
            await finishCapture.promise;
            await context.assertOwned();
            writes++;
          } finally {
            settled.resolve();
          }
        },
      });
      const operation = port
        .prepare(
          { ...rig.resource, state: "reserved" },
          { livenessOwnerToken: "token", preparationTimeoutMs: 50 },
        )
        .then(
          () => undefined,
          (error: unknown) => error,
        );
      await drainUntilQuiescent(timer);
      if (budget === "pending") {
        expect(captures).toBe(1);
        timer.advanceTime(29);
        expect(captureSignal?.aborted).toBe(false);
        timer.advanceTime(1);
      }
      expect(await operation).toMatchObject({
        message: expect.stringContaining("exceeded preparation deadline"),
      });
      expect(captures).toBe(budget === "spent" ? 0 : 1);
      if (budget === "pending") {
        expect(captureSignal?.aborted).toBe(true);
        finishCapture.resolve();
        await settled.promise;
      }
      expect(writes).toBe(0);
    },
  );

  test("a stale durable reset cannot invoke native cleanup", async () => {
    let called = false;
    const rig = await resetRig(async () => {
      called = true;
      return "clean";
    }, false);
    await expect(rig.port.reset(rig.resource)).rejects.toThrow("durable resource revision");
    expect(called).toBe(false);
  });

  test("iOS reset preserves its structured outcome and phase timings", async () => {
    const outcome = {
      outcome: "fallback:erase" as const,
      mode: "erase" as const,
      phases: { erase: 17, boot: 23 },
      fallbackReason: "baseline contamination",
    };
    const rig = await resetRig(async (_device, _profile, assertOwned) => {
      await assertOwned();
      return outcome;
    });

    expect(await rig.port.reset(rig.resource)).toEqual(outcome);
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
  test("shutdown signal reaches the journal delete and settles without clearing ownership", async () => {
    const rig = await destructionRig();
    const entered = Promise.withResolvers<void>();
    let nativeSignal: AbortSignal | undefined;
    rig.deleter.beforeDelete = (target) =>
      new Promise<void>((_resolve, reject) => {
        nativeSignal = target.signal;
        target.signal?.addEventListener("abort", () => reject(target.signal?.reason), {
          once: true,
        });
        entered.resolve();
      });
    const port = destroyingPort(rig, async (id) => releaseResult(id));
    const controller = new AbortController();
    const reason = new Error("broker shutdown");
    const pending = port.destroy(rig.resource, controller.signal).catch((error: unknown) => error);
    await entered.promise;
    controller.abort(reason);
    expect(await pending).toBe(reason);
    expect(nativeSignal?.aborted).toBe(true);
    expect(rig.inventory.has("UDID-1")).toBe(true);
    expect(await rig.registry.listOpenBindingJournal(rig.key)).toHaveLength(1);
    expect(rig.deleter.calls).toHaveLength(1);
  });

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

describe("ManagedDevicePort retained creation cleanup", () => {
  test("destroying a resource cleans a created simulator retained after a retryable readiness deadline", async () => {
    const rig = await destructionRig();
    // The old assignment disappeared out of band; acquisition must create its replacement.
    rig.inventory.devices = [];
    const provisioner = new FakeProvisioner(rig.inventory);
    provisioner.beforeReturn = async (request) => {
      const device = rig.inventory.devices.find((candidate) => candidate.name === request.name)!;
      device.deviceId = "UDID-retained";
      throw new ProvisionDeviceError("timeout", "readiness deadline", true, {
        retainedDevice: { platform: "ios", stableId: device.deviceId!, name: device.name },
      });
    };
    const reconciler = new BindingReconciler({
      registry: rig.registry,
      inventory: rig.inventory,
      matcher: new FakeMatcher(),
      provisioner,
      deleter: rig.deleter,
      claims: new FakeClaims(),
      timer: new FakeTimer(),
      idGenerator: new FakeIdGenerator(),
      resolver: new DefaultManagedSpecResolver(),
      journal: { owner: OWNER, isOwnerLive: () => false },
    });
    expect(
      await reconciler.reconcile({
        key: rig.key,
        role: "session-broker-device",
        platform: "ios",
        requestedSpec: {
          runtime: IOS.profile.runtimeId,
          deviceType: IOS.profile.simulatorDeviceTypeIdentifier,
        },
        deadlineMs: 60_000,
      }),
    ).toMatchObject({ outcome: "failed", failure: { retryable: true } });
    expect(await rig.registry.listOpenBindingJournal(rig.key)).toMatchObject([
      {
        phase: "created",
        target: { newStableId: "UDID-retained" },
      },
    ]);
    expect(rig.deleter.calls).toEqual([]);
    // Exercise the existing destruction path used after release/expiry, with no retry first.
    const port = destroyingPort(rig, async (id) => releaseResult(id));
    expect(await port.destroy(rig.resource)).toBe("absent");
    expect(rig.inventory.devices).toEqual([]);
    expect(rig.deleter.stableIds()).toEqual(["UDID-retained"]);
    expect((await rig.registry.getAssignment(rig.key))?.stableDeviceId).toBeNull();
    expect(await rig.registry.listOpenBindingJournal(rig.key)).toEqual([]);
  });
});

describe("ManagedDevicePort retained readiness retries", () => {
  async function retryRig(registry: BindingRegistry, timer: FakeTimer) {
    await registry.ensureScope(SCOPE);
    const inventory = new FakeInventory();
    const provisioner = new FakeProvisioner(inventory);
    const deleter = new FakeDeleter(inventory);
    const claims = new FakeClaims();
    const reconciler = new BindingReconciler({
      registry,
      inventory,
      provisioner,
      deleter,
      claims,
      matcher: new FakeMatcher(),
      resolver: new DefaultManagedSpecResolver(),
      timer,
      idGenerator: new FakeIdGenerator(),
      journal: { owner: OWNER, isOwnerLive: () => false },
    });
    const journal = new BindingJournal({
      registry,
      inventory,
      deleter,
      claims,
      matcher: new FakeMatcher(),
      timer,
      owner: OWNER,
      isOwnerLive: () => false,
    });
    const budgets: number[] = [];
    const createDeadlines: (number | undefined)[] = [];
    const acquisitionPort = new BrokerDeviceAcquisition({
      registry: async () => registry,
      reconcile: async (_registry, request) => {
        budgets.push(request.deadlineMs);
        createDeadlines.push(request.createDeadlineMs);
        return reconciler.reconcile(request);
      },
      sessions: {
        claimLivenessOwnership: async () => "claimed",
        adoptManagedExecutionLivenessPolicy: async () => {},
        releaseSession: async () => {},
      },
      owner: () => OWNER,
      timer,
    });
    provisioner.beforeReturn = async (request) => {
      if (request.mode !== "create") {
        return;
      }
      const device = inventory.devices.find((candidate) => candidate.name === request.name)!;
      throw new ProvisionDeviceError("timeout", "readiness deadline", true, {
        retainedDevice: { platform: "ios", stableId: device.deviceId!, name: device.name },
      });
    };
    const port = new ManagedDevicePort({
      scope: SCOPE,
      timer,
      registry,
      bindingJournal: journal,
      brokerDeviceAcquisition: acquisitionPort,
      brokerExecutionRelease: { releaseExecution: async (id) => releaseResult(id) },
    });
    return { port, provisioner, inventory, deleter, budgets, createDeadlines };
  }

  test("prepare retries the created journal by adoption without creating or destroying another simulator", async () => {
    const timer = new FakeTimer();
    timer.enableAutoAdvance();
    const registry = new FakeBindingRegistry(timer);
    const rig = await retryRig(registry, timer);
    expect(
      await rig.port.prepare(resource(), {
        livenessOwnerToken: "consumer",
        preparationTimeoutMs: 1000,
      }),
    ).toMatchObject({ sessionId: "session-1" });
    expect(rig.provisioner.calls.map((call) => call.mode)).toEqual(["create", "adopt"]);
    expect(rig.provisioner.calls[1]?.deviceId).toBe("UDID-1");
    expect(rig.provisioner.created()).toHaveLength(1);
    expect(rig.deleter.calls).toEqual([]);
    // Only the create spends the retry reserve; the warm adoption retry gets the rest.
    expect(rig.provisioner.calls[0]!.deadlineMs).toBeLessThan(rig.provisioner.calls[1]!.deadlineMs);
    expect(rig.provisioner.calls[1]!.deadlineMs).toBe(1000);
    expect(await registry.listOpenBindingJournal({ scopeKey: SCOPE_KEY, bindingIndex: 7 })).toEqual(
      [],
    );
  });

  test("an empty binding that replaces a leftover simulator spends the create reserve (#14643, #14799)", async () => {
    const timer = new FakeTimer();
    timer.enableAutoAdvance();
    const rig = await retryRig(new FakeBindingRegistry(timer), timer);
    rig.inventory.devices.push({
      name: bindingDeviceName({ scopeKey: SCOPE_KEY, bindingIndex: 7 }, 1, "leftover"),
      platform: "ios",
      deviceId: "UDID-LEFTOVER",
      isRunning: false,
      runtime: IOS.profile.runtimeId,
      deviceType: IOS.profile.simulatorDeviceTypeIdentifier,
    });

    expect(
      await rig.port.prepare(resource(), {
        livenessOwnerToken: "consumer",
        preparationTimeoutMs: 900,
      }),
    ).toMatchObject({ sessionId: "session-1" });
    // A leftover is reclaimed by delete-and-recreate (#14799), so it is a create that holds back
    // the warm retry reserve; the leftover itself is never handed out unreset.
    expect(rig.provisioner.calls.map((call) => call.mode)).toEqual(["create", "adopt"]);
    expect(rig.provisioner.calls.map((call) => call.deviceId)).not.toContain("UDID-LEFTOVER");
    expect(rig.provisioner.calls[0]).toMatchObject({ mode: "create", deadlineMs: 600 });
    expect(rig.budgets).toEqual([900, 900]);
    expect(rig.createDeadlines).toEqual([600]);
    expect(rig.deleter.calls).toHaveLength(1);
    expect(timer.getPendingTimeoutCount()).toBe(0);
  });

  test.each([
    { timeoutMs: 900, firstDeadlineMs: 600 },
    { timeoutMs: 600_000, firstDeadlineMs: 420_000 },
  ])(
    "prepare reserves a warm retry after create consumes its entire attempt budget: %p",
    async ({ timeoutMs, firstDeadlineMs }) => {
      const timer = new FakeTimer();
      timer.enableAutoAdvance();
      const rig = await retryRig(new FakeBindingRegistry(timer), timer);
      const firstFailure = rig.provisioner.beforeReturn!;
      rig.provisioner.beforeReturn = async (request) => {
        if (request.mode === "create") {
          timer.advanceTime(request.deadlineMs - timer.now());
          return firstFailure(request);
        }
      };

      expect(
        await rig.port.prepare(resource(), {
          livenessOwnerToken: "consumer",
          preparationTimeoutMs: timeoutMs,
        }),
      ).toMatchObject({ sessionId: "session-1" });
      // Acquisition keeps the full deadline; only the create path stops at the reserve.
      expect(rig.budgets).toEqual([timeoutMs, timeoutMs]);
      expect(rig.createDeadlines).toEqual([firstDeadlineMs, undefined]);
      expect(rig.provisioner.calls.map((call) => call.deadlineMs)).toEqual([
        firstDeadlineMs,
        timeoutMs,
      ]);
      expect(rig.provisioner.calls.map((call) => call.mode)).toEqual(["create", "adopt"]);
      expect(rig.provisioner.calls[1]?.deviceId).toBe("UDID-1");
      expect(rig.provisioner.created()).toHaveLength(1);
      expect(rig.deleter.calls).toEqual([]);
      expect(timer.getPendingTimeoutCount()).toBe(0);
    },
  );

  test.each([
    "ready",
    "deadline",
    "overall-budget-exhausted",
    "warm-timeout",
    "retry-delay-deadline",
    "retry-delay-abort",
    "abort",
    "permanent",
  ] as const)("broker retained readiness retry: %s", async (outcome) => {
    const timer = new FakeTimer();
    timer.enableAutoAdvance();
    const registry = await openSqliteBindingRegistry({ dbPath: ":memory:", timer });
    const rig = await retryRig(registry, timer);
    const controller = new AbortController();
    const firstFailure = rig.provisioner.beforeReturn!;
    rig.provisioner.beforeReturn = async (request) => {
      if (request.mode === "create") {
        if (outcome === "overall-budget-exhausted") {
          // An overrun consumes the entire prepare budget, including its retry reserve.
          timer.advanceTime(1000);
        } else if (outcome === "retry-delay-deadline") {
          timer.advanceTime(990);
        } else if (outcome === "retry-delay-abort") {
          timer.setTimeout(() => controller.abort(), 10);
        }
        return firstFailure(request);
      }
      if (outcome === "deadline") {
        timer.advanceTime(1000);
        throw new ProvisionDeviceError("timeout", "warm readiness deadline");
      }
      if (outcome === "warm-timeout") {
        throw new ProvisionDeviceError("timeout", "warm readiness failed early");
      }
      if (outcome === "abort") {
        controller.abort();
        throw controller.signal.reason;
      }
      if (outcome === "permanent") {
        throw new ProvisionDeviceError("identity_conflict", "identity changed");
      }
    };
    const store = registry.sessionBrokerStore(SCOPE_KEY);
    const failed = spyOn(store, "fail");
    const destroy = spyOn(rig.port, "destroy");
    const broker = new SessionBroker({
      store,
      devices: rig.port,
      owner: OWNER,
      limits: { totalDeviceCap: 1, sessionCap: 1, idlePoolCap: 0 },
      catalog: async () => iosCatalog(),
      defaults: () => iosDefaults(),
    });
    try {
      const result = await broker.prepare(
        {
          contractVersion: 1,
          requestId: "retained-retry",
          preparationTimeoutMs: 1000,
          device: {
            schemaVersion: 1,
            platform: "ios",
            hardware: { kind: "omitted" },
            os: { kind: "omitted" },
          },
        },
        "consumer",
        controller.signal,
      );
      expect(result.outcome).toBe(outcome === "ready" ? "ready" : "failed");
      expect(rig.provisioner.created()).toHaveLength(1);
      expect(rig.provisioner.calls.map((call) => call.mode)).toEqual(
        ["overall-budget-exhausted", "retry-delay-deadline", "retry-delay-abort"].includes(outcome)
          ? ["create"]
          : ["create", "adopt"],
      );
      if (outcome === "ready") {
        expect(failed).not.toHaveBeenCalled();
        expect(destroy).not.toHaveBeenCalled();
        expect((await store.listResources()).map((entry) => entry.state)).toEqual(["active"]);
        expect(rig.deleter.calls).toEqual([]);
      } else {
        expect(failed).toHaveBeenCalledTimes(1);
        expect(destroy).toHaveBeenCalled();
        expect(rig.inventory.devices).toEqual([]);
        expect(rig.deleter.stableIds()).toEqual(["UDID-1"]);
        expect(result.cleanupPending).toBe(false);
        if (outcome === "retry-delay-abort") {
          expect(result.failure).toMatchObject({ code: "cancelled", retryable: true });
        }
        expect(await registry.listOpenBindingJournal()).toEqual([]);
      }
      expect(timer.getPendingTimeoutCount()).toBe(0);
    } finally {
      await broker.close();
      await registry.close();
    }
  });
});
