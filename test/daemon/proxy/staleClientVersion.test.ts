import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import * as constants from "../../../src/daemon/wire/constants";
import type { BuildIdentity } from "../../../src/daemon/wire/buildIdentity";
import {
  DaemonLifecycleReconciler,
  type DaemonLifecycleReconcilerDeps,
} from "../../../src/daemon/proxy/DaemonLifecycleReconciler";
import { DaemonVersionMismatchError } from "../../../src/daemon/proxy/DaemonVersionMismatchError";
import type { DaemonStatus } from "../../../src/daemon/types";
import { logger } from "../../../src/utils/logger";
import { FakeDaemonManager } from "../../fakes/FakeDaemonManager";
import { FakeTimer } from "../../fakes/FakeTimer";

const CLEAN = "0.0.87+g15404adf7979";
const DIRTY = `${CLEAN}.dirty.47e2e3e8f6a5`;
const BUILD: BuildIdentity = { entryScript: "/checkout/src/index.ts", buildId: "same-build" };

function harness(options: {
  clientVersion: string;
  runningVersion: string;
  buildIdentity?: BuildIdentity;
  daemonBuild?: BuildIdentity;
  readCheckoutVersion?: () => Promise<string | null>;
}) {
  const manager = new FakeDaemonManager();
  const timer = new FakeTimer();
  timer.advanceTime(constants.DAEMON_VERSION_RESTART_COOLDOWN_MS + 100);
  manager.statusResult = {
    running: true,
    pid: 1234,
    startedAt: 1,
    version: options.runningVersion,
    options: { debug: true, port: 3195 },
    ...(options.daemonBuild ?? BUILD),
  };
  const deps: DaemonLifecycleReconcilerDeps = {
    config: { autoStartDaemon: true, daemonOptions: { embeddedSdk: true } },
    daemonManager: manager,
    daemonStatusProbe: undefined,
    reconciliationSnapshot: undefined,
    timer,
    clientVersion: options.clientVersion,
    clientAssetVersion: null,
    buildIdentity: options.buildIdentity ?? BUILD,
    readCheckoutVersion: options.readCheckoutVersion,
    invalidateCache: () => {},
    assertDaemonLifecycleUnfenced: () => {},
    reconciliationStatus: () => reconciler.reconciliationStatus(),
    isSameDaemonGeneration: (current, expected) =>
      reconciler.isSameDaemonGeneration(current, expected),
    waitForJoinedRestartSuccessor: (expected, deadline) =>
      reconciler.waitForJoinedRestartSuccessor(expected, deadline),
    waitForRunningReconciliationStatus: (deadline) =>
      reconciler.waitForRunningReconciliationStatus(deadline),
    readSocketReconciliationStatus: () => reconciler.readSocketReconciliationStatus(),
    assertAutomaticRestartAllowed: (status, reason) =>
      reconciler.assertAutomaticRestartAllowed(status, reason),
    ensureVersionMatches: (...args) => reconciler.ensureVersionMatches(...args),
    verifyRestartedVersion: () => reconciler.verifyRestartedVersion(),
    requiresVersionRestart: (...args) => reconciler.requiresVersionRestart(...args),
    assertNewerClientVersion: (...args) => reconciler.assertNewerClientVersion(...args),
    assertVersionRestartCooldownExpired: (...args) =>
      reconciler.assertVersionRestartCooldownExpired(...args),
    versionMismatchError: (...args) => reconciler.versionMismatchError(...args),
    ensureBuildMatches: (...args) => reconciler.ensureBuildMatches(...args),
    finishBuildRestart: (...args) => reconciler.finishBuildRestart(...args),
    buildMismatchError: (...args) => reconciler.buildMismatchError(...args),
  };
  const reconciler = new DaemonLifecycleReconciler(deps);
  const restarted = (version = options.runningVersion): DaemonStatus => ({
    ...manager.statusResult,
    pid: 5678,
    startedAt: timer.now(),
    version,
  });
  return { manager, reconciler, restarted };
}

describe("stale MCP client version convergence", () => {
  let settled: ReturnType<typeof spyOn<typeof constants, "syncSettledDaemonVersion">>;
  beforeEach(() => {
    settled = spyOn(constants, "syncSettledDaemonVersion").mockReturnValue(true);
  });
  afterEach(() => settled.mockRestore());

  test("frozen clean client accepts the current dirty daemon across repeated calls", async () => {
    let probes = 0;
    const { manager, reconciler } = harness({
      clientVersion: CLEAN,
      runningVersion: DIRTY,
      readCheckoutVersion: async () => {
        probes++;
        return DIRTY;
      },
    });
    for (let call = 0; call < 3; call++) {
      await reconciler.ensureVersionMatches();
    }
    expect(manager.restartCallCount).toBe(0);
    expect(probes).toBe(1);
  });

  test("frozen dirty client accepts the current clean daemon", async () => {
    const { manager, reconciler } = harness({
      clientVersion: DIRTY,
      runningVersion: CLEAN,
      readCheckoutVersion: async () => CLEAN,
    });
    await reconciler.ensureVersionMatches();
    expect(manager.restartCallCount).toBe(0);
  });

  test("a client started after an edit restarts a stale clean daemon once (#14405)", async () => {
    const { manager, reconciler, restarted } = harness({
      clientVersion: DIRTY,
      runningVersion: CLEAN,
      readCheckoutVersion: async () => DIRTY,
    });
    manager.statusResults = [manager.statusResult, restarted(DIRTY)];
    await reconciler.ensureVersionMatches();
    expect(manager.restartCallCount).toBe(1);
    expect(manager.restartOptions).toEqual({ debug: true, port: 3195, embeddedSdk: true });
  });

  test("a client stale by commit refuses with both versions and relaunch guidance", async () => {
    const clientVersion = "0.0.87+gaaaaaaaaaaaa";
    const runningVersion = "0.0.87+gbbbbbbbbbbbb";
    const { manager, reconciler } = harness({
      clientVersion,
      runningVersion,
      readCheckoutVersion: async () => runningVersion,
    });
    const failure = await reconciler.ensureVersionMatches().then(
      () => undefined,
      (error: unknown) => error,
    );
    expect(failure).toBeInstanceOf(DaemonVersionMismatchError);
    expect(failure).toMatchObject({ reason: "staleClient" });
    if (!(failure instanceof DaemonVersionMismatchError)) {
      throw new Error("Expected a typed version refusal");
    }
    expect(failure.message).toContain(`daemon=${runningVersion}, client=${clientVersion}`);
    expect(failure.message).toContain("Relaunch");
    expect(manager.restartCallCount).toBe(0);
  });

  test("without a probe one restart learns the dirty version across daemon generations", async () => {
    const { manager, reconciler, restarted } = harness({
      clientVersion: CLEAN,
      runningVersion: DIRTY,
    });
    manager.statusResults = [manager.statusResult, restarted()];
    await reconciler.ensureVersionMatches();
    manager.statusResult = { ...restarted(), pid: 9012 };
    await reconciler.ensureVersionMatches();
    expect(manager.restartCallCount).toBe(1);
  });

  test("a different entry script retains restartMismatch behaviour", async () => {
    let probes = 0;
    const { manager, reconciler } = harness({
      clientVersion: CLEAN,
      runningVersion: DIRTY,
      daemonBuild: { ...BUILD, entryScript: "/other/src/index.ts" },
      readCheckoutVersion: async () => {
        probes++;
        return DIRTY;
      },
    });
    await expect(reconciler.ensureVersionMatches()).rejects.toMatchObject({
      reason: "restartMismatch",
    });
    expect(manager.restartCallCount).toBe(1);
    expect(probes).toBe(0);
  });

  test("a failed checkout probe falls back to one restart", async () => {
    const error = new Error("checkout probe unavailable");
    const warning = spyOn(logger, "warn").mockImplementation(() => {});
    const { manager, reconciler, restarted } = harness({
      clientVersion: CLEAN,
      runningVersion: DIRTY,
      readCheckoutVersion: async () => {
        throw error;
      },
    });
    manager.statusResults = [manager.statusResult, restarted()];
    try {
      await reconciler.ensureVersionMatches();
      expect(manager.restartCallCount).toBe(1);
      expect(warning).toHaveBeenCalledWith(
        "[DaemonMcpProxy] Checkout version probe failed; using last known version",
        error,
      );
    } finally {
      warning.mockRestore();
    }
  });

  test("an unknown checkout learns a different commit after one restart and refuses", async () => {
    const runningVersion = "0.0.87+gbbbbbbbbbbbb";
    const { manager, reconciler, restarted } = harness({
      clientVersion: "0.0.87+gaaaaaaaaaaaa",
      runningVersion,
      readCheckoutVersion: async () => null,
    });
    manager.statusResults = [manager.statusResult, restarted()];
    await expect(reconciler.ensureVersionMatches()).rejects.toMatchObject({
      reason: "staleClient",
    });
    manager.statusResult = restarted();
    await expect(reconciler.ensureVersionMatches()).rejects.toMatchObject({
      reason: "staleClient",
    });
    expect(manager.restartCallCount).toBe(1);
  });

  test("a changed entry-script build retains restartMismatch behaviour", async () => {
    const { manager, reconciler } = harness({
      clientVersion: CLEAN,
      runningVersion: DIRTY,
      daemonBuild: { ...BUILD, buildId: "different-build" },
      readCheckoutVersion: async () => DIRTY,
    });
    await expect(reconciler.ensureVersionMatches()).rejects.toMatchObject({
      reason: "restartMismatch",
    });
    expect(manager.restartCallCount).toBe(1);
  });
});
