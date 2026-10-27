import { afterEach, beforeAll, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import { SessionBroker, type SessionBrokerOptions } from "../../../src/daemon/sessionBroker/broker";
import { SessionBrokerInvariantError } from "../../../src/daemon/sessionBroker/SessionBrokerInvariantError";
import { SessionRequestOwnerMismatchError } from "../../../src/daemon/sessionBroker/SessionRequestOwnerMismatchError";
import {
  openSqliteBindingRegistry,
  type SqliteBindingRegistry,
} from "../../../src/daemon/sessionBroker/registry/sqliteBindingRegistry";
import type { SessionConfig } from "../../../src/devices/sessionConfig";
import { ActionableError, toActionableError } from "../../../src/models/ActionableError";
import { BootedDeviceDiscoveryIncompleteError } from "../../../src/models/BootedDeviceDiscoveryIncompleteError";
import { CountingIdGenerator } from "../../../src/utils/IdGenerator";
import { SimctlCommandTimeoutError } from "../../../src/utils/ios-cmdline-tools/SimctlCommandTimeoutError";
import { iosCatalog, iosDefaults } from "../../devices/sessionRequirements/fixtures";
import { FakeTimer } from "../../fakes/FakeTimer";
import { FAKE_BROKER_OWNER, FakeNativePort } from "../../helpers/fakeSessionBrokerDevicePort";

function config(requestId: string): SessionConfig {
  return {
    contractVersion: 1,
    requestId,
    device: {
      schemaVersion: 1,
      platform: "ios",
      hardware: { kind: "omitted" },
      os: { kind: "omitted" },
    },
  };
}

type ReleaseStage = "release" | "reset" | "completeCleanRelease";

describe("clean release retains warm devices across retryable failures", () => {
  let registry: SqliteBindingRegistry;
  let devices: FakeNativePort;
  let options: SessionBrokerOptions;
  let broker: SessionBroker;

  beforeAll(async () => {
    const warm = await openSqliteBindingRegistry({ dbPath: ":memory:", timer: new FakeTimer() });
    await warm.close();
  });

  beforeEach(async () => {
    const timer = new FakeTimer();
    registry = await openSqliteBindingRegistry({
      dbPath: ":memory:",
      isExecOwnerLive: () => true,
      timer,
    });
    const scope = await registry.ensureScope({
      managedHostScope: "private-host",
      runnerNamespace: "private-broker",
      runnerIncarnation: "persistent",
    });
    if (scope.kind !== "ready") {
      throw new Error("Missing scope");
    }
    devices = new FakeNativePort(registry);
    options = {
      store: registry.sessionBrokerStore(scope.scope.scopeKey, new CountingIdGenerator("resource")),
      devices,
      owner: FAKE_BROKER_OWNER,
      limits: { totalDeviceCap: 1, sessionCap: 1, idlePoolCap: 1 },
      catalog: async () => iosCatalog(),
      defaults: () => iosDefaults(),
      reuseCleanDevices: true,
      timer,
    };
    broker = new SessionBroker(options);
  });

  afterEach(async () => {
    mock.restore();
    await broker.close();
    await registry.close();
  });

  async function ready(requestId: string): Promise<string> {
    const result = await broker.prepare(config(requestId), "owner-token");
    expect(result.outcome).toBe("ready");
    if (!result.sessionUuid) {
      throw new Error("Missing session UUID");
    }
    return result.sessionUuid;
  }

  async function expectPendingThenRedrive(
    stage: ReleaseStage,
    sessionUuid: string,
    clearFailure: () => void,
  ): Promise<void> {
    const resourceId = devices.prepared[0];
    devices.dirty.add(resourceId);
    expect(await broker.release(sessionUuid)).toMatchObject({
      sessionUuid,
      outcome: "cleanup_pending",
    });
    expect(devices.destroyed).toEqual([]);
    expect(await options.store.getRequest("first")).toMatchObject({ state: "releasing" });
    expect((await options.store.listResources())[0]).toMatchObject({
      resourceId,
      state: "resetting",
      requestId: "first",
    });
    expect(await broker.status("first")).toMatchObject({
      outcome: "pending",
      cleanupPending: true,
    });
    if (stage === "completeCleanRelease") {
      expect(devices.dirty.size).toBe(0);
      expect(devices.resetResources).toEqual([resourceId]);
    }
    // Still retryable on the next pass; no destructive fallback under sustained contention.
    await broker.recover();
    expect(devices.destroyed).toEqual([]);
    expect((await options.store.listResources())[0].state).toBe("resetting");
    clearFailure();
    await broker.recover();
    expect(await broker.status("first")).toMatchObject({
      outcome: "released",
      cleanupPending: false,
    });
    expect((await options.store.listResources())[0].state).toBe("idle");
    expect(devices.destroyed).toEqual([]);
    expect(await broker.release(sessionUuid)).toMatchObject({ outcome: "released" });
    const next = await ready("second");
    expect(next).not.toBe(sessionUuid);
    expect(devices.prepared).toEqual([resourceId, resourceId]);
  }

  for (const stage of ["release", "reset", "completeCleanRelease"] as const) {
    test.each(["SQLITE_BUSY", "SQLITE_LOCKED_SHAREDCACHE"])(
      `${stage}: %s keeps the resource resetting until recovery completes clean release`,
      async (code) => {
        // Structured code through a cause is the dialect's contract; no message matching needed.
        const sqlite = Object.assign(new Error("write contention"), { code });
        const sessionUuid = await ready("first");
        const failure =
          stage === "completeCleanRelease"
            ? spyOn(options.store, stage).mockRejectedValue(
                new Error("registry write failed", { cause: sqlite }),
              )
            : spyOn(devices, stage).mockRejectedValue(
                new Error("registry write failed", { cause: sqlite }),
              );
        await expectPendingThenRedrive(stage, sessionUuid, () => failure.mockRestore());
      },
    );
  }

  test("incomplete discovery during reset retains the resource until recovery", async () => {
    const error = new BootedDeviceDiscoveryIncompleteError("ios", {
      code: "timeout",
      message: "timed out after 15000ms collecting iOS simulator capacity",
      retryable: true,
    });
    const sessionUuid = await ready("first");
    const failure = spyOn(devices, "reset").mockRejectedValue(error);
    await expectPendingThenRedrive("reset", sessionUuid, () => failure.mockRestore());
  });

  test("fresh inventory timeout wrapped by IosBaselineReset remains retryable", async () => {
    const error = toActionableError(
      new SimctlCommandTimeoutError("simctl list exceeded its deadline"),
      "Cannot start reset: fresh iOS simulator inventory failed",
    );
    const sessionUuid = await ready("first");
    const failure = spyOn(devices, "reset").mockRejectedValue(error);
    await expectPendingThenRedrive("reset", sessionUuid, () => failure.mockRestore());
  });

  test("shutdown cancellation wrapped at the device boundary remains retryable", async () => {
    const error = toActionableError(
      new DOMException("Shutdown", "AbortError"),
      "Release cancelled",
    );
    const sessionUuid = await ready("first");
    const failure = spyOn(devices, "release").mockRejectedValue(error);
    await expectPendingThenRedrive("release", sessionUuid, () => failure.mockRestore());
  });

  test.each(["AbortError", "TimeoutError"])("%s identity is realm safe", async (name) => {
    // Remove the local Error prototype to stand in for an error from another realm.
    const cause = Object.setPrototypeOf(Object.assign(new Error("interrupted"), { name }), null);
    expect(cause instanceof Error).toBe(false);
    const sessionUuid = await ready("first");
    const failure = spyOn(devices, "reset").mockRejectedValue(
      new Error("native call failed", { cause }),
    );
    await expectPendingThenRedrive("reset", sessionUuid, () => failure.mockRestore());
  });

  test("an unknown receipt write failure after a clean reset stays pending for recovery", async () => {
    const sessionUuid = await ready("first");
    const failure = spyOn(options.store, "completeCleanRelease").mockRejectedValue(
      new Error("receipt write failed"),
    );
    await expectPendingThenRedrive("completeCleanRelease", sessionUuid, () =>
      failure.mockRestore(),
    );
  });

  test.each([
    new SessionBrokerInvariantError("Clean release precondition failed"),
    new SessionRequestOwnerMismatchError(false),
    new SessionRequestOwnerMismatchError(true),
    Object.assign(
      new Error("wrapped invariant", {
        cause: new SessionBrokerInvariantError("Lost reservation"),
      }),
      { name: "TimeoutError" },
    ),
    Object.assign(new Error("invalid receipt"), { code: "SQLITE_CONSTRAINT_FOREIGNKEY" }),
  ])("a permanent receipt failure after a clean reset destroys: %s", async (error) => {
    const sessionUuid = await ready("first");
    spyOn(options.store, "completeCleanRelease").mockRejectedValue(error);
    expect(await broker.release(sessionUuid)).toMatchObject({
      outcome: "released",
      timing: { reset: { outcome: "destroyed", retired: true } },
    });
    expect((await broker.status("first"))?.timing?.reset).toMatchObject({
      outcome: "destroyed",
      retired: true,
    });
    expect(devices.resetResources).toEqual([devices.prepared[0]]);
    expect(devices.destroyed).toEqual([devices.prepared[0]]);
    expect((await options.store.listResources())[0].state).toBe("destroyed");
    await broker.recover();
    expect(devices.resetResources).toHaveLength(1);
    await ready("second");
    expect(devices.prepared[1]).not.toBe(devices.prepared[0]);
  });

  for (const stage of ["release", "reset"] as const) {
    test.each([
      new Error("spawn EAGAIN"),
      new Error("adb: resource busy"),
      Object.assign(new Error("simctl: resource busy"), { code: "EBUSY" }),
    ])(
      `${stage}: native busy text does not make an unknown failure retryable: %s`,
      async (error) => {
        const sessionUuid = await ready("first");
        // Wrap to exercise every cause level without preventing the destruction drain.
        spyOn(devices, stage).mockRejectedValueOnce(toActionableError(error, "Native failure"));
        expect(await broker.release(sessionUuid)).toMatchObject({ outcome: "released" });
        expect(devices.destroyed).toEqual([devices.prepared[0]]);
        expect((await options.store.listResources())[0].state).toBe("destroyed");
      },
    );
  }

  test("a committed clean-release write with a lost reply never starts destruction", async () => {
    const sessionUuid = await ready("first");
    const complete = options.store.completeCleanRelease.bind(options.store);
    spyOn(options.store, "completeCleanRelease").mockImplementationOnce(async (...args) => {
      await complete(...args);
      throw new Error("lost commit reply");
    });
    expect(await broker.release(sessionUuid)).toMatchObject({ outcome: "cleanup_pending" });
    expect((await broker.status("first"))?.timing?.reset).toMatchObject({ outcome: "clean" });
    expect((await broker.status("first"))?.timing?.reset?.fallbackReason).toBeUndefined();
    expect(devices.destroyed).toEqual([]);
    await broker.recover();
    expect(await broker.release(sessionUuid)).toMatchObject({ outcome: "released" });
    expect((await options.store.listResources())[0].state).toBe("idle");
  });

  test("a non-clean reset result still destroys the device", async () => {
    const sessionUuid = await ready("first");
    devices.canReset = false;
    expect(await broker.release(sessionUuid)).toMatchObject({ outcome: "released" });
    expect(devices.destroyed).toEqual([devices.prepared[0]]);
    expect((await options.store.listResources())[0].state).toBe("destroyed");
  });

  test.each(["release", "reset"] as const)(
    "a permanent %s failure still destroys",
    async (stage) => {
      const sessionUuid = await ready("first");
      // Fail once so the destruction journal can drain the old session for real.
      spyOn(devices, stage).mockRejectedValueOnce(new ActionableError("Native device is gone"));
      expect(await broker.release(sessionUuid)).toMatchObject({ outcome: "released" });
      expect(devices.destroyed).toEqual([devices.prepared[0]]);
      expect((await options.store.listResources())[0].state).toBe("destroyed");
    },
  );
});
