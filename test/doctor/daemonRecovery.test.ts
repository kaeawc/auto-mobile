import { describe, expect, test } from "bun:test";
import {
  repairDaemon,
  type DaemonRecoveryDependencies,
  type DaemonRecoveryResult,
} from "../../src/doctor/daemonRecovery";
import type { DaemonHealthReport } from "../../src/daemon/debugTools";
import { FakeTimer } from "../fakes/FakeTimer";

function healthReport(connectable: boolean): DaemonHealthReport {
  return {
    timestamp: "2026-09-14T00:00:00.000Z",
    daemonRunning: connectable,
    socketExists: connectable,
    socketAccessible: connectable,
    pidFileExists: connectable,
    pidFileValid: connectable,
    daemonPid: connectable ? 1234 : undefined,
    daemonPort: connectable ? 3000 : undefined,
    socketConnectable: connectable,
    recommendations: [],
  };
}

function dependencies(
  reports: DaemonHealthReport[],
  overrides: Partial<DaemonRecoveryDependencies> = {},
): DaemonRecoveryDependencies {
  return {
    getHealthReport: async () => reports.shift() ?? healthReport(true),
    restart: async () => "restarted",
    verifyProtocol: async () => {},
    ...overrides,
  };
}

describe("repairDaemon", () => {
  test("joins a healthy daemon without restarting device work", async () => {
    let restartCalls = 0;
    const result = await repairDaemon(
      {},
      dependencies([healthReport(true), healthReport(true)], {
        restart: async () => {
          restartCalls++;
          return "restarted";
        },
      }),
    );

    expect(result).toMatchObject<Partial<DaemonRecoveryResult>>({
      status: "repaired",
      phase: "complete",
      action: "joined",
      before: { socketConnectable: true },
      after: { socketConnectable: true },
    });
    expect(restartCalls).toBe(0);
  });

  test("restarts a daemon with unusable control state and verifies the replacement", async () => {
    let protocolChecks = 0;
    const result = await repairDaemon(
      {},
      dependencies([healthReport(false), healthReport(true)], {
        verifyProtocol: async () => {
          protocolChecks++;
        },
      }),
    );

    expect(result).toMatchObject<Partial<DaemonRecoveryResult>>({
      status: "repaired",
      phase: "complete",
      action: "restarted",
      before: { socketConnectable: false },
      after: { socketConnectable: true },
    });
    expect(protocolChecks).toBe(1);
  });

  test("restarts once when a connectable socket fails the daemon protocol", async () => {
    let protocolChecks = 0;
    const result = await repairDaemon(
      {},
      dependencies([healthReport(true), healthReport(true)], {
        verifyProtocol: async () => {
          protocolChecks++;
          if (protocolChecks === 1) {
            throw new Error("unexpected socket protocol");
          }
        },
      }),
    );

    expect(result).toMatchObject<Partial<DaemonRecoveryResult>>({
      status: "repaired",
      action: "restarted",
      after: { socketConnectable: true },
    });
    expect(protocolChecks).toBe(2);
  });

  test("reports the diagnosis phase when the shared deadline expires", async () => {
    const timer = new FakeTimer();
    const pendingHealthReport = new Promise<DaemonHealthReport>(() => {});
    const repair = repairDaemon(
      { timeoutMs: 50 },
      dependencies([], {
        getHealthReport: async () => pendingHealthReport,
        timer,
      }),
    );

    timer.advanceTime(50);

    await expect(repair).resolves.toMatchObject<Partial<DaemonRecoveryResult>>({
      status: "failed",
      phase: "diagnosis",
      nextAction: expect.stringContaining("deadline"),
    });
  });

  test("returns a recovery-phase failure instead of claiming repair when restart fails", async () => {
    const result = await repairDaemon(
      {},
      dependencies([healthReport(false)], {
        restart: async () => {
          throw new Error("no usable daemon executable");
        },
      }),
    );

    expect(result).toMatchObject<Partial<DaemonRecoveryResult>>({
      status: "failed",
      phase: "recovery",
      nextAction: expect.stringContaining("no usable daemon executable"),
    });
  });

  test("reports recovery when replacement after a wrong-protocol socket fails", async () => {
    const result = await repairDaemon(
      {},
      dependencies([healthReport(true)], {
        verifyProtocol: async () => {
          throw new Error("unexpected socket protocol");
        },
        restart: async () => {
          throw new Error("replacement launch failed");
        },
      }),
    );

    expect(result).toMatchObject<Partial<DaemonRecoveryResult>>({
      status: "failed",
      phase: "recovery",
      nextAction: expect.stringContaining("replacement launch failed"),
    });
  });

  test("does not report success when the restarted daemon has no usable socket", async () => {
    const result = await repairDaemon({}, dependencies([healthReport(false), healthReport(false)]));

    expect(result).toMatchObject<Partial<DaemonRecoveryResult>>({
      status: "failed",
      phase: "verification",
      after: { socketConnectable: false },
    });
  });
});
