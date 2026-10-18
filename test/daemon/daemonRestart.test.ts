import { afterEach, describe, expect, test } from "bun:test";
import {
  mergeRestartOptions,
  restartAcceptanceSession,
  restartAdmitted,
  restartDaemon,
  restartResultFromStart,
  type DaemonRestartHost,
} from "../../src/daemon/daemonRestart";
import {
  DAEMON_RESTART_HANDOFF_DELAY_MS,
  DAEMON_SHUTDOWN_TIMEOUT_MS,
} from "../../src/daemon/constants";
import { DaemonRestartDeferredError } from "../../src/daemon/daemonRestartAdmission";
import { DAEMON_LIVE_ACCEPTANCE_STARTUP_SECRET_ENV } from "../../src/daemon/liveAcceptanceCapability";
import type { DaemonOptions, DaemonStatus } from "../../src/daemon/types";
import { FakeTimer } from "../fakes/FakeTimer";

type StartResult = "started" | "joined" | "replaced";

/** Records every lifecycle call so tests assert ordering, not implementation. */
class FakeRestartHost implements DaemonRestartHost {
  readonly calls: string[] = [];
  readonly timer = new FakeTimer();
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
  async prepareDaemonForConditionalRestart(): Promise<{ accepted: boolean; reason?: never }> {
    return { accepted: true };
  }
  async prepareIdentityRecoveryRestart(): Promise<{ accepted: boolean }> {
    return { accepted: true };
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
