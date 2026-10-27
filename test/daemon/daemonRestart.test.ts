import { afterEach, describe, expect, test } from "bun:test";
import {
  mergeRestartOptions,
  restartAcceptanceSession,
  restartAdmitted,
  restartDaemon,
  restartExpectedGeneration,
  restartResultFromStart,
  type DaemonRestartHost,
} from "../../src/daemon/daemonRestart";
import {
  DAEMON_RESTART_HANDOFF_DELAY_MS,
  DAEMON_SHUTDOWN_TIMEOUT_MS,
} from "../../src/daemon/wire/constants";
import {
  DaemonRestartDeferredError,
  type DaemonRestartPreparation,
} from "../../src/daemon/daemonRestartAdmission";
import { resolveDaemonInstallSpecifier } from "../../src/constants/release";
import {
  DefaultTakeoverDeferralLedger,
  TAKEOVER_ACTIVE_OPERATIONS_TIME_BOUND_MS,
  TAKEOVER_DEFERRAL_TIME_BOUND_MS,
} from "../../src/daemon/manager/TakeoverDeferralLedger";
import { DAEMON_LIVE_ACCEPTANCE_STARTUP_SECRET_ENV } from "../../src/daemon/liveAcceptanceCapability";
import type { DaemonOptions, DaemonStatus } from "../../src/daemon/types";
import { FakeTimer } from "../fakes/FakeTimer";
import { FakeStartupFailureStore } from "../fakes/FakeStartupFailureStore";

type StartResult = "started" | "joined" | "replaced";

/** Records every lifecycle call so tests assert ordering, not implementation. */
class FakeRestartHost implements DaemonRestartHost {
  readonly calls: string[] = [];
  readonly timer = new FakeTimer();
  readonly deferralStore = new FakeStartupFailureStore();
  readonly takeoverDeferrals = new DefaultTakeoverDeferralLedger(this.deferralStore);
  preparation: DaemonRestartPreparation = { accepted: true };
  preparationError: Error | undefined;
  status: DaemonStatus = { running: false };
  recorded: DaemonStatus = { running: false };
  locked = false;
  lockAvailable = true;
  startResult: StartResult = "started";
  runningPids = new Set<number>();
  admission: { accepted: boolean; reason?: string } = { accepted: true };
  startedWith: DaemonOptions[] = [];

  constructor() {
    this.timer.enableAutoAdvance();
  }

  log(message: string): void {
    this.calls.push(`log:${message}`);
  }
  now(): number {
    return this.timer.now();
  }
  async sleep(ms: number): Promise<void> {
    this.calls.push(`sleep:${ms}`);
    await this.timer.sleep(ms);
  }
  acquireLock(): boolean {
    this.calls.push("acquireLock");
    if (!this.lockAvailable) {
      return false;
    }
    this.locked = true;
    return true;
  }
  releaseLock(): void {
    this.calls.push("releaseLock");
    this.locked = false;
  }
  createClient(): never {
    throw new Error("createClient is not expected in these tests");
  }
  async lifecycleStatus(): Promise<DaemonStatus> {
    return this.status;
  }
  recordedStatus(): DaemonStatus {
    return this.recorded;
  }
  async probeRecoveryOwner(): Promise<DaemonStatus> {
    return this.status;
  }
  isRecoveryOwnerReference(): boolean {
    return false;
  }
  isRecoveryOwner(): boolean {
    return false;
  }
  hasPublishedRecoveryIdentity(): boolean {
    return false;
  }
  isSameDaemonGeneration(current: DaemonStatus, expected: DaemonStatus): boolean {
    return current.pid === expected.pid;
  }
  isConfirmedDifferentDaemonGeneration(
    expected: { pid: number },
    candidate: { pid: number },
  ): boolean {
    return expected.pid !== candidate.pid;
  }
  daemonProcessRecordFromStatus(status: DaemonStatus): {
    pid: number;
    ppid: number;
    command: string;
  } {
    return { pid: status.pid!, ppid: 0, command: "" };
  }
  isProcessRunning(pid: number): boolean {
    return this.runningPids.has(pid);
  }
  signalProcess(pid: number, signal: NodeJS.Signals): void {
    this.calls.push(`signal:${pid}:${signal}`);
  }
  async stop(timeout?: number): Promise<void> {
    this.calls.push(`stop:${timeout}`);
  }
  async stopRunningDaemon(): Promise<void> {
    this.calls.push("stopRunningDaemon");
  }
  async stopNamespaceOrphansForExplicitRestart(): Promise<void> {
    this.calls.push("stopOrphans");
  }
  async awaitRestartCleanup(ops: ReadonlyArray<() => void | Promise<void>>): Promise<void> {
    this.calls.push("cleanup");
    for (const op of ops) {
      await op();
    }
  }
  async waitForStop(): Promise<{ stopped: boolean; replacedByOtherGeneration: boolean }> {
    return { stopped: true, replacedByOtherGeneration: false };
  }
  async assertNoSurvivingDaemonBeforeRestart(): Promise<void> {
    this.calls.push("assertNoSurvivor");
  }
  async cleanupAcceptanceRestartFiles(): Promise<void> {
    this.calls.push("cleanupFiles");
  }
  async verifyDaemonGenerationBeforeSignal(): Promise<boolean> {
    return true;
  }
  async prepareDaemonForConditionalRestart(): Promise<DaemonRestartPreparation> {
    if (this.preparationError) {
      throw this.preparationError;
    }
    return this.preparation;
  }
  async prepareIdentityRecoveryRestart(): Promise<DaemonRestartPreparation> {
    return this.prepareDaemonForConditionalRestart();
  }
  async admitMaintenanceRestart(): Promise<{ accepted: boolean; reason?: never }> {
    this.calls.push("admit");
    return this.admission as { accepted: boolean; reason?: never };
  }
  async start(options: DaemonOptions): Promise<StartResult> {
    this.calls.push("start");
    this.startedWith.push(options);
    return this.startResult;
  }
  async startWithRunningOptions(options: DaemonOptions): Promise<StartResult> {
    this.calls.push("startWithRunningOptions");
    this.startedWith.push(options);
    return this.startResult;
  }
  async startUnlocked(options: DaemonOptions): Promise<StartResult> {
    this.calls.push("startUnlocked");
    this.startedWith.push(options);
    return this.startResult;
  }
}

describe("daemonRestart helpers", () => {
  test("restartResultFromStart maps joined and everything else to restarted", () => {
    expect(restartResultFromStart("joined")).toBe("joined");
    expect(restartResultFromStart("started")).toBe("restarted");
    expect(restartResultFromStart("replaced")).toBe("restarted");
  });

  test("mergeRestartOptions always forces strictPort", () => {
    expect(mergeRestartOptions({ port: 1 }, {}).strictPort).toBe(true);
  });
});

describe("restartDaemon (namespace restart)", () => {
  test("stops the running daemon, waits the handoff delay, then restarts with its options", async () => {
    const host = new FakeRestartHost();
    host.status = { running: true, pid: 10, port: 4100 };
    host.recorded = { running: true, pid: 11 };

    const result = await restartDaemon(host, {});

    expect(result).toBe("restarted");
    const ordered = host.calls.filter((c) => !c.startsWith("log:"));
    expect(ordered).toEqual([
      "cleanup",
      `stop:${DAEMON_SHUTDOWN_TIMEOUT_MS}`,
      "stopOrphans",
      "assertNoSurvivor",
      `sleep:${DAEMON_RESTART_HANDOFF_DELAY_MS}`,
      "startWithRunningOptions",
    ]);
    expect(host.startedWith[0]).toMatchObject({ port: 4100, strictPort: true });
  });

  test("starts a fresh daemon when none is running", async () => {
    const host = new FakeRestartHost();

    await restartDaemon(host, { debug: true } as DaemonOptions);

    expect(host.calls).toContain("start");
    expect(host.calls).not.toContain("startWithRunningOptions");
    expect(host.calls.some((c) => c.startsWith("stop:"))).toBe(false);
  });

  test("refuses to start a replacement when the previous daemon pid survives", async () => {
    const host = new FakeRestartHost();
    host.status = { running: true, pid: 10 };
    host.runningPids.add(10);

    await expect(restartDaemon(host, {})).rejects.toThrow(/could not confirm/);
    expect(host.calls).not.toContain("startWithRunningOptions");
  });

  test("fails when the successor reuses the previous daemon generation", async () => {
    const host = new FakeRestartHost();
    host.status = { running: true, pid: 10 };
    host.recorded = { running: true, pid: 10 };

    await expect(restartDaemon(host, {})).rejects.toThrow(/did not replace/);
  });

  test("joins the current generation when the expected one is already gone", async () => {
    const host = new FakeRestartHost();
    host.status = { running: true, pid: 20 };

    const result = await restartDaemon(host, {}, { running: true, pid: 10 });

    expect(result).toBe("joined");
    expect(host.calls).not.toContain("start");
  });

  test("restarts a verified expected generation without a second SIGTERM", async () => {
    const host = new FakeRestartHost();
    host.status = { running: true, pid: 10 };

    const result = await restartDaemon(host, {}, { running: true, pid: 10 });

    expect(result).toBe("restarted");
    expect(host.calls).toContain("stopRunningDaemon");
    expect(host.calls).toContain("startWithRunningOptions");
  });
});

describe("restartExpectedGeneration deferral bound (#13792)", () => {
  const firstDeferredAtMs = Date.UTC(2026, 9, 20);

  function deferredHost(): FakeRestartHost {
    const host = new FakeRestartHost();
    host.timer.setCurrentTime(firstDeferredAtMs);
    host.status = {
      running: true,
      pid: 13792,
      version: "0.0.1",
      startedAt: 100,
      processGenerationToken: "original-generation",
    };
    return host;
  }

  function attempt(host: FakeRestartHost, recovering: boolean): Promise<"restarted" | "joined"> {
    return restartExpectedGeneration(host, host.status, host.status, {}, recovering);
  }

  function guidance(
    host: FakeRestartHost,
    attempts: number,
    original: DaemonRestartDeferredError,
  ): string {
    return new DaemonRestartDeferredError(
      `daemon pid ${host.status.pid} (version ${host.status.version}) has deferred this restart ` +
        `${attempts} times since ${new Date(firstDeferredAtMs).toISOString()} (${original.message}); ` +
        `it is never stopped automatically — run \`bunx ${resolveDaemonInstallSpecifier()} --daemon restart\` ` +
        "to replace it once no device operation is active",
    ).message;
  }

  function expectNoLifecycleCalls(host: FakeRestartHost): void {
    expect(host.calls.filter((call) => !call.startsWith("log:"))).toEqual([]);
    expect(host.startedWith).toEqual([]);
  }

  test("recovering=true: thrown active-operations refusal waits ten minutes before guidance", async () => {
    const host = deferredHost();
    const original = new DaemonRestartDeferredError("active_operations", "active_operations");
    host.preparationError = original;

    await expect(attempt(host, true)).rejects.toBe(original);
    await expect(attempt(host, true)).rejects.toBe(original);
    await expect(attempt(host, true)).rejects.toBe(original);
    host.timer.advanceTime(TAKEOVER_DEFERRAL_TIME_BOUND_MS);
    await expect(attempt(host, true)).rejects.toBe(original);
    host.timer.advanceTime(
      TAKEOVER_ACTIVE_OPERATIONS_TIME_BOUND_MS - TAKEOVER_DEFERRAL_TIME_BOUND_MS - 1,
    );
    await expect(attempt(host, true)).rejects.toBe(original);
    host.timer.advanceTime(1);

    await expect(attempt(host, true)).rejects.toMatchObject({
      message: guidance(host, 6, original),
    });
    expectNoLifecycleCalls(host);
  });

  for (const recovering of [false, true]) {
    describe(`recovering=${recovering}`, () => {
      test("unavailable admission preserves the original error twice, then gives guidance", async () => {
        const host = deferredHost();
        const original = new DaemonRestartDeferredError("safe-restart admission is unavailable");
        host.preparationError = original;

        await expect(attempt(host, recovering)).rejects.toBe(original);
        await expect(attempt(host, recovering)).rejects.toBe(original);
        const third = attempt(host, recovering);
        await expect(third).rejects.toBeInstanceOf(DaemonRestartDeferredError);
        await expect(third).rejects.toMatchObject({ message: guidance(host, 3, original) });
        expectNoLifecycleCalls(host);
      });

      test.each([
        ["shutdown_unavailable", "the daemon could not initiate its own shutdown"],
        [undefined, "the daemon returned an unrecognized safe-restart admission result"],
      ] as const)("%s admission gives guidance on the third attempt", async (reason, message) => {
        const host = deferredHost();
        host.preparation = { accepted: false, reason };
        const original = new DaemonRestartDeferredError(message);

        await expect(attempt(host, recovering)).rejects.toMatchObject({
          message: original.message,
        });
        await expect(attempt(host, recovering)).rejects.toMatchObject({
          message: original.message,
        });
        await expect(attempt(host, recovering)).rejects.toMatchObject({
          message: guidance(host, 3, original),
        });
        expectNoLifecycleCalls(host);
      });

      test("unavailable admission also gives guidance at the elapsed-time bound", async () => {
        const host = deferredHost();
        const original = new DaemonRestartDeferredError("safe-restart admission is unavailable");
        host.preparationError = original;
        await expect(attempt(host, recovering)).rejects.toBe(original);
        host.timer.advanceTime(TAKEOVER_DEFERRAL_TIME_BOUND_MS);

        await expect(attempt(host, recovering)).rejects.toMatchObject({
          message: guidance(host, 2, original),
        });
        expectNoLifecycleCalls(host);
      });

      test("active operations defer until the ten-minute bound without stopping", async () => {
        const host = deferredHost();
        host.preparation = { accepted: false, reason: "active_operations" };
        const message = "a device operation is active";
        const original = new DaemonRestartDeferredError(message);
        await expect(attempt(host, recovering)).rejects.toMatchObject({
          message: original.message,
        });
        await expect(attempt(host, recovering)).rejects.toMatchObject({
          message: original.message,
        });
        host.timer.advanceTime(TAKEOVER_ACTIVE_OPERATIONS_TIME_BOUND_MS - 1);
        await expect(attempt(host, recovering)).rejects.toMatchObject({
          message: original.message,
        });
        host.timer.advanceTime(1);

        await expect(attempt(host, recovering)).rejects.toMatchObject({
          message: guidance(host, 4, original),
        });
        expectNoLifecycleCalls(host);
      });

      test.each([
        { pid: 13793 },
        { processGenerationToken: "successor-generation" },
        { startedAt: 200 },
      ])("a different generation %j resets the count to one", async (generation) => {
        const host = deferredHost();
        const original = new DaemonRestartDeferredError("safe-restart admission is unavailable");
        host.preparationError = original;
        await expect(attempt(host, recovering)).rejects.toBe(original);
        await expect(attempt(host, recovering)).rejects.toBe(original);
        host.status = { ...host.status, ...generation };

        await expect(attempt(host, recovering)).rejects.toBe(original);
        expect(JSON.parse(host.deferralStore.contents ?? "null")).toMatchObject({
          key: { ...generation },
          attempts: 1,
        });
        expectNoLifecycleCalls(host);
      });

      test("accepted admission clears the ledger before stopping and restarts", async () => {
        const host = deferredHost();
        host.preparation = { accepted: false, reason: "shutdown_unavailable" };
        await expect(attempt(host, recovering)).rejects.toThrow();
        host.preparation = { accepted: true };
        host.stopRunningDaemon = async () => {
          expect(host.deferralStore.contents).toBeNull();
          host.calls.push("stopRunningDaemon");
        };

        expect(await attempt(host, recovering)).toBe("restarted");
        expect(host.deferralStore.contents).toBeNull();
        expect(host.calls).toEqual([
          "stopRunningDaemon",
          `sleep:${DAEMON_RESTART_HANDOFF_DELAY_MS}`,
          recovering ? "startUnlocked" : "startWithRunningOptions",
        ]);
        host.preparation = { accepted: false, reason: "shutdown_unavailable" };
        await expect(attempt(host, recovering)).rejects.toThrow();
        expect(JSON.parse(host.deferralStore.contents ?? "null")).toMatchObject({ attempts: 1 });
      });

      test.each(["generation_changed", "restart_pending"] as const)(
        "%s joins without writing the ledger",
        async (reason) => {
          const host = deferredHost();
          host.preparation = { accepted: false, reason: "shutdown_unavailable" };
          await expect(attempt(host, recovering)).rejects.toThrow();
          const before = host.deferralStore.contents;
          expect(before).not.toBeNull();
          host.preparation = { accepted: false, reason };

          expect(await attempt(host, recovering)).toBe("joined");
          expect(host.deferralStore.contents).toBe(before);
          expectNoLifecycleCalls(host);
        },
      );

      test("other preparation errors propagate unchanged without recording a deferral", async () => {
        const host = deferredHost();
        const original = new Error("unexpected preparation failure");
        host.preparationError = original;

        await expect(attempt(host, recovering)).rejects.toBe(original);
        expect(host.deferralStore.contents).toBeNull();
        expectNoLifecycleCalls(host);
      });
    });
  }
});

describe("restartAdmitted", () => {
  test("requires a maintenance token", async () => {
    await expect(restartAdmitted(new FakeRestartHost(), {}, "")).rejects.toThrow(
      /maintenance admission token/,
    );
  });

  test("defers when another lifecycle transition holds the lock", async () => {
    const host = new FakeRestartHost();
    host.lockAvailable = false;

    await expect(restartAdmitted(host, {}, "token")).rejects.toBeInstanceOf(
      DaemonRestartDeferredError,
    );
  });

  test("defers and releases the lock when admission is refused", async () => {
    const host = new FakeRestartHost();
    host.status = { running: true, pid: 10 };
    host.admission = { accepted: false, reason: "maintenance_token_invalid" };

    await expect(restartAdmitted(host, {}, "token")).rejects.toBeInstanceOf(
      DaemonRestartDeferredError,
    );
    expect(host.locked).toBe(false);
  });

  test("stops the admitted generation and restarts unlocked", async () => {
    const host = new FakeRestartHost();
    host.status = { running: true, pid: 10 };

    const result = await restartAdmitted(host, {}, "token");

    expect(result).toBe("restarted");
    expect(host.calls.filter((c) => !c.startsWith("log:"))).toEqual([
      "acquireLock",
      "admit",
      "stopRunningDaemon",
      `sleep:${DAEMON_RESTART_HANDOFF_DELAY_MS}`,
      "startUnlocked",
      "releaseLock",
    ]);
    expect(host.startedWith[0]).toMatchObject({ strictPort: true });
  });
});

describe("restartAcceptanceSession", () => {
  const original = process.env[DAEMON_LIVE_ACCEPTANCE_STARTUP_SECRET_ENV];
  afterEach(() => {
    if (original === undefined) {
      delete process.env[DAEMON_LIVE_ACCEPTANCE_STARTUP_SECRET_ENV];
    } else {
      process.env[DAEMON_LIVE_ACCEPTANCE_STARTUP_SECRET_ENV] = original;
    }
  });

  const scope = {} as Parameters<typeof restartAcceptanceSession>[1];

  test("requires the live-acceptance startup capability", async () => {
    delete process.env[DAEMON_LIVE_ACCEPTANCE_STARTUP_SECRET_ENV];
    const host = new FakeRestartHost();

    await expect(restartAcceptanceSession(host, scope)).rejects.toThrow(/startup capability/);
    expect(host.calls).not.toContain("acquireLock");
  });

  test("fails when the startup lock is unavailable", async () => {
    process.env[DAEMON_LIVE_ACCEPTANCE_STARTUP_SECRET_ENV] = "t".repeat(48);
    const host = new FakeRestartHost();
    host.lockAvailable = false;

    await expect(restartAcceptanceSession(host, scope)).rejects.toThrow(/startup lock/);
  });

  test("requires the admitted generation to be running and releases the lock", async () => {
    process.env[DAEMON_LIVE_ACCEPTANCE_STARTUP_SECRET_ENV] = "t".repeat(48);
    const host = new FakeRestartHost();

    await expect(restartAcceptanceSession(host, scope)).rejects.toThrow(/to be running/);
    expect(host.locked).toBe(false);
  });
});
