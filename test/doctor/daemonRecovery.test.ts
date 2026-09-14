import { describe, expect, test } from "bun:test";
import {
  repairDaemon,
  waitForDaemonRecoveryCompletion,
  type DaemonRecoveryDependencies,
  type DaemonRecoveryResult,
} from "../../src/doctor/daemonRecovery";
import type { DaemonHealthReport } from "../../src/daemon/debugTools";
import type { DoctorReport } from "../../src/doctor/types";
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

function doctorReport(platform: "android" | "ios"): DoctorReport {
  return {
    timestamp: "2026-09-14T00:00:00.000Z",
    version: "0.0.0-test",
    platform: "darwin",
    arch: "arm64",
    diagnosticProfile: "post-repair-read-only",
    system: { checks: [] },
    autoMobile: { checks: [] },
    ...(platform === "android" ? { android: { checks: [] } } : { ios: { checks: [] } }),
    summary: { total: 0, passed: 0, warnings: 0, failed: 0, skipped: 0 },
    recommendations: [],
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

  test.each(["android", "ios"] as const)(
    "runs requested %s diagnostics after repair under the shared deadline",
    async (platform) => {
      const calls: Array<{
        diagnosticProfile?: string;
        android?: boolean;
        ios?: boolean;
        deadlineMs?: number;
        signal?: AbortSignal;
      }> = [];
      const result = await repairDaemon(
        { [platform]: true },
        dependencies([healthReport(true), healthReport(true)], {
          runDoctor: async (options) => {
            calls.push(options);
            return doctorReport(platform);
          },
        }),
      );

      expect(result).toMatchObject<Partial<DaemonRecoveryResult>>({
        status: "repaired",
        phase: "complete",
        postRepairDoctor: { profile: "post-repair-read-only", [platform]: true },
      });
      expect(calls).toHaveLength(1);
      expect(calls[0]).toMatchObject({
        diagnosticProfile: "post-repair-read-only",
        [platform]: true,
      });
      expect(calls[0]?.deadlineMs).toBeGreaterThan(0);
      expect(calls[0]?.signal).toBeInstanceOf(AbortSignal);
    },
  );

  test("rejects a repair result when requested diagnostics do not run the selected platform", async () => {
    const result = await repairDaemon(
      { android: true },
      dependencies([healthReport(true), healthReport(true)], {
        runDoctor: async () => doctorReport("ios"),
      }),
    );

    expect(result).toMatchObject<Partial<DaemonRecoveryResult>>({
      status: "failed",
      phase: "verification",
      action: "joined",
      after: { socketConnectable: true },
      nextAction: expect.stringContaining("post-repair doctor did not run"),
    });
    expect(result.postRepairDoctor).toBeUndefined();
  });

  test("returns by the shared deadline when post-repair diagnostics ignore cancellation", async () => {
    const timer = new FakeTimer();
    let cancelled = false;
    const repair = repairDaemon(
      { android: true, timeoutMs: 50 },
      dependencies([healthReport(true), healthReport(true)], {
        timer,
        runDoctor: async ({ signal }) => {
          signal?.addEventListener("abort", () => {
            cancelled = true;
          });
          return await new Promise<DoctorReport>(() => {});
        },
      }),
    );

    await new Promise<void>((resolve) => setImmediate(resolve));
    timer.advanceTime(50);

    await expect(repair).resolves.toMatchObject<Partial<DaemonRecoveryResult>>({
      status: "failed",
      phase: "verification",
      action: "joined",
      nextAction: expect.stringContaining("deadline"),
    });
    expect(cancelled).toBe(true);
  });

  test("waits for a cancellation-aware post-repair doctor lifecycle before reporting repair failure", async () => {
    const timer = new FakeTimer();
    let settled = false;
    const repair = repairDaemon(
      { ios: true, timeoutMs: 50 },
      dependencies([healthReport(true), healthReport(true)], {
        timer,
        runDoctor: async ({ signal }) => {
          await new Promise<void>((resolve) => {
            signal?.addEventListener("abort", resolve, { once: true });
          });
          try {
            signal?.throwIfAborted();
            return doctorReport("ios");
          } finally {
            settled = true;
          }
        },
      }),
    );

    await new Promise<void>((resolve) => setImmediate(resolve));
    timer.advanceTime(50);
    const result = await repair;

    expect(result).toMatchObject<Partial<DaemonRecoveryResult>>({
      status: "failed",
      phase: "verification",
      action: "joined",
    });
    expect(settled).toBe(true);
    await waitForDaemonRecoveryCompletion(result);
  });

  test("does not let a delayed metadata repair publish after the doctor deadline", async () => {
    const timer = new FakeTimer();
    let observedDeadline: number | undefined;
    let metadataWrites = 0;
    let repairStarted: (() => void) | undefined;
    const started = new Promise<void>((resolve) => {
      repairStarted = resolve;
    });
    const repair = repairDaemon(
      { timeoutMs: 50 },
      dependencies([{ ...healthReport(true), pidFileValid: false }], {
        timer,
        repairControlMetadata: async (signal, deadline) => {
          observedDeadline = deadline;
          repairStarted?.();
          await new Promise<void>((resolve) => {
            signal?.addEventListener("abort", resolve, { once: true });
          });
          signal?.throwIfAborted();
          metadataWrites++;
          return true;
        },
      }),
    );

    await started;
    timer.advanceTime(50);
    const result = await repair;

    expect(result).toMatchObject<Partial<DaemonRecoveryResult>>({
      status: "failed",
      phase: "recovery",
      action: "joined",
    });
    expect(observedDeadline).toBe(50);
    await waitForDaemonRecoveryCompletion(result);
    expect(metadataWrites).toBe(0);
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
    let observedSignal: AbortSignal | undefined;
    let lateSuccess = false;
    let beginVerification: (() => void) | undefined;
    const verificationBegan = new Promise<void>((resolve) => {
      beginVerification = resolve;
    });
    const repair = repairDaemon(
      { timeoutMs: 50 },
      dependencies([healthReport(true)], {
        timer,
        verifyProtocol: async (signal) => {
          observedSignal = signal;
          beginVerification?.();
          await new Promise<void>((resolve) => {
            signal?.addEventListener("abort", resolve, { once: true });
          });
          // A non-cooperative verifier could still resolve after its deadline.
          // The recovery result must remain failed, not turn into late success.
          lateSuccess = true;
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
    expect(observedSignal?.aborted).toBe(true);
    expect(lateSuccess).toBe(true);
    expect(recoverCalls).toBe(0);
  });

  test("reports recovery when replacement after a wrong-protocol socket fails", async () => {
    const protocolSignals: AbortSignal[] = [];
    const result = await repairDaemon(
      {},
      dependencies([healthReport(true)], {
        verifyProtocol: async (signal) => {
          if (signal) {
            protocolSignals.push(signal);
          }
          throw new Error("unexpected socket protocol");
        },
        recoverControlState: async (_daemonOptions, isProtocolHealthy, signal) => {
          expect(await isProtocolHealthy()).toBe(false);
          expect(protocolSignals[1]).toBe(signal);
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
