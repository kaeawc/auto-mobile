import { describe, expect, test } from "bun:test";
import { DaemonUnavailableError } from "../../../src/daemon/DaemonUnavailableError";
import { daemonProcessOptions } from "../../../src/daemon/daemonOptionScopes";
import {
  DaemonLifecycleReconciler,
  type DaemonLifecycleReconcilerDeps,
} from "../../../src/daemon/proxy/DaemonLifecycleReconciler";
import { shapeToolCallError } from "../../../src/daemon/shapeToolCallError";
import { DaemonRestartOptionsUnknownError } from "../../../src/daemon/proxy/DaemonRestartOptionsUnknownError";
import type { DaemonOptions, DaemonStatus } from "../../../src/daemon/types";
import { FakeDaemonManager } from "../../fakes/FakeDaemonManager";
import { FakeTimer } from "../../fakes/FakeTimer";

const PRIVATE_ENV = {
  AUTOMOBILE_DAEMON_SOCKET_PATH: "/tmp/lost-daemon/daemon.sock",
  AUTOMOBILE_DATA_DIR: "/tmp/lost-daemon",
};
const RUNNING: DaemonStatus = {
  running: true,
  port: 3195,
  options: {
    port: 3195,
    host: "127.0.0.1",
    strictPort: true,
    debug: true,
    embeddedSdk: true,
    networkMockable: true,
  },
};

function harness(
  config: DaemonLifecycleReconcilerDeps["config"] = {},
  probe?: () => Promise<DaemonStatus>,
) {
  const manager = new FakeDaemonManager();
  manager.statusResult = RUNNING;
  const reconciler: DaemonLifecycleReconciler = new DaemonLifecycleReconciler({
    config,
    daemonManager: manager,
    daemonStatusProbe: probe,
    reconciliationSnapshot: undefined,
    timer: new FakeTimer(),
    clientVersion: "1.0.0",
    clientAssetVersion: null,
    buildIdentity: { buildId: "unknown", entryScript: "" },
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
    ensureVersionMatches: (deadline, status) => reconciler.ensureVersionMatches(deadline, status),
    verifyRestartedVersion: () => reconciler.verifyRestartedVersion(),
    requiresVersionRestart: (status, version) => reconciler.requiresVersionRestart(status, version),
    assertNewerClientVersion: (...args) => reconciler.assertNewerClientVersion(...args),
    assertVersionRestartCooldownExpired: (status, version) =>
      reconciler.assertVersionRestartCooldownExpired(status, version),
    versionMismatchError: (...args) => reconciler.versionMismatchError(...args),
    ensureBuildMatches: (deadline, status) => reconciler.ensureBuildMatches(deadline, status),
    finishBuildRestart: (...args) => reconciler.finishBuildRestart(...args),
    buildMismatchError: (...args) => reconciler.buildMismatchError(...args),
  });
  return { manager, reconciler };
}

describe("lost daemon startup options", () => {
  test("observing status preserves the original reconciliation promise", async () => {
    const { manager, reconciler } = harness();
    const status = Promise.resolve(RUNNING);
    manager.status = () => status;
    expect(reconciler.reconciliationStatus()).toBe(status);
    await status;
    manager.status = async () => ({ running: false });
    await reconciler.startDaemon();
    expect(manager.startOptions).toEqual(RUNNING.options);
  });

  test("recovers the observed port and flags while preserving requested tool defaults", async () => {
    const { manager, reconciler } = harness({
      daemonOptions: { enabledTools: ["observe"], actionsCompactMetadata: true },
    });
    await reconciler.reconciliationStatus();
    manager.statusResult = { running: false };
    await reconciler.startDaemon();
    expect(manager.startOptions).toEqual({ ...RUNNING.options, enabledTools: ["observe"] });
  });

  test("false booleans and undefined requested values do not erase observed options", async () => {
    const { manager, reconciler } = harness({ daemonOptions: { debug: false, port: undefined } });
    await reconciler.reconciliationStatus();
    manager.statusResult = { running: false };
    await reconciler.startDaemon();
    expect(manager.startOptions).toEqual(RUNNING.options);
  });

  test("a first start retains the existing process option projection", async () => {
    const requested: DaemonOptions = {
      debug: true,
      enabledTools: ["observe"],
      toolResultsNoStructuredContent: true,
      actionsCompactMetadata: false,
    };
    const { manager, reconciler } = harness({
      daemonOptions: requested,
      lifecycleNamespaceEnv: PRIVATE_ENV,
    });
    manager.statusResult = { running: false };
    await reconciler.startDaemon();
    expect(manager.startOptions).toEqual(daemonProcessOptions(requested));
  });

  test("refuses unknown private startup options with a client-visible typed code", async () => {
    const { manager, reconciler } = harness({ lifecycleNamespaceEnv: PRIVATE_ENV });
    manager.statusResult = { running: true };
    await reconciler.reconciliationStatus();
    manager.statusResult = { running: false };
    const error = await reconciler.startDaemon().then(
      () => undefined,
      (failure: unknown) => failure,
    );
    expect(error).toBeInstanceOf(DaemonUnavailableError);
    expect(error).toBeInstanceOf(DaemonRestartOptionsUnknownError);
    expect(error).toMatchObject({
      name: "DaemonRestartOptionsUnknownError",
      code: "daemon_restart_options_unknown",
      message: expect.stringContaining("original launcher"),
    });
    expect(manager.startCalled).toBe(false);
    const result = shapeToolCallError(error, { toolName: "observe", source: "ProxyServer" });
    expect(JSON.parse(result.content[0].text)).toMatchObject({
      code: "daemon_restart_options_unknown",
      retryable: false,
    });
  });

  test("recovers a port-only status", async () => {
    const { manager, reconciler } = harness({ lifecycleNamespaceEnv: PRIVATE_ENV });
    manager.statusResult = { running: true, port: 3195 };
    await reconciler.reconciliationStatus();
    manager.statusResult = { running: false };
    await reconciler.startDaemon();
    expect(manager.startOptions).toEqual({ port: 3195 });
  });

  test("missing metadata in a shared namespace still permits auto-start", async () => {
    const { manager, reconciler } = harness({
      lifecycleNamespaceEnv: {},
      daemonOptions: { debug: true },
    });
    manager.statusResult = { running: true };
    await reconciler.reconciliationStatus();
    manager.statusResult = { running: false };
    await reconciler.startDaemon();
    expect(manager.startCalled).toBe(true);
    expect(manager.startOptions?.debug).toBe(true);
  });

  test("a newer running daemon without metadata replaces older known private options", async () => {
    const { manager, reconciler } = harness({ lifecycleNamespaceEnv: PRIVATE_ENV });
    await reconciler.reconciliationStatus();
    manager.statusResult = { running: true };
    await reconciler.reconciliationStatus();
    manager.statusResult = { running: false };
    await expect(reconciler.startDaemon()).rejects.toBeInstanceOf(DaemonRestartOptionsUnknownError);
    expect(manager.startCalled).toBe(false);
  });

  test("records direct socket observations rather than unrelated PID metadata", async () => {
    const { manager, reconciler } = harness({}, async () => RUNNING);
    manager.statusResult = { running: true, port: 3000, options: { port: 3000 } };
    await reconciler.readSocketReconciliationStatus();
    manager.statusResult = { running: false };
    await reconciler.startDaemon();
    expect(manager.startOptions).toEqual(RUNNING.options);
  });

  test("remembers a daemon this proxy started once it becomes ready", async () => {
    const { manager, reconciler } = harness();
    manager.statusResults = [{ running: false }, RUNNING];
    await reconciler.startDaemon();
    manager.statusResults = [];
    manager.statusResult = { running: false };
    await reconciler.startDaemon();
    expect(manager.startOptions).toEqual(RUNNING.options);
  });

  test("the latest running generation replaces the earlier recorded options", async () => {
    const { manager, reconciler } = harness();
    await reconciler.reconciliationStatus();
    manager.statusResult = { running: true, port: 4195, options: { port: 4195, debugPerf: true } };
    await reconciler.reconciliationStatus();
    manager.statusResult = { running: false };
    await reconciler.reconciliationStatus();
    await reconciler.startDaemon();
    expect(manager.startOptions).toEqual({ port: 4195, debugPerf: true });
  });
});
