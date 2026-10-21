import { afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { SessionBroker, type SessionBrokerOptions } from "../../../src/daemon/sessionBroker/broker";
import { ManagedDevicePort } from "../../../src/daemon/sessionBroker/managedDevicePort";
import {
  AndroidBaselineReset,
  watchAndroidResetSession,
} from "../../../src/daemon/sessionBroker/androidBaselineReset";
import { ExecutionTracker } from "../../../src/daemon/executionTracker";
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

  beforeAll(async () => {
    const warm = await openSqliteBindingRegistry({ dbPath: ":memory:" });
    await warm.close();
  });

  beforeEach(async () => {
    configured = true;
    current = true;
    creates = 0;
    transportId = ANDROID_RESET_DEVICE.deviceId;
    registry = await openSqliteBindingRegistry({
      dbPath: ":memory:",
      isExecOwnerLive: () => false,
    });
    const scope = await registry.ensureScope(SCOPE);
    if (scope.kind !== "ready") {
      throw new Error("Missing scope");
    }
    const scopeKey = scope.scope.scopeKey;
    const store = registry.sessionBrokerStore(scopeKey, new CountingIdGenerator("resource"));
    timer = new FakeTimer();
    host = new FakeAndroidResetHost();
    tracker = new ExecutionTracker(timer, new CountingIdGenerator("execution"));
    host.watchSession = (sessionId: string) => watchAndroidResetSession(tracker, sessionId);
    host.strategy = { reset: async (_device, _packages, assertOwned) => assertOwned() };
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
              deviceName: ANDROID_RESET_DEVICE.name,
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
                  name: ANDROID_RESET_DEVICE.name,
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
            await registry.releaseExecution(assignment, sessionId);
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
    expect(creates).toBe(1);
    expect(deleter.calls).toHaveLength(0);
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

  test("Android reuse keeps reset timings when iOS reuse is disabled", async () => {
    await broker.close();
    broker = new SessionBroker({ ...options, reuseCleanDevices: false });
    host.strategy = {
      reset: async (_device, _packages, assertOwned) => {
        await assertOwned();
        timer.advanceTime(7);
      },
    };
    const first = await ready();

    expect(await broker.release(first)).toMatchObject({
      outcome: "released",
      timing: {
        acquisition: { admission: "create", outcome: "ready" },
        reset: { outcome: "clean", phases: { reset: 7 }, totalMs: 7 },
      },
    });
    expect((await options.store.listResources())[0]!.state).toBe("idle");
    expect(await broker.prepare(config("second"), "owner-token")).toMatchObject({
      outcome: "ready",
      timing: { acquisition: { admission: "reuse", reuseCount: 1, createMs: 0, bootMs: 0 } },
    });
    expect(creates).toBe(1);
  });

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
    expect(await broker.release(session)).toMatchObject({ outcome: "released" });
    expect(host.inventoryCalls).toBe(0);
    expect(host.commands).toEqual([]);
    expect((await options.store.listResources())[0]!.state).toBe("destroyed");
  });

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
    expect(await broker.release(session)).toMatchObject({ outcome: "released" });
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

  test("failed reset with transient deletion failure remains cleanup_pending until journal redrive", async () => {
    const session = await ready();
    host.healthy = false;
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
