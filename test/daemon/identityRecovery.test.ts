import { republishOwnedIdentity } from "../../src/daemon/identityRecovery";
import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { DaemonManager } from "../../src/daemon/manager";
import { UnixSocketServer } from "../../src/daemon/socketServer";
import { executionTracker } from "../../src/server/executionTracker";
import { ActionableError } from "../../src/models";
import type { DaemonStatus, PidFileData, DaemonSocketPaths } from "../../src/daemon/types";
import { FakeTimer } from "../fakes/FakeTimer";
import { FakeDaemonClient } from "../fakes/FakeDaemonClient";
import { getCurrentBuildIdentity } from "../../src/daemon/buildIdentity";
import { DAEMON_VERSION } from "../../src/daemon/constants";
import {
  DAEMON_REPUBLISH_IDENTITY_METHOD as REPUBLISH,
  DAEMON_PREPARE_MAINTENANCE_METHOD as PREPARE,
  DAEMON_RESTART_ADMITTED_METHOD as ADMIT,
} from "../../src/daemon/daemonRestartAdmission";

const socketPath = "/isolated/control.sock";
const sockets: DaemonSocketPaths = {
  control: socketPath,
  appearance: "/isolated/appearance.sock",
  "device-snapshot": "/isolated/snapshot.sock",
  "failures-push": "/isolated/fp.sock",
  "failures-stream": "/isolated/fs.sock",
  "observation-stream": "/isolated/os.sock",
  "performance-push": "/isolated/pp.sock",
  "performance-stream": "/isolated/ps.sock",
  "telemetry-push": "/isolated/tp.sock",
  "test-recording": "/isolated/tr.sock",
  "video-recording": "/isolated/vr.sock",
  "video-stream": "/isolated/vs.sock",
  "webrtc-stream": "/isolated/ws.sock",
};
const complete: PidFileData = {
  pid: 123,
  startedAt: 100,
  processStartedAt: 90,
  processGenerationToken: "generation-1",
  version: "1.0.0",
  buildId: "build-1",
  entryScript: "/isolated/index.ts",
  socketPath,
  sockets,
  dbPath: "/isolated/existing.db",
  daemonSessionId: "session-1",
  port: 19000,
  launchLogPath: null,
  options: { debug: true, port: 19000, host: "127.0.0.1" },
};

function harness(result: { accepted: boolean; reason?: string } = { accepted: true }) {
  let record: PidFileData | null = null;
  let owner: DaemonStatus = { ...complete, running: true };
  let probeError: Error | undefined;
  const results = new Map<string, unknown>([
    [REPUBLISH, result],
    [PREPARE, { accepted: true, maintenanceToken: "token" }],
    [ADMIT, { accepted: true }],
  ]);
  const client = new FakeDaemonClient({
    daemonMethodResults: results,
    onCallDaemonMethod: async (method) => {
      if (method === REPUBLISH && result.accepted) {
        record = { ...complete };
      }
    },
  });
  const timer = new FakeTimer();
  timer.enableAutoAdvance();
  const manager = new DaemonManager(
    () => client,
    undefined,
    timer,
    "/isolated/lock",
    "/isolated/pid",
    socketPath,
    { findDaemonProcesses: () => [], isProcessRunning: (pid) => pid === owner.pid },
    undefined,
    undefined,
    undefined,
    {
      kill: () => {
        throw new Error("must not signal");
      },
    },
    undefined,
    undefined,
    "linux",
    undefined,
    undefined,
    undefined,
    {
      socketExists: () => true,
      readRecord: () => record,
      probe: async () => {
        if (probeError) {
          throw probeError;
        }
        return owner;
      },
    },
  );
  return {
    manager,
    client,
    results,
    get record() {
      return record;
    },
    setRecord: (value: PidFileData | null) => {
      record = value;
    },
    setOwner: (value: DaemonStatus) => {
      owner = value;
    },
    failProbe: (error: Error) => {
      probeError = error;
    },
  };
}

afterEach(() => {
  executionTracker.clearDaemonMaintenancePreparation();
  executionTracker.clearDaemonRestartPreparation();
});

describe("provider-owned identity recovery", () => {
  test("in-place republish restores complete authoritative PID metadata before success", async () => {
    const h = harness();
    const restart = spyOn(h.manager, "restart");
    expect(await h.manager.status()).toEqual({
      ...complete,
      running: true,
      recovery: { state: "repaired" },
    });
    expect(await h.manager.status()).toEqual({ ...complete, running: true });
    expect(h.client.callDaemonMethodCalls.map((c) => c.method)).toEqual([REPUBLISH]);
    expect(restart).not.toHaveBeenCalled();
  });

  test("maintenance-admitted replacement reuses restart and preserves effective options and database identity", async () => {
    const h = harness({ accepted: false, reason: "republish_unavailable" });
    const restart = spyOn(h.manager, "restart");
    // Only the process stop/start boundaries are fake; exercise the real restart admission.
    const stop = spyOn(h.manager as any, "stopRunningDaemon").mockResolvedValue(undefined);
    const start = spyOn(h.manager, "start").mockImplementation(async (options) => {
      expect(options).toEqual({ ...complete.options, strictPort: true });
      expect((h.manager as any).daemonLaunchEnvironment(options).AUTOMOBILE_DB_PATH).toBe(
        complete.dbPath,
      );
      const replacement = {
        ...complete,
        pid: 124,
        startedAt: 200,
        processGenerationToken: "generation-2",
      };
      h.setOwner({ ...replacement, running: true });
      h.setRecord(replacement);
      return "started";
    });
    expect((await h.manager.status()).recovery).toEqual({ state: "replaced" });
    expect(restart).toHaveBeenCalledTimes(1);
    expect(stop).toHaveBeenCalledWith(
      expect.objectContaining({ pid: 123 }),
      expect.any(Number),
      false,
    );
    expect(start).toHaveBeenCalledTimes(1);
    expect(h.client.callDaemonMethodCalls.map((c) => c.method)).toContain(ADMIT);
    expect(h.client.callDaemonMethodCalls.map((c) => c.method)).not.toContain("ide/prepareRestart");
  });

  for (const reason of ["active_sessions", "active_operations"]) {
    test(`${reason} defer recovery without repair, replacement or signals`, async () => {
      const h = harness({ accepted: false, reason });
      const restart = spyOn(h.manager, "restart");
      expect((await h.manager.status()).recovery).toEqual({ state: "deferred", reason });
      expect(h.record).toBeNull();
      expect(restart).not.toHaveBeenCalled();
    });
    test(`${reason} defer fallback at maintenance admission without stopping`, async () => {
      const h = harness({ accepted: false, reason: "republish_unavailable" });
      h.results.set(PREPARE, { accepted: false, reason });
      const stop = spyOn(h.manager as any, "stopRunningDaemon");
      expect((await h.manager.status()).recovery).toMatchObject({
        state: "deferred",
        reason: expect.stringContaining(reason),
      });
      expect(stop).not.toHaveBeenCalled();
      expect(h.client.callDaemonMethodCalls.some((c) => c.method === ADMIT)).toBe(false);
    });
  }

  test("concurrent status callers share exactly one in-place repair RPC", async () => {
    const h = harness();
    const results = await Promise.all(Array.from({ length: 8 }, () => h.manager.status()));
    expect(results.every((r) => r.recovery?.state === "repaired")).toBe(true);
    expect(h.client.callDaemonMethodCalls.filter((c) => c.method === REPUBLISH)).toHaveLength(1);
  });

  test("concurrent status callers share exactly one maintenance-admitted replacement", async () => {
    const h = harness({ accepted: false, reason: "republish_failed" });
    spyOn(h.manager as any, "stopRunningDaemon").mockResolvedValue(undefined);
    const start = spyOn(h.manager, "start").mockImplementation(async () => {
      h.setRecord(complete);
      return "started";
    });
    await Promise.all(Array.from({ length: 8 }, () => h.manager.status()));
    expect(start).toHaveBeenCalledTimes(1);
    expect(h.client.callDaemonMethodCalls.filter((c) => c.method === ADMIT)).toHaveLength(1);
  });

  test("malformed or unauthenticated socket status returns typed failure and attempts no recovery", async () => {
    for (const error of [
      new ActionableError("no version identity"),
      new ActionableError("malformed startup options"),
    ]) {
      const h = harness();
      h.failProbe(error);
      expect(await h.manager.status()).toEqual({
        running: false,
        recovery: { state: "unauthenticated", reason: error.message },
      });
      expect(h.client.callDaemonMethodCalls).toHaveLength(0);
    }
  });

  test("socket identity alone cannot authorize repair without complete generation fields", async () => {
    const h = harness();
    h.setOwner({ running: true, pid: 123, version: "1.0", socketPath });
    expect((await h.manager.status()).recovery?.state).toBe("unauthenticated");
    expect(h.client.callDaemonMethodCalls).toHaveLength(0);
  });

  test("dead PID metadata recovers the authenticated incumbent instead of unlinking socket", async () => {
    const h = harness();
    h.setRecord({ ...complete, pid: 999 });
    expect((await h.manager.status()).recovery?.state).toBe("repaired");
  });

  test("dead complete PID metadata does not suppress the maintenance replacement fallback", async () => {
    const h = harness({ accepted: false, reason: "republish_unavailable" });
    h.setRecord({ ...complete, pid: 999 });
    spyOn(h.manager as any, "stopRunningDaemon").mockResolvedValue(undefined);
    const start = spyOn(h.manager, "start").mockImplementation(async () => {
      h.setRecord(complete);
      return "started";
    });
    expect((await h.manager.status()).recovery?.state).toBe("replaced");
    expect(start).toHaveBeenCalledTimes(1);
  });

  test("unavailable incumbent database path defers replacement instead of changing databases", async () => {
    const h = harness({ accepted: false, reason: "republish_unavailable" });
    h.setOwner({ ...complete, running: true, dbPath: undefined });
    expect((await h.manager.status()).recovery?.state).toBe("deferred");
    expect(h.client.callDaemonMethodCalls.map((c) => c.method)).toEqual([REPUBLISH]);
  });

  test("live partial early-owner record does not trigger recovery", async () => {
    const h = harness();
    h.setRecord({ pid: 123, startedAt: 100 } as PidFileData);
    expect(await h.manager.status()).toEqual({ pid: 123, startedAt: 100, running: true });
    expect(h.client.callDaemonMethodCalls).toHaveLength(0);
  });

  test("generation changes after republish acknowledgement cannot report success", async () => {
    const h = harness();
    h.setOwner({ ...complete, running: true, processGenerationToken: "other" });
    expect((await h.manager.status()).recovery?.state).toBe("failed");
  });
});

function provider(sessions: unknown[] = []) {
  let writes = 0;
  const server = new UnixSocketServer(
    socketPath,
    "http://localhost:0/mcp",
    {
      isInitialized: () => true,
      getSessionManager: () => ({
        getAllSessions: () => sessions,
        getSession: () => null,
        releaseSession: async () => null,
      }),
      getDevicePool: () => ({
        refreshDevices: async () => 0,
        getStats: () => ({ total: 0, idle: 0, assigned: 0, error: 0 }),
        releaseDevice: async () => {},
      }),
    },
    new FakeTimer(),
    null,
    {
      identityStartedAt: 100,
      processGenerationToken: "provider-generation",
      onRepublishIdentity: async () => {
        writes++;
        return true;
      },
    },
  );
  const params = {
    pid: process.pid,
    startedAt: 100,
    processGenerationToken: "provider-generation",
    version: DAEMON_VERSION,
    ...getCurrentBuildIdentity(),
  };
  const call = (overrides = {}) =>
    (server as any).handleLocalSocketRequest({
      method: REPUBLISH,
      params: { ...params, ...overrides },
    });
  return {
    call,
    get writes() {
      return writes;
    },
  };
}

describe("republish admin RPC admission", () => {
  test("provider coalesces concurrent cross-process requests into one publication", async () => {
    const p = provider();
    expect(await Promise.all([p.call(), p.call(), p.call()])).toEqual(
      Array(3).fill({ accepted: true }),
    );
    expect(p.writes).toBe(1);
  });
  test("provider rejects a stale process generation even during a concurrent repair", async () => {
    const p = provider();
    const first = p.call();
    expect(await p.call({ processGenerationToken: "stale" })).toEqual({
      accepted: false,
      reason: "generation_changed",
    });
    await first;
    expect(p.writes).toBe(1);
  });
  test("provider active-session admission defers in-place publication", async () => {
    const p = provider([{ sessionId: "active" }]);
    expect(await p.call()).toEqual({ accepted: false, reason: "active_sessions" });
    expect(p.writes).toBe(0);
  });
  test("provider active-operation admission defers in-place publication", async () => {
    const p = provider();
    const operation = executionTracker.startExecution("tapOn", "active-operation");
    try {
      expect(await p.call()).toEqual({ accepted: false, reason: "active_operations" });
      expect(p.writes).toBe(0);
    } finally {
      executionTracker.endExecution(operation.id);
    }
  });
});

describe("incumbent-owned atomic publisher", () => {
  test("success waits for complete atomic publication and later cross-process callers do not rewrite", async () => {
    let record: PidFileData | null = null;
    let writes = 0;
    let finish!: () => void;
    const pending = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const io = {
      readRecord: () => record,
      isProcessRunning: () => false,
      writeRecord: async () => {
        writes++;
        await pending;
        record = complete;
      },
    };
    let acknowledged = false;
    const first = republishOwnedIdentity(true, complete, io).then((value) => {
      acknowledged = value;
    });
    await Promise.resolve();
    expect(acknowledged).toBe(false);
    expect(record).toBeNull();
    finish();
    await first;
    expect(acknowledged).toBe(true);
    expect(record).toEqual(complete);
    expect(await republishOwnedIdentity(true, complete, io)).toBe(true);
    expect(writes).toBe(1);
  });

  test("publisher defers startup and preserves another live contender's early record", async () => {
    let writes = 0;
    const io = {
      readRecord: () => ({ ...complete, pid: 999 }),
      isProcessRunning: () => true,
      writeRecord: async () => {
        writes++;
      },
    };
    expect(await republishOwnedIdentity(false, complete, io)).toBe(false);
    expect(await republishOwnedIdentity(true, complete, io)).toBe(false);
    expect(writes).toBe(0);
  });
});
