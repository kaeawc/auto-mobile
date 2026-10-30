import { afterAll, afterEach, beforeEach, describe, expect, test } from "bun:test";
import { isolateToolRegistry } from "../../../helpers/withTemporaryTool";
import { getDaemonDeviceDeletion } from "../../../../src/daemon/daemonDeviceDeletion";
import { isTeardownFailure } from "../../../../src/features/deviceLifecycle/deviceLifecycleCore";
import { ActionableError } from "../../../../src/models/ActionableError";
import { createDevicePoolDependencies } from "../../../helpers/devicePoolDependencies";
import {
  registerDeviceTools,
  resetDeviceToolsDependencies,
  setDeviceToolsDependencies,
} from "../../../../src/server/deviceTools";
import { clearDirectSessionDevices } from "../../../../src/utils/directSessionDeviceRegistry";
import { ToolRegistry } from "../../../../src/server/toolRegistry";
import { DaemonState } from "../../../../src/daemon/daemonState";
import { DevicePool } from "../../../../src/daemon/devicePool";
import { SessionManager } from "../../../../src/daemon/sessionManager";
import type { BootedDevice } from "../../../../src/models";
import { CountingIdGenerator } from "../../../../src/utils/IdGenerator";
import { WatchSimulatorInventory } from "../../../../src/utils/ios-cmdline-tools/WatchSimulatorInventory";
import { WatchSimulatorLifecycle } from "../../../../src/utils/ios-cmdline-tools/WatchSimulatorLifecycle";
import { WatchSimulatorProvisioner } from "../../../../src/utils/ios-cmdline-tools/WatchSimulatorProvisioner";
import type { AppleDeviceType } from "../../../../src/utils/ios-cmdline-tools/SimCtlSupport";
import { InMemoryVirtualDeviceLifecycleCoordinator } from "../../../../src/devices/virtualDeviceLifecycleCoordinator";
import {
  assertBootCapacityAvailable,
  reserveBootCapacity,
} from "../../../../src/features/bootAdmission/sharedBootAdmissionGates";
import {
  BindingReconciler,
  DefaultManagedSpecMatcher,
  DefaultManagedSpecResolver,
  type BindingReconcileRequest,
} from "../../../../src/daemon/sessionBroker/provisioning/reconciler";
import { DeviceManagerBindingInventory } from "../../../../src/daemon/sessionBroker/provisioning/DeviceManagerBindingInventory";
import { GateBindingBootCapacity } from "../../../../src/daemon/sessionBroker/provisioning/GateBindingBootCapacity";
import { PoolBindingDeviceClaims } from "../../../../src/daemon/sessionBroker/provisioning/PoolBindingDeviceClaims";
import { ToolBindingProvisioner } from "../../../../src/daemon/sessionBroker/provisioning/reconcilerPorts";
import { WorkflowBindingDeviceDeleter } from "../../../../src/daemon/sessionBroker/provisioning/deviceDeleter";
import { RegistryBindingResourceBudget } from "../../../../src/daemon/sessionBroker/provisioning/resourceBudget";
import type { BindingKey } from "../../../../src/daemon/sessionBroker/registry/bindingRegistry";
import { FakeBindingRegistry } from "../../../fakes/FakeBindingRegistry";
import { FakeDeviceSessionPersistence } from "../../../fakes/FakeDeviceSessionPersistence";
import { FakeDeviceUtils } from "../../../fakes/FakeDeviceUtils";
import { FakeIdGenerator } from "../../../fakes/FakeIdGenerator";
import { FakeTimer } from "../../../fakes/FakeTimer";
import {
  FakeWatchProvisionSimctl,
  WATCH_DEVICE_TYPE,
  WATCH_RUNTIME_ID,
} from "../../../fakes/FakeWatchSimctl";

isolateToolRegistry();

// A broker watch binding end to end over the real watch modules (#15882): the reconciler, the
// provisionDevice watch path, the watch provisioner/lifecycle and the daemon's watch delete, all
// over one stateful simctl fake.

const SPEC = { runtime: WATCH_RUNTIME_ID, deviceType: WATCH_DEVICE_TYPE.identifier };
const ULTRA: AppleDeviceType = {
  ...WATCH_DEVICE_TYPE,
  identifier: "com.apple.CoreSimulator.SimDeviceType.Apple-Watch-Ultra-2-49mm",
  name: "Apple Watch Ultra 2 (49mm)",
  modelIdentifier: "Watch7,5",
};
const ULTRA_SPEC = { runtime: WATCH_RUNTIME_ID, deviceType: ULTRA.identifier };
const IPHONE_SPEC = {
  runtime: "com.apple.CoreSimulator.SimRuntime.iOS-18-6",
  deviceType: "com.apple.CoreSimulator.SimDeviceType.iPhone-16",
};

describe("broker watch bindings over the real watch modules", () => {
  const env: Record<string, string | undefined> = { AUTOMOBILE_DEVICE_POOL_AUTOLOCK: "0" };
  let restoreEnv: (() => void) | undefined;
  let sessionManager: SessionManager | undefined;

  const cleanup = () => {
    restoreEnv?.();
    restoreEnv = undefined;
    resetDeviceToolsDependencies();
    clearDirectSessionDevices();
    DaemonState.getInstance().reset();
    sessionManager?.stopCleanupTimer();
    sessionManager = undefined;
  };
  beforeEach(cleanup);
  afterEach(cleanup);
  afterAll(cleanup);

  async function arrange({ limit }: { limit?: number } = {}) {
    restoreEnv = ToolRegistry.setPipelineOverridesForTesting({ env });
    const simctl = new FakeWatchProvisionSimctl([]);
    simctl.deviceTypes.push(ULTRA);
    const watches = new WatchSimulatorInventory(simctl, "arm64");
    const deviceUtils = new FakeDeviceUtils();
    const publishBootedWatches = () =>
      deviceUtils.setBootedDevices(
        "watchos",
        Object.values(simctl.listing.devices)
          .flat()
          .filter((device) => device.state === "Booted" && device.name !== "iPhone 16")
          .map((device): BootedDevice => ({
            name: device.name,
            platform: "watchos",
            deviceId: device.udid,
          })),
      );
    publishBootedWatches();
    simctl.onStateChange = publishBootedWatches;
    deviceUtils.killDevice = async (device) => {
      await new WatchSimulatorLifecycle(simctl, watches).shutdown(device);
    };
    const timer = new FakeTimer();
    sessionManager = new SessionManager(timer, new FakeDeviceSessionPersistence());
    const pool = new DevicePool(
      createDevicePoolDependencies(sessionManager, "daemon-session", {
        env,
        timer,
        deviceManager: deviceUtils,
      }),
    );
    await pool.initializeWithDevices([]);
    DaemonState.getInstance().initialize(sessionManager, pool);
    const runnerCalls: string[] = [];
    /** Every gate a watch boot or capacity question reached, in order. */
    const gates: string[] = [];
    setDeviceToolsDependencies({
      lifecycleCoordinator: new InMemoryVirtualDeviceLifecycleCoordinator(timer),
      env,
      timer,
      deviceManagerFactory: () => deviceUtils,
      idGenerator: new CountingIdGenerator("session"),
      notifyResourcesChanged: async () => {},
      notifyDeviceInventoryResourcesChanged: async () => {},
      syncInstalledAppResourceRegistry: async () => false,
      ensureCtrlProxyReady: async (request) => {
        runnerCalls.push(request.device.deviceId);
        throw new Error("a watch binding must never prepare an automation runner");
      },
      // The simulator boot admission, as the iOS gate's instrumentation runs it.
      watchSimulatorLifecycleFactory: () =>
        new WatchSimulatorLifecycle(simctl, watches, {
          run: async (request, boot) => {
            gates.push(`ios-boot:${request.udid}`);
            return await boot(request.timeoutMs);
          },
        }),
      watchSimulatorProvisionerFactory: () => new WatchSimulatorProvisioner(watches, simctl),
    });
    registerDeviceTools();

    const registry = new FakeBindingRegistry(timer, () => false);
    const scope = await registry.ensureScope({
      managedHostScope: "host",
      runnerNamespace: "ns",
      runnerIncarnation: "inc",
    });
    if (scope.kind !== "ready") {
      throw new Error("scope setup failed");
    }
    const key = (bindingIndex: number): BindingKey => ({
      scopeKey: scope.scope.scopeKey,
      bindingIndex,
    });
    const toolCalls: Array<Record<string, unknown>> = [];
    const releaseSession = async (sessionUuid: string) => {
      const pooled = pool.getAllDevices().find((device) => device.sessionId === sessionUuid);
      if (pooled) {
        await pool.releaseDevice(pooled.id, sessionUuid);
      }
    };
    const inventory = new DeviceManagerBindingInventory(
      { listDeviceImages: async () => [] },
      watches,
    );
    const capacity = new GateBindingBootCapacity(
      timer,
      (platform, signal) =>
        assertBootCapacityAvailable(
          platform,
          { signal },
          {
            ios: { assertCapacityAvailable: async () => void gates.push(`ios-check:${platform}`) },
            android: {
              assertCapacityAvailable: async () => void gates.push(`android-check:${platform}`),
            },
          },
        ),
      (platform, options) =>
        reserveBootCapacity(platform, options, {
          ios: {
            reserveBoot: async (reserved) => {
              gates.push(`ios-reserve:${reserved.replacingDeviceId ?? "none"}`);
              return {
                run: (operation) => operation(),
                release: () => {},
                markReplacedDeviceGone: () => {},
              };
            },
          },
        }),
    );
    const reconciler = new BindingReconciler({
      registry,
      inventory,
      matcher: new DefaultManagedSpecMatcher({
        readConfig: async () => {
          throw new Error("a watch has no AVD config");
        },
      }),
      resolver: new DefaultManagedSpecResolver(undefined, { watchCatalog: watches }),
      provisioner: new ToolBindingProvisioner({
        invokeTool: async (name, args, signal) => {
          toolCalls.push({ name, ...args });
          return await ToolRegistry.getTool(name)!.handler(args, undefined, signal);
        },
        deviceManager: { listDeviceImages: async () => [] },
        androidConfigReader: { readConfig: async () => null },
        timer,
        releaseSession,
      }),
      deleter: new WorkflowBindingDeviceDeleter(timer),
      claims: new PoolBindingDeviceClaims(pool),
      capacity,
      ...(limit === undefined
        ? {}
        : {
            resourceBudget: new RegistryBindingResourceBudget({
              registry: async () => registry,
              policy: { limit: () => limit },
              inventory,
              timer,
            }),
          }),
      timer,
      idGenerator: new FakeIdGenerator(),
      isExecOwnerLive: () => false,
    });
    const request = (
      bindingIndex: number,
      requestedSpec: BindingReconcileRequest["requestedSpec"] = SPEC,
      platform: BindingReconcileRequest["platform"] = "watchos",
    ): BindingReconcileRequest => ({
      key: key(bindingIndex),
      role: "app",
      platform,
      requestedSpec,
      deadlineMs: timer.now() + 60_000,
    });
    return {
      simctl,
      pool,
      reconciler,
      request,
      registry,
      key,
      gates,
      runnerCalls,
      toolCalls,
      releaseSession,
    };
  }

  /** Each simctl command as its verb and target (create also logs type/runtime, boot a timeout). */
  const commandVerbs = (simctl: FakeWatchProvisionSimctl) =>
    simctl.commands.map((command) => command.split(" ").slice(0, 2).join(" "));

  const listedWatches = (simctl: FakeWatchProvisionSimctl) =>
    Object.values(simctl.listing.devices)
      .flat()
      .filter((device) => device.name !== "iPhone 16");

  test("creates an unpaired ambroker- watch from the exact spec, booted through the simulator gate, ready at booted", async () => {
    const { simctl, reconciler, request, gates, runnerCalls, toolCalls } = await arrange();

    const result = await reconciler.reconcile(request(0));

    expect(result).toMatchObject({
      outcome: "ready",
      disposition: "created",
      readiness: { mode: "none", status: "device_ready" },
      resolvedSpec: { ...SPEC, displayCutout: "unknown" },
    });
    if (result.outcome !== "ready") {
      throw new Error("not ready");
    }
    expect(result.device.name.startsWith("ambroker-")).toBe(true);
    expect(result.sessionUuid.length).toBeGreaterThan(0);
    const [watch] = listedWatches(simctl);
    expect(watch).toMatchObject({
      udid: result.device.stableId,
      name: result.device.name,
      state: "Booted",
      deviceTypeIdentifier: SPEC.deviceType,
    });
    // Created fresh with simctl create under the binding's name: never cloned, never paired.
    expect(commandVerbs(simctl)).toEqual([`create ${result.device.name}`, `boot ${watch!.udid}`]);
    expect(gates).toEqual(["ios-check:watchos", `ios-boot:${watch!.udid}`]);
    expect(runnerCalls).toEqual([]);
    expect(toolCalls).toEqual([
      {
        name: "provisionDevice",
        device: { platform: "watchos", name: result.device.name, spec: SPEC },
        boot: true,
        readiness: "none",
        timeoutMs: expect.any(Number),
      },
    ]);
  });

  test("the next execution reuses the booted watch with a fresh session, ending the previous one, as for an iPhone", async () => {
    const { simctl, reconciler, request, gates, toolCalls } = await arrange();
    const first = await reconciler.reconcile(request(0));
    if (first.outcome !== "ready") {
      throw new Error("first acquisition failed");
    }
    simctl.commands.length = 0;
    gates.length = 0;

    const second = await reconciler.reconcile(request(0));

    expect(second).toMatchObject({
      outcome: "ready",
      disposition: "reused",
      device: { stableId: first.device.stableId, name: first.device.name },
      readiness: { mode: "none", status: "device_ready" },
      // The earlier execution's leftover session is ended, never handed to this one.
      evidence: { releasedStaleSessions: [first.sessionUuid] },
    });
    if (second.outcome !== "ready") {
      throw new Error("reuse failed");
    }
    expect(second.sessionUuid).not.toBe(first.sessionUuid);
    // Kept booted between executions: no create, shutdown, erase or delete, and no new boot.
    expect(simctl.commands).toEqual([]);
    expect(gates).toEqual([]);
    expect(listedWatches(simctl)).toHaveLength(1);
    expect(toolCalls.at(-1)).toMatchObject({
      device: { platform: "watchos", name: first.device.name, deviceId: first.device.stableId },
      readiness: "none",
    });
  });

  test("a different device type replaces the watch: verified deletion, then a fresh create", async () => {
    const { simctl, reconciler, request, gates, releaseSession } = await arrange();
    const first = await reconciler.reconcile(request(0));
    if (first.outcome !== "ready") {
      throw new Error("first acquisition failed");
    }
    await releaseSession(first.sessionUuid);
    simctl.commands.length = 0;
    gates.length = 0;

    const replaced = await reconciler.reconcile(request(0, ULTRA_SPEC));

    expect(replaced).toMatchObject({ outcome: "ready", disposition: "replaced" });
    if (replaced.outcome !== "ready") {
      throw new Error("replacement failed");
    }
    const old = first.device.stableId;
    expect(commandVerbs(simctl)).toEqual([
      `shutdown ${old}`,
      `delete ${old}`,
      `create ${replaced.device.name}`,
      `boot ${replaced.device.stableId}`,
    ]);
    // The replacement's slot is reserved on the simulator gate against the old watch's UDID.
    expect(gates).toEqual([`ios-reserve:${old}`, `ios-boot:${replaced.device.stableId}`]);
    expect(listedWatches(simctl).map((watch) => watch.deviceTypeIdentifier)).toEqual([
      ULTRA.identifier,
    ]);
  });

  test("a watch still shutting down holds its simulator slot, so its replacement reserves against it", async () => {
    const { simctl, reconciler, request, gates, releaseSession } = await arrange();
    const first = await reconciler.reconcile(request(0));
    if (first.outcome !== "ready") {
      throw new Error("first acquisition failed");
    }
    await releaseSession(first.sessionUuid);
    listedWatches(simctl)[0]!.state = "Shutting Down";
    simctl.onStateChange?.();
    gates.length = 0;

    const replaced = await reconciler.reconcile(request(0, ULTRA_SPEC));

    expect(replaced).toMatchObject({ outcome: "ready", disposition: "replaced" });
    expect(gates[0]).toBe(`ios-reserve:${first.device.stableId}`);
  });

  test("an unknown runtime or device type is refused before any native work, naming what is installed", async () => {
    const { simctl, reconciler, request, registry, key } = await arrange();

    const runtime = await reconciler.reconcile(
      request(0, { ...SPEC, runtime: "com.apple.CoreSimulator.SimRuntime.watchOS-99-0" }),
    );
    const deviceType = await reconciler.reconcile(
      request(0, { ...SPEC, deviceType: "com.apple.CoreSimulator.SimDeviceType.iPhone-16" }),
    );

    expect(runtime).toMatchObject({
      outcome: "failed",
      failure: { code: "spec_unsupported", retryable: false },
    });
    expect(runtime.outcome === "failed" && runtime.failure.message).toContain(WATCH_RUNTIME_ID);
    expect(deviceType).toMatchObject({ outcome: "failed", failure: { code: "spec_unsupported" } });
    expect(deviceType.outcome === "failed" && deviceType.failure.message).toContain(
      ULTRA.identifier,
    );
    expect(simctl.commands).toEqual([]);
    expect(await registry.getAssignment(key(0))).toBeNull();
  });

  test("a failed watch delete is reported and keeps the watch for cleanup, never read as absent", async () => {
    const { simctl, reconciler, request, releaseSession, registry, key } = await arrange();
    const first = await reconciler.reconcile(request(0));
    if (first.outcome !== "ready") {
      throw new Error("first acquisition failed");
    }
    await releaseSession(first.sessionUuid);
    simctl.deleteError = new Error("simctl delete: device is busy");

    const replaced = await reconciler.reconcile(request(0, ULTRA_SPEC));

    expect(replaced).toMatchObject({ outcome: "failed", failure: { retryable: true } });
    expect(replaced.outcome === "failed" && replaced.failure.message).toContain(
      "simctl delete: device is busy",
    );
    expect(listedWatches(simctl).map((watch) => watch.udid)).toEqual([first.device.stableId]);
    expect(await registry.getAssignment(key(0))).toMatchObject({
      stableDeviceId: first.device.stableId,
      state: "cleanup_pending",
    });
  });

  test("the daemon's watch delete reports a thrown failure as a failed teardown, never as deleted", async () => {
    const { simctl, reconciler, request } = await arrange();
    const first = await reconciler.reconcile(request(0));
    if (first.outcome !== "ready") {
      throw new Error("first acquisition failed");
    }
    simctl.listingError = Object.assign(new ActionableError("simctl list failed"), {
      code: "simctl_unavailable",
    });

    const response = await getDaemonDeviceDeletion()!({
      target: { platform: "watchos", isVirtual: true, stableId: first.device.stableId },
      mode: "destroy",
      verifyAbsence: true,
    });

    expect(isTeardownFailure(response)).toBe(true);
    expect(response.content[0]?.text).toContain("simctl list failed");
    simctl.listingError = undefined;
    expect(listedWatches(simctl).map((watch) => watch.udid)).toEqual([first.device.stableId]);
  });

  test("a watch binding counts against the shared device limit from creation through release", async () => {
    const { reconciler, request, releaseSession } = await arrange({ limit: 1 });
    const watch = await reconciler.reconcile(request(0));
    if (watch.outcome !== "ready") {
      throw new Error("watch acquisition failed");
    }

    const whileHeld = await reconciler.reconcile(request(1));
    await releaseSession(watch.sessionUuid);
    const afterRelease = await reconciler.reconcile(request(2, IPHONE_SPEC, "ios"));

    expect(whileHeld).toMatchObject({
      outcome: "failed",
      failure: { code: "binding_budget_exhausted" },
    });
    // A released watch stays assigned to its binding, so it still holds its share of the limit.
    expect(afterRelease).toMatchObject({
      outcome: "failed",
      failure: { code: "binding_budget_exhausted" },
    });
  });
});
