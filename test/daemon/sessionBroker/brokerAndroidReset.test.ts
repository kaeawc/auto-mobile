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

async function buildHarness() {
  const state = {
    configured: true,
    current: true,
    creates: 0,
    transportId: ANDROID_RESET_DEVICE.deviceId,
    deviceName: ANDROID_RESET_DEVICE.name,
  };
  const timer = new FakeTimer();
  const registry = await openSqliteBindingRegistry({
    dbPath: ":memory:",
    isExecOwnerLive: () => false,
    timer,
  });
  const scope = await registry.ensureScope(SCOPE);
  if (scope.kind !== "ready") {
    throw new Error("Missing scope");
  }
  const scopeKey = scope.scope.scopeKey;
  const store = registry.sessionBrokerStore(scopeKey, new CountingIdGenerator("resource"));
  const host = new FakeAndroidResetHost();
  host.timer = timer;
  const tracker = new ExecutionTracker(timer, new CountingIdGenerator("execution"));
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
    isExecOwnerLive: () => false,
  });
  const sessionIds = new CountingIdGenerator("session");
  const port = new ManagedDevicePort({
    scope: SCOPE,
    timer,
    registry,
    bindingJournal: journal,
    resetBaseline: {
      get android() {
        return state.configured ? reset : undefined;
      },
    },
    isCurrentReset: async (resource) => {
      const stored = await store.getResource(resource.resourceId);
      return (
        state.current && stored?.state === "resetting" && stored.revision === resource.revision
      );
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
          state.creates++;
          const result = await registry.commitBinding(key, assignment, {
            stableDeviceId: ANDROID_RESET_DEVICE.name,
            deviceName: state.deviceName,
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
                transportId: state.transportId,
                name: state.deviceName,
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
  const options: SessionBrokerOptions = {
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
  const broker = new SessionBroker(options);
  return { state, timer, registry, host, tracker, deleter, options, broker };
}

describe("Android broker reset dispatch and recovery", () => {
  let registry: SqliteBindingRegistry;
  let broker: SessionBroker;
  let options: SessionBrokerOptions;
  let host: FakeAndroidResetHost;
  let deleter: FakeDeleter;
  let harness: Awaited<ReturnType<typeof buildHarness>>;
  let timer: FakeTimer;
  let tracker: ExecutionTracker;

  beforeAll(async () => {
    // Warm the real broker/reset/SQLite path outside the per-test timing budget.
    // This harness owns all its state; beforeEach builds a fresh one for every test.
    const warm = await buildHarness();
    const { adb } = androidBaselineRig();
    warm.host.strategy = new AndroidKeepBootedReset({
      journal: new FakeDeviceMutationJournal(warm.timer),
      port: () => new AndroidDeviceMutationResetPort(adb, warm.timer),
      timer: warm.timer,
    });
    try {
      const result = await warm.broker.prepare(config("warm-up"), "owner-token");
      if (result.outcome !== "ready" || !result.sessionUuid) {
        throw new Error(JSON.stringify(result));
      }
      expect(await warm.broker.release(result.sessionUuid)).toMatchObject({
        outcome: "released",
        timing: { reset: { outcome: "clean", mode: "keep-booted" } },
      });
    } finally {
      await warm.broker.close();
      await warm.registry.close();
    }
  });

  beforeEach(async () => {
    harness = await buildHarness();
    ({ timer, registry, host, tracker, deleter, options, broker } = harness);
  });

  afterEach(async () => {
    await broker.close();
    await registry.close();
  });

  async function ready(requestId = "first") {
    const result = await broker.prepare(config(requestId), "owner-token");
    expect(result.outcome).toBe("ready");
    if (!result.sessionUuid) {
      throw new Error(JSON.stringify(result));
    }
    return result.sessionUuid;
  }

  test("qualified injected Android strategy reuses the same AVD without creation", async () => {
    const first = await ready();
    expect(await broker.release(first)).toMatchObject({ outcome: "released" });
    expect((await options.store.listResources())[0]!.state).toBe("idle");
    expect(await ready("second")).not.toBe(first);
    expect(harness.state.creates).toBe(1);
    expect(deleter.calls).toHaveLength(0);
  });

  test("production keep-booted cleaner publishes idle with clean timing and clears clipboard", async () => {
    const { adb } = androidBaselineRig();
    host.strategy = new AndroidKeepBootedReset({
      journal: new FakeDeviceMutationJournal(timer),
      port: () => new AndroidDeviceMutationResetPort(adb, timer),
      timer,
    });
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
    expect(adb.getExecutedCommands()).toContain("shell cmd clipboard clear");
  });

  test("production keep-booted cleaner reuses despite incomplete certification", async () => {
    const { adb } = androidBaselineRig();
    host.strategy = new AndroidKeepBootedReset({
      journal: new FakeDeviceMutationJournal(timer),
      port: () => new AndroidDeviceMutationResetPort(adb, timer),
      timer,
    });
    const first = await ready();
    await broker.release(first);
    const second = await ready("second");
    expect(second).not.toBe(first);
    expect(await broker.release(second)).toMatchObject({
      outcome: "released",
      timing: { reset: { outcome: "clean", mode: "keep-booted" } },
    });
    expect((await options.store.listResources())[0]!.state).toBe("idle");
    expect(harness.state.creates).toBe(1);
    expect(deleter.calls).toHaveLength(0);
  });

  test("rebooting a retained AVD invalidates the original baseline even with the same serial and name", async () => {
    const { adb } = androidBaselineRig();
    host.strategy = new AndroidKeepBootedReset({
      journal: new FakeDeviceMutationJournal(timer),
      port: () => new AndroidDeviceMutationResetPort(adb, timer),
      timer,
    });
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
      reset.reset("resource", ANDROID_RESET_DEVICE, ANDROID_RESET_PROFILE, async () => {}),
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
      expect(harness.state.creates).toBe(1);
    },
  );

  test("baseline capture honors abort and preparation deadline before adb", async () => {
    const reset = new AndroidBaselineReset(host);
    const controller = new AbortController();
    host.onInventory = () => controller.abort(new Error("prepare cancelled"));
    await expect(
      reset.capture("resource", ANDROID_RESET_DEVICE, ANDROID_RESET_PROFILE, "session", {
        signal: controller.signal,
        timer,
      }),
    ).rejects.toThrow();
    expect(host.lastInventorySignal?.aborted).toBe(true);
    expect(host.commands).toEqual([]);

    host.onInventory = () => timer.advanceTime(11);
    await expect(
      reset.capture("resource", ANDROID_RESET_DEVICE, ANDROID_RESET_PROFILE, "session", {
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
    harness.state.deviceName = "emulator-5554";
    host.devices[0]!.name = harness.state.deviceName;
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
    expect(harness.state.creates).toBe(1);
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
      harness.state.transportId = "";
    }
    if (failure === "adb-connect") {
      harness.state.transportId = "127.0.0.1:5555";
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
      harness.state.configured = false;
    }
    const session = await ready();
    if (failure === "ownership") {
      harness.state.current = false;
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
        harness.state.current = false;
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
