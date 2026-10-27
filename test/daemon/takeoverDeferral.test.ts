import { afterEach, describe, expect, mock, spyOn, test } from "bun:test";
import { DaemonStart, type DaemonStartHost } from "../../src/daemon/manager/DaemonStart";
import {
  DefaultTakeoverDeferralLedger,
  TAKEOVER_ACTIVE_OPERATIONS_TIME_BOUND_MS,
  TAKEOVER_DEFERRAL_TIME_BOUND_MS,
} from "../../src/daemon/manager/TakeoverDeferralLedger";
import { DAEMON_VERSION_RESTART_COOLDOWN_MS } from "../../src/daemon/wire/constants";
import {
  DaemonRestartDeferredError,
  type DaemonRestartPreparation,
} from "../../src/daemon/daemonRestartAdmission";
import type { DaemonStatus } from "../../src/daemon/types";
import { resolveDaemonInstallSpecifier } from "../../src/constants/release";
import { logger } from "../../src/utils/logger";
import { FakeTimer } from "../fakes/FakeTimer";
import { FakeStartupFailureStore } from "../fakes/FakeStartupFailureStore";
import { FakeDaemonExitRecordFileSystem } from "../fakes/SafeDaemonManager";

function unused(): never {
  throw new Error("unexpected launch or recovery");
}

function fixture(store = new FakeStartupFailureStore()) {
  const timer = new FakeTimer();
  timer.advanceTime(1_000_000);
  const status: DaemonStatus = {
    running: true,
    pid: 1001,
    version: "0.0.0",
    startedAt: 1,
    processGenerationToken: "linux:old-owner",
  };
  const prepare = mock(async (): Promise<DaemonRestartPreparation> => {
    throw new DaemonRestartDeferredError("safe-restart admission is unavailable");
  });
  const stop = mock(async () => {});
  const host: DaemonStartHost = {
    takeoverDeferrals: new DefaultTakeoverDeferralLedger(store),
    timer,
    socketPath: "/memory/daemon.sock",
    seams: {
      exitRecordFileSystem: new FakeDaemonExitRecordFileSystem(),
      currentBuildId: () => "memory-build",
      nextLaunchNonce: unused,
      portFreeProbe: unused,
      launchLogFileSystem: { openSync: unused, closeSync: unused },
      launchWorkingDirectory: unused,
    },
    acquireLock: () => true,
    releaseLock: () => {},
    startByAwaitingLockHolder: unused,
    startUnlocked: unused,
    start: unused,
    lifecycleStatus: async () => status,
    throwIfRecoveryCancelled: () => {},
    verifyDaemonGenerationBeforeSignal: async () => true,
    daemonProcessRecordFromStatus: () => ({ pid: 1001, ppid: 1, command: "memory-daemon" }),
    probeNamespaceOwner: unused,
    waitForExistingDaemon: unused,
    remainingTime: unused,
    startIdentityRecovery: unused,
    prepareDaemonForConditionalRestart: prepare,
    stopRunningDaemon: stop,
    assertNoSurvivingDaemonBeforeRestart: async () => {},
    findLiveDaemonProcessesForStart: unused,
    inheritExitSettings: unused,
    withDaemonOptions: unused,
    resolveLaunchCommand: unused,
    daemonLaunchEnvironment: unused,
    heldLockLogPath: undefined,
    daemonLaunchLogPath: unused,
    launchWithExtractionRetry: unused,
    tryJoinPeerDaemonAfterSpawnExit: unused,
  };
  return { host, status, timer, store, prepare, stop, start: new DaemonStart(host) };
}

describe("strictly older takeover deferrals", () => {
  afterEach(() => mock.restore());

  test("third unavailable deferral across CLI launches names the owner and replacement command", async () => {
    const store = new FakeStartupFailureStore();
    const warn = spyOn(logger, "warn").mockImplementation(() => {});
    for (let attempt = 1; attempt <= 3; attempt++) {
      const f = fixture(store);
      const outcome = await f.start.startUnlocked({}).catch((error: unknown) => error);
      expect(outcome).toBeInstanceOf(DaemonRestartDeferredError);
      expect(f.stop).not.toHaveBeenCalled();
      if (attempt < 3) {
        expect(String(outcome)).toBe(
          String(new DaemonRestartDeferredError("safe-restart admission is unavailable")),
        );
      } else {
        expect(String(outcome)).toContain("older daemon pid 1001 (version 0.0.0)");
        expect(String(outcome)).toContain("3 times since 1970-01-01T00:16:40.000Z");
        expect(String(outcome)).toContain("never stopped automatically");
        expect(String(outcome)).toContain(
          `bunx ${resolveDaemonInstallSpecifier()} --daemon restart`,
        );
        expect(warn).toHaveBeenCalledTimes(1);
      }
    }
  });

  test.each([
    ["active_operations", "a device operation is active"],
    ["shutdown_unavailable", "the daemon could not initiate its own shutdown"],
    [undefined, "the daemon returned an unrecognized safe-restart admission result"],
  ] as const)(
    "below-bound %s preserves its old message and never stops",
    async (reason, message) => {
      const f = fixture();
      f.prepare.mockResolvedValue({ accepted: false, reason });
      const outcome = await f.start.startUnlocked({}).catch((error: unknown) => error);
      expect(String(outcome)).toBe(String(new DaemonRestartDeferredError(message)));
      expect(f.stop).not.toHaveBeenCalled();
      expect(f.store.contents).toContain('"attempts":1');
    },
  );

  test.each(["shutdown_unavailable", undefined] as const)(
    "third %s response reports the bound and never stops",
    async (reason) => {
      const f = fixture();
      f.prepare.mockResolvedValue({ accepted: false, reason });
      spyOn(logger, "warn").mockImplementation(() => {});
      for (let attempt = 0; attempt < 2; attempt++) {
        await expect(f.start.startUnlocked({})).rejects.toBeInstanceOf(DaemonRestartDeferredError);
      }
      await expect(f.start.startUnlocked({})).rejects.toThrow("3 times since");
      expect(f.stop).not.toHaveBeenCalled();
    },
  );

  test("elapsed unavailable bound reports even when only two attempts have occurred", async () => {
    const f = fixture();
    spyOn(logger, "warn").mockImplementation(() => {});
    await expect(f.start.startUnlocked({})).rejects.toThrow(
      "safe-restart admission is unavailable",
    );
    f.timer.advanceTime(TAKEOVER_DEFERRAL_TIME_BOUND_MS);
    await expect(f.start.startUnlocked({})).rejects.toThrow("2 times since");
    expect(f.stop).not.toHaveBeenCalled();
  });

  test("active operations defer quietly through repeated attempts until ten minutes", async () => {
    const f = fixture();
    f.prepare.mockResolvedValue({ accepted: false, reason: "active_operations" });
    const warn = spyOn(logger, "warn").mockImplementation(() => {});
    for (let attempt = 0; attempt < 3; attempt++) {
      await expect(f.start.startUnlocked({})).rejects.toThrow("a device operation is active");
    }
    expect(warn).not.toHaveBeenCalled();
    f.timer.advanceTime(TAKEOVER_ACTIVE_OPERATIONS_TIME_BOUND_MS);
    await expect(f.start.startUnlocked({})).rejects.toThrow("4 times since");
    expect(warn).toHaveBeenCalledTimes(1);
    expect(f.stop).not.toHaveBeenCalled();
  });

  test("cooldown does not record a deferral or stop the incumbent", async () => {
    const f = fixture();
    f.status.startedAt = f.timer.now() - DAEMON_VERSION_RESTART_COOLDOWN_MS + 1;
    spyOn(logger, "warn").mockImplementation(() => {});
    const record = spyOn(f.host.takeoverDeferrals, "recordDeferral");
    await expect(f.start.startUnlocked({})).rejects.toThrow("restart is in cooldown");
    expect(record).not.toHaveBeenCalled();
    expect(f.store.contents).toBeNull();
    expect(f.prepare).not.toHaveBeenCalled();
    expect(f.stop).not.toHaveBeenCalled();
  });

  test.each(["generation_changed", "restart_pending"] as const)(
    "%s joins a successor without counting or stopping",
    async (reason) => {
      const f = fixture();
      f.prepare.mockResolvedValue({ accepted: false, reason });
      await expect(f.start.startUnlocked({})).resolves.toBe("joined");
      expect(f.store.contents).toBeNull();
      expect(f.stop).not.toHaveBeenCalled();
    },
  );

  test("accepted admission clears the persisted record before stopping", async () => {
    const f = fixture();
    await expect(f.start.startUnlocked({})).rejects.toBeInstanceOf(DaemonRestartDeferredError);
    expect(f.store.contents).not.toBeNull();
    f.prepare.mockResolvedValue({ accepted: true });
    f.stop.mockImplementation(async () => {
      expect(f.store.contents).toBeNull();
    });
    spyOn(f.timer, "sleep").mockResolvedValue(undefined);
    // Stop the test at the next phase, before launching any replacement process.
    await expect(f.start.startUnlocked({})).rejects.toThrow("unexpected launch or recovery");
    expect(f.stop).toHaveBeenCalledTimes(1);
    expect(f.store.contents).toBeNull();
  });

  test("UTC generation token changes reset a reused pid and start time", async () => {
    const f = fixture();
    f.status.processGenerationTokenUtc = "darwin-utc:first";
    await expect(f.start.startUnlocked({})).rejects.toBeInstanceOf(DaemonRestartDeferredError);
    f.status.processGenerationTokenUtc = "darwin-utc:second";
    await expect(f.start.startUnlocked({})).rejects.toBeInstanceOf(DaemonRestartDeferredError);
    expect(f.store.contents).toContain('"attempts":1');
    expect(f.store.contents).toContain("darwin-utc:second");
    expect(f.stop).not.toHaveBeenCalled();
  });
});
