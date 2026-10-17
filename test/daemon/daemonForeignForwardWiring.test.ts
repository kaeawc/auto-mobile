import { afterEach, expect, spyOn, test } from "bun:test";
import { Daemon, startDaemon } from "../../src/daemon/daemon";
import { DaemonState } from "../../src/daemon/daemonState";
import { DevicePool } from "../../src/daemon/devicePool";
import type { ForeignDeviceOwnership } from "../../src/daemon/foreignDeviceOwnership";
import * as forwardEvidence from "../../src/features/observe/android/foreignCtrlProxyForwardEvidence";
import { executionTracker } from "../../src/server/executionTracker";
import { resetProvisionedDeviceTransportFenceForTests } from "../../src/utils/provisionedDeviceTransportFence";
import { SessionManager } from "../../src/daemon/sessionManager";
import { createDevicePoolDependencies } from "../helpers/devicePoolDependencies";
import { FakeDeviceSessionPersistence } from "../fakes/FakeDeviceSessionPersistence";
import { FakeTimer } from "../fakes/FakeTimer";

interface PoolOwnership {
  foreignDeviceOwnership: ForeignDeviceOwnership;
  refreshForeignOwnership(): Promise<void>;
}

afterEach(() => {
  DaemonState.getInstance().reset();
  resetProvisionedDeviceTransportFenceForTests();
  forwardEvidence.resetForeignCtrlProxyForwardEvidenceForTesting();
});

test("only the production daemon entry supplies Android forward evidence", async () => {
  const timer = new FakeTimer();
  const reads: string[] = [];
  const evidence: forwardEvidence.ForeignCtrlProxyForwardEvidence = {
    read: async (deviceId) => {
      reads.push(deviceId);
      return { kind: "foreign", ports: [19001], clientPids: [4242], message: "foreign forward" };
    },
  };
  const factory = spyOn(forwardEvidence, "createForeignCtrlProxyForwardEvidence").mockReturnValue(
    evidence,
  );
  // Preserve the process-wide execution resolver while constructing real daemons.
  const resolver = spyOn(executionTracker, "setAutolockSessionResolver").mockImplementation(
    () => {},
  );
  const start = spyOn(Daemon.prototype, "start").mockImplementation(async function (this: Daemon) {
    try {
      const ownership = (this.getDevicePool() as unknown as PoolOwnership).foreignDeviceOwnership;
      await ownership.refresh(["wiring-android"]);
      expect(ownership.foreignOwnerPid("wiring-android")).toBe(4242);
    } finally {
      this.getSessionManager().stopCleanupTimer();
    }
  });
  const sessions = new SessionManager(timer, new FakeDeviceSessionPersistence());
  let daemon: Daemon | undefined;
  try {
    const pool = DevicePool.create(
      createDevicePoolDependencies(sessions, "wiring-default", { timer }),
    );
    await pool.initializeWithDevices([
      { deviceId: "wiring-android", name: "Phone", platform: "android" },
    ]);
    await (pool as unknown as PoolOwnership).refreshForeignOwnership();
    expect(reads).toEqual([]);
    expect(factory).not.toHaveBeenCalled();

    daemon = new Daemon({}, { timer });
    await (daemon.getDevicePool() as unknown as PoolOwnership).foreignDeviceOwnership.refresh([
      "wiring-android",
    ]);
    expect(reads).toEqual([]);
    expect(factory).not.toHaveBeenCalled();

    await startDaemon();
    expect(factory).toHaveBeenCalledTimes(1);
    expect(start).toHaveBeenCalledTimes(1);
    expect(reads).toEqual(["wiring-android"]);
  } finally {
    daemon?.getSessionManager().stopCleanupTimer();
    sessions.stopCleanupTimer();
    timer.reset();
    start.mockRestore();
    resolver.mockRestore();
    factory.mockRestore();
  }
});
