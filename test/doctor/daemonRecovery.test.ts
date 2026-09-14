import { describe, expect, test } from "bun:test";
import {
  repairDaemon,
  waitForDaemonRecoveryCompletion,
  type DaemonRecoveryDependencies,
  type DaemonRecoveryResult,
} from "../../src/doctor/daemonRecovery";
import type { DaemonHealthReport } from "../../src/daemon/debugTools";
import { MAX_SETTIMEOUT_DELAY_MS } from "../../src/utils/SystemTimer";
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
    recoverControlState: async () => "restarted",
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
        recoverControlState: async () => {
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

  test("repairs corrupt metadata from a responsive daemon and verifies the post-repair protocol", async () => {
    const invalidMetadata = { ...healthReport(true), pidFileValid: false };
    let metadataRepairs = 0;
    let protocolChecks = 0;
    const result = await repairDaemon(
      {},
      dependencies([invalidMetadata, healthReport(true)], {
        repairControlMetadata: async () => {
          metadataRepairs++;
          return true;
        },
        verifyProtocol: async () => {
          protocolChecks++;
        },
      }),
    );

    expect(result).toMatchObject<Partial<DaemonRecoveryResult>>({
      status: "repaired",
      phase: "complete",
      action: "joined",
      before: { pidFileValid: false },
      after: { pidFileValid: true, socketConnectable: true },
    });
    expect(metadataRepairs).toBe(1);
    expect(protocolChecks).toBe(1);
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

  test("threads invocation daemon options into recovery", async () => {
    let receivedOptions: { host?: string; port?: number } | undefined;
    const result = await repairDaemon(
      { daemonOptions: { host: "127.0.0.1", port: 4321 } },
      dependencies([healthReport(false), healthReport(true)], {
        recoverControlState: async (daemonOptions) => {
          receivedOptions = daemonOptions;
          return "restarted";
        },
      }),
    );

    expect(result.status).toBe("repaired");
    expect(receivedOptions).toEqual({ host: "127.0.0.1", port: 4321 });
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

  test("bounds the recovery response while retaining cancellation until lifecycle settlement", async () => {
    const timer = new FakeTimer();
    let resolveRecovery: ((result: "restarted") => void) | undefined;
    let settled = false;
    let cancellationObserved = false;
    const repair = repairDaemon(
      { timeoutMs: 50 },
      dependencies([healthReport(false)], {
        timer,
        recoverControlState: async (_options, _isProtocolHealthy, signal) => {
          signal?.addEventListener("abort", () => {
            cancellationObserved = true;
          });
          const result = await new Promise<"restarted">((resolve) => {
            resolveRecovery = resolve;
          });
          settled = true;
          return result;
        },
      }),
    );

    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(resolveRecovery).toBeDefined();
    timer.advanceTime(50);
    const result = await repair;
    expect(result).toMatchObject<Partial<DaemonRecoveryResult>>({
      status: "failed",
      phase: "recovery",
      nextAction: expect.stringContaining("deadline"),
    });
    expect(cancellationObserved).toBe(true);
    expect(settled).toBe(false);
    resolveRecovery!("restarted");
    await waitForDaemonRecoveryCompletion(result);
    expect(settled).toBe(true);
  });

  test("rejects a timeout beyond the setTimeout ceiling before diagnosis", async () => {
    const result = await repairDaemon({ timeoutMs: MAX_SETTIMEOUT_DELAY_MS + 1 });

    expect(result).toMatchObject<Partial<DaemonRecoveryResult>>({
      status: "failed",
      phase: "diagnosis",
      nextAction: expect.stringContaining("positive finite"),
    });
    expect(result.action).toBeUndefined();
  });

  test("rejects an explicit null timeout before diagnosis can mutate control state", async () => {
    let healthChecks = 0;
    let recoveryCalls = 0;
    const result = await repairDaemon(
      { timeoutMs: null },
      dependencies([], {
        getHealthReport: async () => {
          healthChecks++;
          return healthReport(false);
        },
        recoverControlState: async () => {
          recoveryCalls++;
          return "restarted";
        },
      }),
    );

    expect(result).toMatchObject<Partial<DaemonRecoveryResult>>({
      status: "failed",
      phase: "diagnosis",
      nextAction: expect.stringContaining("positive finite"),
    });
    expect(healthChecks).toBe(0);
    expect(recoveryCalls).toBe(0);
  });

  test("reports no action when diagnosis fails", async () => {
    const result = await repairDaemon(
      {},
      dependencies([], {
        getHealthReport: async () => {
          throw new Error("diagnostic unavailable");
        },
      }),
    );

    expect(result).toMatchObject<Partial<DaemonRecoveryResult>>({
      status: "failed",
      phase: "diagnosis",
    });
    expect(result.action).toBeUndefined();
  });

  test("returns a recovery-phase failure instead of claiming repair when restart fails", async () => {
    const result = await repairDaemon(
      {},
      dependencies([healthReport(false)], {
        recoverControlState: async () => {
          throw new Error("no usable daemon executable");
        },
      }),
    );

    expect(result).toMatchObject<Partial<DaemonRecoveryResult>>({
      status: "failed",
      phase: "recovery",
      nextAction: expect.stringContaining("no usable daemon executable"),
    });
    expect(result.action).toBeUndefined();
  });

  test("keeps an expired initial verification in the verification phase", async () => {
    const timer = new FakeTimer();
    let recoverCalls = 0;
    let beginVerification: (() => void) | undefined;
    const verificationBegan = new Promise<void>((resolve) => {
      beginVerification = resolve;
    });
    const repair = repairDaemon(
      { timeoutMs: 50 },
      dependencies([healthReport(true)], {
        timer,
        verifyProtocol: async () => {
          beginVerification?.();
          return await new Promise<void>(() => {});
        },
        recoverControlState: async () => {
          recoverCalls++;
          return "restarted";
        },
      }),
    );

    await verificationBegan;
    timer.advanceTime(50);

    await expect(repair).resolves.toMatchObject<Partial<DaemonRecoveryResult>>({
      status: "failed",
      phase: "verification",
      action: "joined",
      nextAction: expect.stringContaining("--cli doctor --repair"),
    });
    expect(recoverCalls).toBe(0);
  });

  test("reports recovery when replacement after a wrong-protocol socket fails", async () => {
    const result = await repairDaemon(
      {},
      dependencies([healthReport(true)], {
        verifyProtocol: async () => {
          throw new Error("unexpected socket protocol");
        },
        recoverControlState: async (_daemonOptions, isProtocolHealthy) => {
          expect(await isProtocolHealthy()).toBe(false);
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

  test("reports a completed restart when replacement verification fails", async () => {
    const result = await repairDaemon(
      {},
      dependencies([healthReport(true)], {
        verifyProtocol: async () => {
          throw new Error("incompatible replacement");
        },
      }),
    );

    expect(result).toMatchObject<Partial<DaemonRecoveryResult>>({
      status: "failed",
      phase: "verification",
      action: "restarted",
      nextAction: expect.stringContaining("--daemon diagnose"),
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
