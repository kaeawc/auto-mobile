import { afterEach, describe, expect, mock, spyOn, test } from "bun:test";
import { ENV } from "../../../src/config/env";
import { DaemonStart, type DaemonStartHost } from "../../../src/daemon/manager/DaemonStart";
import { DefaultTakeoverDeferralLedger } from "../../../src/daemon/manager/TakeoverDeferralLedger";
import type { DaemonStatus } from "../../../src/daemon/types";
import { logger } from "../../../src/utils/logger";
import { FakeTimer } from "../../fakes/FakeTimer";
import { FakeStartupFailureStore } from "../../fakes/FakeStartupFailureStore";
import { FakeDaemonExitRecordFileSystem } from "../../fakes/SafeDaemonManager";

const KEY = ENV.DAEMON_LAUNCH_CHECKOUT_VERSION.name;
const DIRTY = "0.0.87+g15404adf7979.dirty.47e2e3e8f6a5";

function unused(): never {
  throw new Error("unexpected call");
}

// #18071: the manager hands the child the content key it probed just before launch.
function coldStart(
  probeLaunchCheckoutVersion: () => Promise<string>,
  inherited: NodeJS.ProcessEnv = {},
) {
  const timer = new FakeTimer();
  const launched: NodeJS.ProcessEnv[] = [];
  const status: DaemonStatus = { running: false };
  const host: DaemonStartHost = {
    takeoverDeferrals: new DefaultTakeoverDeferralLedger(new FakeStartupFailureStore()),
    timer,
    socketPath: "/memory/daemon.sock",
    seams: {
      exitRecordFileSystem: new FakeDaemonExitRecordFileSystem(),
      currentBuildId: () => "memory-build",
      nextLaunchNonce: unused,
      portFreeProbe: unused,
      launchLogFileSystem: { openSync: () => 7, closeSync: () => {} },
      launchWorkingDirectory: unused,
      probeLaunchCheckoutVersion,
    },
    acquireLock: () => true,
    releaseLock: () => {},
    startByAwaitingLockHolder: unused,
    startUnlocked: unused,
    start: unused,
    lifecycleStatus: async () => status,
    throwIfRecoveryCancelled: () => {},
    verifyDaemonGenerationBeforeSignal: unused,
    daemonProcessRecordFromStatus: unused,
    probeNamespaceOwner: unused,
    waitForExistingDaemon: unused,
    remainingTime: () => 30_000,
    startIdentityRecovery: unused,
    prepareDaemonForConditionalRestart: unused,
    stopRunningDaemon: unused,
    assertNoSurvivingDaemonBeforeRestart: unused,
    findLiveDaemonProcessesForStart: async () => [],
    inheritExitSettings: async (options) => options,
    withDaemonOptions: (command) => command,
    resolveLaunchCommand: () => ({ command: "bun", args: ["/checkout/src/index.ts"] }),
    // Stderr sink: no launch log file is opened on disk.
    daemonLaunchEnvironment: () => ({ ...inherited, [ENV.LOG_SINK.name]: "stderr" }),
    heldLockLogPath: undefined,
    daemonLaunchLogPath: unused,
    launchWithExtractionRetry: async (launch) => {
      launched.push(launch.childEnv);
    },
    tryJoinPeerDaemonAfterSpawnExit: unused,
  };
  return { start: new DaemonStart(host), launched };
}

describe("launch checkout key (#18071)", () => {
  afterEach(() => mock.restore());

  test("passes a probed version that carries a working-tree hash", async () => {
    let probes = 0;
    const { start, launched } = coldStart(async () => {
      probes++;
      return DIRTY;
    });
    expect(await start.startUnlocked({})).toBe("started");
    expect(probes).toBe(1);
    expect(launched.map((env) => env[KEY])).toEqual([DIRTY]);
  });

  test.each(["0.0.87+g15404adf7979", "0.0.87+g15404adf7979.dirty", "0.0.87"])(
    "passes nothing for %s and drops an inherited key",
    async (version) => {
      const { start, launched } = coldStart(async () => version, { [KEY]: DIRTY });
      await start.startUnlocked({});
      expect(launched).toHaveLength(1);
      expect(Object.hasOwn(launched[0], KEY)).toBe(false);
    },
  );

  test("a failed probe warns and still launches without a key", async () => {
    const error = new Error("git unavailable");
    const warn = spyOn(logger, "warn").mockImplementation(() => {});
    const { start, launched } = coldStart(async () => {
      throw error;
    });
    expect(await start.startUnlocked({})).toBe("started");
    expect(Object.hasOwn(launched[0], KEY)).toBe(false);
    expect(warn).toHaveBeenCalledWith("Checkout version probe before daemon launch failed", error);
  });
});
