import { FakeVideoRecordingRepository } from "../../fakes/FakeVideoRecordingRepository";
import { WorkflowBindingDeviceDeleter } from "../../../src/daemon/sessionBroker/provisioning/deviceDeleter";
import { DaemonState } from "../../../src/daemon/daemonState";
import { SessionManager } from "../../../src/daemon/sessionManager";
import {
  registerDeviceTools,
  resetDeviceToolsDependencies,
  setDeviceToolsDependencies,
} from "../../../src/server/deviceTools";
import {
  resetVideoRecordingManagerDependencies,
  setVideoRecordingManagerDependencies,
} from "../../../src/daemon/videoRecordingManager";
import { DefaultEmulatorOfflineRecovery } from "../../../src/utils/android-cmdline-tools/EmulatorOfflineRecovery";
import { FakeAdbExecutor } from "../../fakes/FakeAdbExecutor";
import { FakeAdbClientFactory } from "../../fakes/FakeAdbClientFactory";
import { FakeAvdManager } from "../../fakes/FakeAvdManager";
import { FakeDeviceUtils } from "../../fakes/FakeDeviceUtils";
import { FakeDeviceSessionRepository } from "../../fakes/FakeDeviceSessionRepository";
import { FakeEmulatorProcessStopper } from "../../fakes/FakeEmulatorProcessStopper";
import { makePool } from "../../helpers/makePool";
import { isolateToolRegistry } from "../../helpers/withTemporaryTool";
import type { DeviceMutationScope } from "../../../src/daemon/sessionBroker/mutations/types";
import { afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { SessionBroker, type SessionBrokerOptions } from "../../../src/daemon/sessionBroker/broker";
import { createAndroidResetStrategy } from "../../../src/daemon/sessionBroker/service";
import {
  parseSessionBrokerHostConfig,
  type SessionBrokerHostConfig,
} from "../../../src/daemon/sessionBroker/hostConfig";
import { ManagedDevicePort } from "../../../src/daemon/sessionBroker/managedDevicePort";
import { AndroidSnapshotReset } from "../../../src/daemon/sessionBroker/androidSnapshotReset";
import { FakeAndroidSnapshotPort } from "./fixtures/androidSnapshotReset";
import {
  AndroidBaselineReset,
  watchAndroidResetSession,
} from "../../../src/daemon/sessionBroker/androidBaselineReset";
import { ExecutionTracker } from "../../../src/daemon/executionTracker";
import { AndroidKeepBootedReset } from "../../../src/daemon/sessionBroker/androidKeepBootedReset";
import { AndroidDeviceMutationResetPort } from "../../../src/daemon/sessionBroker/androidDeviceMutationResetPort";
import { DEVICE_MUTATION_KINDS } from "../../../src/daemon/sessionBroker/mutations/types";
import { FakeDeviceMutationJournal } from "../../fakes/FakeDeviceMutationJournal";
import { FakeAndroidKeepBootedResetPort } from "../../fakes/FakeAndroidKeepBootedResetPort";
import { createEpochReadCache } from "./fixtures/epochReadCache";
import { androidBaselineRig } from "./fixtures/androidMutationBaseline";
import { BindingJournal } from "../../../src/daemon/sessionBroker/registry/bindingJournal";
import {
  openSqliteBindingRegistry,
  type SqliteBindingRegistry,
} from "../../../src/daemon/sessionBroker/registry/sqliteBindingRegistry";
import { CountingIdGenerator } from "../../../src/utils/IdGenerator";
import type { SessionConfig } from "../../../src/devices/sessionConfig";
import { FakeTimer } from "../../fakes/FakeTimer";
import { androidCatalog, androidDefaults } from "../../devices/sessionRequirements/fixtures";
import {
  FakeClaims,
  FakeDeleter,
  FakeInventory,
  FakeMatcher,
} from "./registry/fixtures/reconcilerFakes";
import {
  ANDROID_RESET_DEVICE,
  ANDROID_RESET_PROFILE,
  FakeAndroidResetHost,
} from "./fixtures/androidReset";

isolateToolRegistry();

const OWNER = { daemonId: "android-broker", pid: 101, processGenerationToken: "generation-a" };
const SCOPE = {
  managedHostScope: "android-host",
  runnerNamespace: "broker",
  runnerIncarnation: "pool",
};

function config(requestId: string): SessionConfig {
  return {
    contractVersion: 1,
    requestId,
    device: {
      schemaVersion: 1,
      platform: "android",
      hardware: { kind: "omitted" },
      os: { kind: "omitted" },
    },
  };
}

describe("Android broker reset dispatch and recovery", () => {
  let registry: SqliteBindingRegistry;
  let broker: SessionBroker;
  let options: SessionBrokerOptions;
  let host: FakeAndroidResetHost;
  let deleter: FakeDeleter;
  let configured = true;
  let current = true;
  let creates: number;
  let timer: FakeTimer;
  let tracker: ExecutionTracker;
  let transportId: string;
  let deviceName: string;
  let recorderScopes: DeviceMutationScope[];
  let failRebind: boolean;
  let beforeProfile: (() => Promise<void>) | undefined;

  beforeAll(async () => {
    // beforeAll is outside the 100 ms per-test budget. Run the production keep-booted release path
    // on a throwaway broker (two passes: the first compiles, the second tiers up) so first-call
    // compilation is not charged to whichever test reaches it first. Every test still builds its
    // own registry, broker and adb rig.
    for (const pass of [1, 2]) {
      void pass;
      await setUp();
      useProductionKeepBooted();
      await broker.release(await ready());
      await broker.release(await ready("second"));
      await tearDown();
    }
  });

  beforeEach(setUp);

  afterEach(tearDown);

  async function setUp() {
    recorderScopes = [];
    failRebind = false;
    beforeProfile = undefined;
    configured = true;
    current = true;
    creates = 0;
    transportId = ANDROID_RESET_DEVICE.deviceId;
    deviceName = ANDROID_RESET_DEVICE.name;
    timer = new FakeTimer();
    // Ownership fences re-read the same rows hundreds of times per reset; see epochReadCache.
    const readCache = createEpochReadCache();
    registry = readCache.wrap(
      await openSqliteBindingRegistry({
        dbPath: ":memory:",
        isExecOwnerLive: () => false,
        timer,
      }),
      ["getAssignment", "listOpenBindingJournal"],
    );
    const scope = await registry.ensureScope(SCOPE);
    if (scope.kind !== "ready") {
      throw new Error("Missing scope");
    }
    const scopeKey = scope.scope.scopeKey;
    const store = readCache.wrap(
      registry.sessionBrokerStore(scopeKey, new CountingIdGenerator("resource")),
      ["getResource", "listResources"],
    );
    host = new FakeAndroidResetHost();
    host.timer = timer;
    tracker = new ExecutionTracker(timer, new CountingIdGenerator("execution"));
    host.watchSession = (sessionId: string) => watchAndroidResetSession(tracker, sessionId);
    host.strategy = {
      reset: async (_device, _packages, assertOwned) => {
        await assertOwned();
        return { outcome: "clean", mode: "none", phases: {} };
      },
    };
    const reset = new AndroidBaselineReset(host);
    const inventory = new FakeInventory();
    inventory.devices = [...host.devices];
    deleter = new FakeDeleter(inventory);
    const journal = new BindingJournal({
      registry,
      inventory,
      matcher: new FakeMatcher(),
      deleter,
      claims: new FakeClaims(),
      timer,
      owner: OWNER,
      isOwnerLive: () => false,
      isExecOwnerLive: () => false,
    });
    const sessionIds = new CountingIdGenerator("session");
    const port = new ManagedDevicePort({
      bindMutationRecorder: (scope) => {
        recorderScopes.push(scope);
        if (failRebind && JSON.parse(scope.incarnation)[2] !== null) {
          throw new Error("rebind unavailable");
        }
      },
      manufacturerProfileApplier: {
        apply: async (device, profile) => {
          await beforeProfile?.();
          return {
            status: "applied",
            message: "applied",
            deviceId: device.deviceId,
            action: "apply",
            catalogVersion: 1,
            persona: { id: profile.manufacturerProfile, version: 1, displayName: "Samsung" },
            facets: [],
            nonEmulatable: [],
          };
        },
      },
      scope: SCOPE,
      timer,
      registry,
      bindingJournal: journal,
      resetBaseline: {
        get android() {
          return configured ? reset : undefined;
        },
      },
      isCurrentReset: async (resource) => {
        const stored = await store.getResource(resource.resourceId);
        return current && stored?.state === "resetting" && stored.revision === resource.revision;
      },
      brokerDeviceAcquisition: {
        acquire: async (request) => {
          const spec = request.requests[0]!;
          const key = { scopeKey, bindingIndex: spec.bindingIndex };
          await registry.initBinding(key, {
            platform: "android",
            role: spec.role,
            requestedSpec: spec.requestedSpec,
          });
          let assignment = (await registry.getAssignment(key))!;
          if (!assignment.stableDeviceId) {
            creates++;
            const result = await registry.commitBinding(key, assignment, {
              stableDeviceId: ANDROID_RESET_DEVICE.name,
              deviceName,
              resolvedSpec: spec.requestedSpec,
              specFingerprint: "android-profile",
              state: "ready",
            });
            if (result.kind !== "committed") {
              throw new Error("Binding failed");
            }
            assignment = result.assignment;
          }
          const sessionId = sessionIds.next();
          const claimed = await registry.claimExecution(key, assignment, {
            ...OWNER,
            sessionUuid: sessionId,
          });
          if (claimed.kind !== "claimed") {
            throw new Error("Claim failed");
          }
          return {
            contractVersion: 1,
            scope: { ...SCOPE, scopeKey },
            outcome: "ready",
            bindings: [
              {
                bindingIndex: spec.bindingIndex,
                role: spec.role,
                platform: "android",
                assignmentGeneration: assignment.generation,
                device: {
                  stableId: ANDROID_RESET_DEVICE.name,
                  transportId,
                  name: deviceName,
                },
                sessionUuid: sessionId,
                requestedSpec: spec.requestedSpec,
                resolvedSpec: spec.requestedSpec,
                specFingerprint: { version: 1, hash: "android-profile" },
                disposition: "created",
                readiness: { mode: "automation", status: "automation_ready" },
                lifecycle: {},
              },
            ],
          };
        },
      },
      brokerExecutionRelease: {
        releaseExecution: async (sessionId) => {
          for (const assignment of await registry.findExecutionAssignments(sessionId)) {
            const marked = await registry.updateBindingState(assignment, assignment, "settling", {
              settler: OWNER,
            });
            if (marked.kind !== "updated") {
              throw new Error("Release mark failed");
            }
            expect(marked.assignment.generation).toBe(assignment.generation + 1);
            await registry.releaseExecution(assignment, sessionId);
            const restored = await registry.updateBindingState(
              assignment,
              marked.assignment,
              "ready",
            );
            if (restored.kind !== "updated") {
              throw new Error("Release settlement failed");
            }
          }
          return {
            sessionId,
            outcome: "reusable_for_this_binding",
            settlement: "confirmed",
            alreadyReleased: false,
            cancellationRequested: 0,
            releaseForced: false,
            device: ANDROID_RESET_DEVICE.deviceId,
            bindings: [],
            bindingFailures: [],
          };
        },
      },
    });
    options = {
      store,
      timer,
      devices: port,
      owner: OWNER,
      limits: { totalDeviceCap: 1, sessionCap: 1, idlePoolCap: 1 },
      catalog: async () => androidCatalog(),
      defaults: () => androidDefaults(),
      reuseCleanDevices: true,
      reuseAndroidCleanDevices: true,
    };
    broker = new SessionBroker(options);
  }

  async function tearDown() {
    resetDeviceToolsDependencies();
    resetVideoRecordingManagerDependencies();
    DaemonState.getInstance().reset();
    await broker.close();
    await registry.close();
  }

  function useProductionKeepBooted() {
    const { adb } = androidBaselineRig();
    host.strategy = new AndroidKeepBootedReset({
      journal: new FakeDeviceMutationJournal(timer),
      port: () => new AndroidDeviceMutationResetPort(adb, timer),
      timer,
    });
    return adb;
  }

  async function ready(requestId = "first") {
    const result = await broker.prepare(config(requestId), "owner-token");
    expect(result.outcome).toBe("ready");
    if (!result.sessionUuid) {
      throw new Error(JSON.stringify(result));
    }
    return result.sessionUuid;
  }

  test.each([false, true])(
    "Android capture rebinds before profile application (binding failure tolerated=%s)",
    async (bindingFails) => {
      failRebind = bindingFails;
      const journal = new FakeDeviceMutationJournal(timer);
      const port = new FakeAndroidKeepBootedResetPort({
        completeKinds: [...DEVICE_MUTATION_KINDS],
        observations: [],
        unobservable: [],
      });
      host.strategy = new AndroidKeepBootedReset({ journal, timer, port: () => port });
      let applied = false;
      beforeProfile = async () => {
        applied = true;
        expect(recorderScopes).toHaveLength(2);
        const [initial, rebound] = recorderScopes;
        expect(JSON.parse(initial.incarnation)[2]).toBeNull();
        expect(JSON.parse(rebound.incarnation)[2]).toBe(host.bootId);
        expect(await journal.getBaseline(rebound)).not.toBeNull();
      };
      const request = config("profile");
      if (request.device.platform !== "android") {
        throw new Error("Expected Android request");
      }
      request.device.deviceProfile = { manufacturerProfile: "samsung-oneui" };
      const result = await broker.prepare(request, "owner-token");
      expect(result.outcome).toBe("ready");
      expect(applied).toBe(true);
      expect(await broker.release(result.sessionUuid!)).toMatchObject({
        timing: { reset: { outcome: "clean" } },
      });
    },
  );

  test("the port forwards its reset signal to the Android baseline reset", async () => {
    const session = await ready();
    const reached = Promise.withResolvers<void>();
    const resume = Promise.withResolvers<void>();
    let strategySignal: AbortSignal | undefined;
    host.strategy = {
      reset: async (_device, _packages, assertOwned, context) => {
        strategySignal = context.signal;
        reached.resolve();
        await resume.promise;
        await assertOwned();
        return { outcome: "clean", mode: "none", phases: {} };
      },
    };
    await options.store.beginRelease(session, OWNER);
    expect((await options.devices.release(session)).settled).toBe(true);
    const resource = (await options.store.listResources())[0]!;
    const controller = new AbortController();
    const reset = options.devices.reset!(resource, controller.signal);
    await reached.promise;
    controller.abort(new Error("release cancelled"));
    // The strategy's signal aborts with the caller's, not only once the port's fence notices.
    expect(strategySignal?.aborted).toBe(true);
    resume.resolve();
    await expect(reset).rejects.toThrow("release cancelled");
  });

  test("qualified injected Android strategy reuses the same AVD without creation", async () => {
    const first = await ready();
    expect(await broker.release(first)).toMatchObject({ outcome: "released" });
    expect((await options.store.listResources())[0]!.state).toBe("idle");
    expect(await ready("second")).not.toBe(first);
    expect(creates).toBe(1);
    expect(deleter.calls).toHaveLength(0);
  });

  test("production keep-booted cleaner publishes idle and reuses despite incomplete certification", async () => {
    const adb = useProductionKeepBooted();
    const first = await ready();
    expect(await broker.release(first)).toMatchObject({
      outcome: "released",
      timing: {
        reset: {
          outcome: "clean",
          mode: "keep-booted",
          phases: { journal: 0, clean: 0, health: 0 },
        },
      },
    });
    expect((await options.store.listResources())[0]!.state).toBe("idle");
    const second = await ready("second");
    expect(second).not.toBe(first);
    expect(await broker.release(second)).toMatchObject({
      outcome: "released",
      timing: { reset: { outcome: "clean", mode: "keep-booted" } },
    });
    expect((await options.store.listResources())[0]!.state).toBe("idle");
    expect(creates).toBe(1);
    expect(deleter.calls).toHaveLength(0);
    expect(adb.getExecutedCommands()).toContain("shell cmd clipboard clear");
  });

  test("rebooting a retained AVD invalidates the original baseline even with the same serial and name", async () => {
    useProductionKeepBooted();
    const first = await ready();
    await broker.release(first);
    host.bootId = "87654321-1234-1234-1234-123456789abc";
    const second = await ready("second");
    await broker.release(second);
    expect((await options.store.listResources())[0]!.state).toBe("destroyed");
    expect(deleter.calls).toHaveLength(1);
  });

  test("Android reset without a strategy fails before native inventory or adb", async () => {
    host.strategy = undefined;
    const reset = new AndroidBaselineReset(host);
    await expect(
      reset.reset("resource", ANDROID_RESET_DEVICE, ANDROID_RESET_PROFILE, {
        assertOwned: async () => {},
      }),
    ).rejects.toThrow("cannot prove restoration of unobservable state");
    expect(host.inventoryCalls).toBe(0);
    expect(host.commands).toEqual([]);
  });

  test.each(["snapshot", "wipe-data"] as const)(
    "Android %s reuse keeps reset timings when iOS reuse is disabled",
    async (mode) => {
      await broker.close();
      broker = new SessionBroker({ ...options, reuseCleanDevices: false });
      const snapshotPort = new FakeAndroidSnapshotPort();
      host.timer = timer;
      host.strategy = new AndroidSnapshotReset(snapshotPort, timer, {
        prepareForIncarnationChange: async () => {},
        invalidate: async () => {},
        settleIncarnationChange: async () => {},
      });
      const first = await ready();
      if (mode === "wipe-data") {
        snapshotPort.failures.add("load");
      }
      snapshotPort.onStep = async () => {
        timer.advanceTime(7);
      };
      const totalMs = mode === "snapshot" ? 35 : 70;

      expect(await broker.release(first)).toMatchObject({
        outcome: "released",
        timing: {
          acquisition: { admission: "create", outcome: "ready" },
          reset: {
            outcome: mode === "snapshot" ? "clean" : "fallback:wipe-data",
            mode,
            phases: { reset: totalMs, load: 7 },
            totalMs,
            ...(mode === "wipe-data" ? { fallbackReason: "load failed" } : {}),
          },
        },
      });
      expect(await broker.stats()).toMatchObject({
        groups: [{ fallbackRate: mode === "wipe-data" ? 1 : 0 }],
      });
      expect((await options.store.listResources())[0]!.state).toBe("idle");
      expect(await broker.prepare(config("second"), "owner-token")).toMatchObject({
        outcome: "ready",
        timing: { acquisition: { admission: "reuse", reuseCount: 1, createMs: 0, bootMs: 0 } },
      });
      expect(creates).toBe(1);
    },
  );

  test("baseline capture honors abort and preparation deadline before adb", async () => {
    const reset = new AndroidBaselineReset(host);
    const controller = new AbortController();
    host.onInventory = () => controller.abort(new Error("prepare cancelled"));
    await expect(
      reset.capture("resource", ANDROID_RESET_DEVICE, ANDROID_RESET_PROFILE, {
        sessionId: "session",
        stableDeviceId: "stable-avd",
        signal: controller.signal,
        timer,
      }),
    ).rejects.toThrow();
    expect(host.lastInventorySignal?.aborted).toBe(true);
    expect(host.commands).toEqual([]);

    host.onInventory = () => timer.advanceTime(11);
    await expect(
      reset.capture("resource", ANDROID_RESET_DEVICE, ANDROID_RESET_PROFILE, {
        sessionId: "session",
        stableDeviceId: "stable-avd",
        timeoutMs: 10,
        timer,
      }),
    ).rejects.toThrow("preparation deadline");
    expect(host.commands).toEqual([]);
  });

  test("does not capture or natively reset Android without a strategy", async () => {
    host.strategy = undefined;
    const session = await ready();
    expect(host.inventoryCalls).toBe(0);
    expect(host.commands).toEqual([]);
    const receipt = await broker.release(session);
    expect(receipt.outcome).toBe("released");
    expect(receipt.timing?.reset?.fallbackReason).toBe(
      "Android reset is destruction-only: no androidResetMode reset strategy is configured",
    );
    expect(receipt.timing?.reset?.fallbackReason).not.toContain("transport identity");
    expect(host.inventoryCalls).toBe(0);
    expect(host.commands).toEqual([]);
    expect((await options.store.listResources())[0]!.state).toBe("destroyed");
  });

  test("serial-like acquired name reports the avdName identity mismatch", async () => {
    deviceName = "emulator-5554";
    host.devices[0]!.name = deviceName;
    const session = await ready();
    const receipt = await broker.release(session);
    expect(receipt.outcome).toBe("released");
    expect((await options.store.listResources())[0]!.state).toBe("destroyed");
    expect(receipt.timing?.reset?.fallbackReason).toContain("mismatched: avdName");
  });

  test.each([
    { label: "omitted", mode: undefined, fallback: undefined, fails: false, destroyed: true },
    {
      label: "keep-booted",
      mode: "keep-booted",
      fallback: undefined,
      fails: false,
      destroyed: false,
    },
    { label: "snapshot", mode: "snapshot", fallback: undefined, fails: false, destroyed: false },
    {
      label: "snapshot fallback",
      mode: "keep-booted",
      fallback: "snapshot",
      fails: false,
      destroyed: false,
    },
    {
      label: "failed snapshot fallback",
      mode: "keep-booted",
      fallback: "snapshot",
      fails: true,
      destroyed: true,
    },
  ] as const)("production factory dispatches $label configuration", async (scenario) => {
    const cfg: SessionBrokerHostConfig = parseSessionBrokerHostConfig({
      contractVersion: 1,
      limits: {},
      defaults: { android: androidDefaults() },
      reuseAndroidCleanDevices: true,
      androidResetMode: scenario.mode,
      androidKeepBootedFallback: scenario.fallback,
    });
    const { adb } = androidBaselineRig();
    const snapshotPort = new FakeAndroidSnapshotPort();
    const snapshot =
      cfg.androidResetMode === "snapshot" || cfg.androidKeepBootedFallback === "snapshot"
        ? new AndroidSnapshotReset(snapshotPort, timer, {
            prepareForIncarnationChange: async () => {},
            invalidate: async () => {},
            settleIncarnationChange: async () => {},
          })
        : undefined;
    const fakePort = new FakeAndroidKeepBootedResetPort({
      completeKinds: [...DEVICE_MUTATION_KINDS],
      observations: [],
      unobservable: [],
    });
    fakePort.beforeClean = async () => {
      throw new Error("hard cleaning failure");
    };
    host.timer = timer;
    host.strategy = createAndroidResetStrategy(cfg, {
      journal: new FakeDeviceMutationJournal(timer),
      timer,
      snapshot,
      port: () =>
        cfg.androidKeepBootedFallback === "snapshot"
          ? fakePort
          : new AndroidDeviceMutationResetPort(adb, timer),
    });
    if (cfg.androidResetMode === undefined) {
      expect(host.strategy).toBeUndefined();
    }
    const session = await ready();
    if (scenario.fails) {
      snapshotPort.failures.add("load");
      snapshotPort.failures.add("launch");
    }
    const receipt = await broker.release(session);
    expect(receipt.outcome).toBe("released");
    expect((await options.store.listResources())[0]!.state).toBe(
      scenario.destroyed ? "destroyed" : "idle",
    );
    expect(creates).toBe(1);
    expect(deleter.calls).toHaveLength(scenario.destroyed ? 1 : 0);
    if (cfg.androidResetMode === undefined) {
      expect(receipt.timing?.reset?.fallbackReason).toBe(
        "Android reset is destruction-only: no androidResetMode reset strategy is configured",
      );
    } else if (!scenario.destroyed) {
      expect(receipt.timing?.reset).toMatchObject({
        outcome: scenario.fallback ? "fallback:snapshot" : "clean",
        mode: scenario.fallback ?? scenario.mode,
      });
    }
    if (scenario.fallback) {
      expect(snapshotPort.calls).toContain("load");
    }
    if (scenario.fails) {
      expect(snapshotPort.calls).toContain("launch");
    }
  });

  test("hard cleaning followed by failed snapshot and wipe-data reset destroys the resource", async () => {
    const port = new FakeAndroidKeepBootedResetPort({
      completeKinds: [...DEVICE_MUTATION_KINDS],
      observations: [],
      unobservable: [],
    });
    port.beforeClean = async () => {
      throw new Error("hard cleaning failure");
    };
    const snapshotPort = new FakeAndroidSnapshotPort();
    snapshotPort.failures.add("load");
    snapshotPort.failures.add("launch");
    const fallback = new AndroidSnapshotReset(snapshotPort, timer, {
      prepareForIncarnationChange: async () => {},
      invalidate: async () => {},
      settleIncarnationChange: async () => {},
    });
    host.strategy = new AndroidKeepBootedReset({
      journal: new FakeDeviceMutationJournal(timer),
      port: () => port,
      timer,
      fallback,
    });
    const session = await ready();
    expect(await broker.release(session)).toMatchObject({ outcome: "released" });
    expect(snapshotPort.calls).toContain("load");
    expect(snapshotPort.calls).toContain("launch");
    expect((await options.store.listResources())[0]!.state).toBe("destroyed");
    expect(deleter.calls).toHaveLength(1);
  });

  test.each(["hard-cleaning-failure", "maxUses-retirement", "failed-fallback"])(
    "keep-booted %s destroys and never publishes idle",
    async (failure) => {
      const port = new FakeAndroidKeepBootedResetPort({
        completeKinds: [...DEVICE_MUTATION_KINDS],
        observations: [],
        unobservable: ["clipboard"],
      });
      if (failure === "hard-cleaning-failure") {
        port.beforeClean = async () => {
          throw new Error("adb cleaner failed");
        };
      }
      host.strategy = new AndroidKeepBootedReset({
        journal: new FakeDeviceMutationJournal(timer),
        port: () => port,
        timer,
        maxUses: failure === "hard-cleaning-failure" ? 20 : 1,
        fallback:
          failure === "failed-fallback"
            ? {
                reset: async () => {
                  throw new Error("snapshot failed");
                },
              }
            : undefined,
      });
      const session = await ready();
      expect(await broker.release(session)).toMatchObject({ outcome: "released" });
      expect((await options.store.listResources())[0]!.state).toBe("destroyed");
      expect(deleter.calls).toHaveLength(1);
    },
  );

  test.each(["packages", "unobservable", "ios-only-opt-in"])(
    "%s destroys instead of pooling",
    async (failure) => {
      if (failure === "ios-only-opt-in") {
        await broker.close();
        broker = new SessionBroker({ ...options, reuseAndroidCleanDevices: false });
      }
      const session = await ready();
      if (failure === "packages") {
        host.installed.add("com.example.session");
      }
      if (failure === "unobservable") {
        host.strategy = undefined;
      }
      expect(await broker.release(session)).toMatchObject({ outcome: "released" });
      expect((await options.store.listResources())[0]!.state).toBe("destroyed");
      expect(host.commands.some((command) => command.startsWith("uninstall"))).toBe(false);
      expect(deleter.calls).toHaveLength(1);
    },
  );

  test.each([
    "missing-transport",
    "adb-connect",
    "boot",
    "package-manager",
    "getprop-timeout",
    "pm-timeout",
  ])("%s capture failure preserves acquisition and destroys on release", async (failure) => {
    if (failure === "missing-transport") {
      transportId = "";
    }
    if (failure === "adb-connect") {
      transportId = "127.0.0.1:5555";
    }
    if (failure === "boot") {
      host.booted = false;
    }
    if (failure === "package-manager") {
      host.packageManager = false;
    }
    if (failure === "getprop-timeout") {
      host.failCommand = "shell getprop sys.boot_completed";
    }
    if (failure === "pm-timeout") {
      host.failCommand = "shell pm list packages -3";
    }
    const session = await ready();
    host.booted = true;
    host.packageManager = true;
    host.failCommand = undefined;
    const receipt = await broker.release(session);
    expect(receipt.outcome).toBe("released");
    if (failure === "missing-transport") {
      expect(receipt.timing?.reset?.fallbackReason).toBe(
        "Android reset baseline was not captured at acquisition",
      );
    }
    expect((await options.store.listResources())[0]!.state).toBe("destroyed");
    expect(deleter.calls).toHaveLength(1);
  });

  test.each([
    "unconfigured",
    "ownership",
    "serial",
    "image",
    "health",
    "mutations",
    "generation",
    "post-health-ownership",
  ])("%s reset failure destroys rather than pooling the Android emulator", async (failure) => {
    if (failure === "unconfigured") {
      configured = false;
    }
    const session = await ready();
    if (failure === "ownership") {
      current = false;
    }
    if (failure === "serial") {
      host.devices[0]!.deviceId = "emulator-5556";
    }
    if (failure === "image") {
      host.devices[0]!.runtimeId = "system-images;android-36;google_apis;arm64-v8a";
    }
    if (failure === "health") {
      host.healthy = false;
      host.resetTimeoutMs = 8000;
      host.onHealth = () => timer.advanceTime(2000);
    }
    if (failure === "mutations") {
      const execution = tracker.startExecution("tap", undefined, session);
      tracker.markSessionAdmitted(execution.id);
      tracker.endExecution(execution.id);
    }
    if (failure === "generation") {
      const resource = (await options.store.listResources())[0]!;
      const key = { scopeKey: resource.scopeKey, bindingIndex: resource.allocationIndex };
      const assignment = (await registry.getAssignment(key))!;
      await registry.commitBinding(key, assignment, {
        stableDeviceId: assignment.stableDeviceId,
        deviceName: assignment.deviceName,
        resolvedSpec: assignment.resolvedSpec,
        specFingerprint: assignment.specFingerprint,
        state: "ready",
      });
    }
    if (failure === "post-health-ownership") {
      host.onHealth = () => {
        current = false;
      };
    }
    expect(await broker.release(session)).toMatchObject({ outcome: "released" });
    expect((await options.store.listResources())[0]!.state).toBe("destroyed");
    expect(deleter.calls).toHaveLength(1);
  });

  test("restart while resetting destroys the uncertain Android emulator without resuming reset", async () => {
    const session = await ready();
    await options.store.beginRelease(session, OWNER);
    expect((await options.store.listResources())[0]!.state).toBe("resetting");
    const interrupted = broker;
    broker = new SessionBroker({
      ...options,
      owner: { ...OWNER, daemonId: "successor", processGenerationToken: "generation-b" },
    });
    await broker.recover();
    expect((await options.store.listResources())[0]!.state).toBe("destroyed");
    expect(host.commands.some((command) => command.startsWith("uninstall"))).toBe(false);
    expect(deleter.calls).toHaveLength(1);
    await interrupted.close();
  });

  test("unproven stop keeps the release cleanup_pending until verified deletion", async () => {
    const snapshotPort = new FakeAndroidSnapshotPort();
    snapshotPort.failures.add("load");
    snapshotPort.failures.add("stop");
    host.strategy = new AndroidSnapshotReset(snapshotPort, timer, {
      prepareForIncarnationChange: async () => {},
      invalidate: async () => {},
      settleIncarnationChange: async () => {},
    });
    const manager = new FakeDeviceUtils();
    const avdManager = new FakeAvdManager();
    const stopper = new FakeEmulatorProcessStopper();
    const adb = new FakeAdbExecutor();
    const runtime = { platform: "android" as const, name: deviceName, deviceId: transportId };
    const image = { platform: "android" as const, name: deviceName, isRunning: false };
    stopper.avdCandidates = [
      { pid: 4242, command: `qemu-system-aarch64 -avd ${deviceName} -port 5554` },
    ];
    adb.setDeviceStates([{ deviceId: transportId, state: "offline" }]);
    const recovery = new DefaultEmulatorOfflineRecovery({
      timer: () => timer,
      adbFactory: () => new FakeAdbClientFactory(adb),
    });
    manager.getAndroidListedDeviceStates = (serials, probeOptions) =>
      recovery.getListedNonDeviceStatesAmong(serials, probeOptions);
    manager.setDeviceImages("android", [image]);
    avdManager.setListDeviceImagesResponse([{ name: deviceName }]);
    const destroy = manager.destroyDevice.bind(manager);
    // Bridge the fake platform's native deletion to the fake AVD store; all workflow guards,
    // ownership retirement, absence verification, journal redrive and receipts are production.
    manager.destroyDevice = async (device, destroyOptions) => {
      await avdManager.deleteAvd(device.name);
      avdManager.setListDeviceImagesResponse([]);
      await destroy(device, destroyOptions);
    };
    const repository = new FakeDeviceSessionRepository();
    const sessions = new SessionManager(timer, repository);
    const pool = makePool(sessions, "daemon-session", {
      timer,
      deviceManager: manager,
      deviceSessionRepository: repository,
    });
    await pool.addDevice(runtime, image);
    DaemonState.getInstance().initialize(sessions, pool);
    await setVideoRecordingManagerDependencies({
      videoRecorderService: {} as never,
      recordingRepository: new FakeVideoRecordingRepository(),
      configRepository: {} as never,
      highlightClient: {} as never,
      timer,
    });
    setDeviceToolsDependencies({
      timer,
      deviceManagerFactory: () => manager,
      avdManagerFactory: () => avdManager,
      androidEmulatorProcessStopper: stopper,
      notifyResourcesChanged: async () => {},
      clearInstalledAppsForDevice: async () => {},
    });
    registerDeviceTools();
    const workflow = new WorkflowBindingDeviceDeleter(timer);
    deleter.deleteAndVerifyAbsence = (target) => workflow.deleteAndVerifyAbsence(target);
    const session = await ready();
    const release = await broker.release(session);
    expect(snapshotPort.calls).toContain("stop");
    expect(release).toMatchObject({ outcome: "cleanup_pending" });
    expect(release.timing?.reset?.outcome).toBe("pending");
    expect(release.timing?.reset?.retired).not.toBe(true);
    expect((await options.store.listResources())[0]!.state).toBe("destroying");
    timer.advanceTime(60_000);
    await broker.recover();
    expect((await options.store.listResources())[0]!.state).toBe("destroying");
    expect(avdManager.getDeleteAvdCalls()).toHaveLength(0);
    expect(pool.getDevice(transportId)).not.toBeNull();
    expect(stopper.describeAvdCalls[0]?.[0]).toBe(deviceName);
    stopper.avdCandidates = [];
    adb.setDeviceStates([]);
    timer.advanceTime(60_000);
    await broker.recover();
    expect((await options.store.listResources())[0]!.state).toBe("destroyed");
    expect(avdManager.getDeleteAvdCalls()).toEqual([{ name: deviceName }]);
    expect(pool.getDevice(transportId)).toBeNull();
    expect(await broker.status("first")).toMatchObject({ cleanupPending: false });
  });

  test("failed reset with transient deletion failure remains cleanup_pending until journal redrive", async () => {
    const session = await ready();
    host.healthy = false;
    host.resetTimeoutMs = 8000;
    host.onHealth = () => timer.advanceTime(2000);
    deleter.failWith = "temporary native deletion failure";
    expect(await broker.release(session)).toMatchObject({ outcome: "cleanup_pending" });
    expect((await options.store.listResources())[0]!.state).toBe("destroying");
    deleter.failWith = undefined;
    timer.advanceTime(60_000);
    await broker.recover();
    expect((await options.store.listResources())[0]!.state).toBe("destroyed");
    expect(await broker.status("first")).toMatchObject({ cleanupPending: false });
  });
});
