import { expect, spyOn, test } from "bun:test";
import { Daemon } from "../../../../src/daemon/daemon";
import { DaemonState } from "../../../../src/daemon/daemonState";
import { IncumbentOwnerGuard } from "../../../../src/daemon/incumbentOwnerGuard";
import {
  createDaemonBrokerDeviceAcquisition,
  type DaemonBrokerDeviceAcquisitionHandle,
} from "../../../../src/daemon/sessionBroker/provisioning/daemonDeviceAcquisition";
import type { BrokerDeviceAcquisitionSessions } from "../../../../src/daemon/sessionBroker/provisioning/deviceAcquisition";
import { BindingJournalInFlight } from "../../../../src/daemon/sessionBroker/registry/bindingJournal";
import * as shutdownCleanup from "../../../../src/shutdownCleanup";
import { logger } from "../../../../src/utils/logger";
import { FakeBindingRegistry } from "../../../fakes/FakeBindingRegistry";
import { FakeDeviceSessionRepository } from "../../../fakes/FakeDeviceSessionRepository";
import { FakeIdGenerator } from "../../../fakes/FakeIdGenerator";
import { FakeInstalledAppsRepository } from "../../../fakes/FakeInstalledAppsRepository";
import { FakeTimer } from "../../../fakes/FakeTimer";

class NoSessions implements BrokerDeviceAcquisitionSessions {
  async claimLivenessOwnership(): Promise<"claimed"> {
    return "claimed";
  }
  async adoptManagedExecutionLivenessPolicy(): Promise<void> {}
  async releaseSession(): Promise<void> {}
}

/** A real `Daemon` whose binding acquisition handle a test installs and reads back. */
class AcquisitionShutdownDaemon extends Daemon {
  installAcquisition(handle: DaemonBrokerDeviceAcquisitionHandle): void {
    this.runtime.brokerDeviceAcquisition = handle;
  }

  hasAcquisition(): boolean {
    return this.runtime.brokerDeviceAcquisition !== undefined;
  }
}

function handleOver(timer: FakeTimer): DaemonBrokerDeviceAcquisitionHandle {
  return createDaemonBrokerDeviceAcquisition({
    registry: async () => new FakeBindingRegistry(timer),
    sessions: new NoSessions(),
    pool: {
      getAllDevices: () => [],
      assertNotClaimedByForeignDaemon: async () => {},
      isUnderShutdownReservation: () => false,
      isDeviceLeasedForAndroidStartup: () => false,
      restartReservationExclusions: () => ({
        names: new Set<string>(),
        ids: new Set<string>(),
        resumeTargets: [],
      }),
    },
    owner: () => ({ daemonId: "daemon-1", pid: 1 }),
    timer,
    journal: {
      owner: { daemonId: "daemon-1", pid: 1, processGenerationToken: "gen-1" },
      inFlight: new BindingJournalInFlight(),
    },
  });
}

// Follow databaseFreeShutdownStages' stage-capture harness: run only the binding stage.
// The daemon is never started, and process identity and incumbent reads are injected fakes.
test("daemon stop closes its binding acquisition in the managed execution stage", async () => {
  const timer = new FakeTimer();
  const daemon = new AcquisitionShutdownDaemon(
    {},
    {
      installedAppsRepository: new FakeInstalledAppsRepository(),
      timer,
      deviceSessionRepository: new FakeDeviceSessionRepository(),
      idGenerator: new FakeIdGenerator(),
      recoveryPolicyEnvironment: {},
      processBirthTime: () => timer.now(),
      processGenerationToken: () => "fake-process-generation",
      incumbentOwnerGuard: new IncumbentOwnerGuard({
        readPidFile: () => null,
        persistPidFile: () => {},
        isProcessRunning: () => false,
        readProcessGenerationToken: () => undefined,
        selfPid: 4242,
      }),
    },
  );
  const handle = handleOver(timer);
  const close = spyOn(handle.acquisition, "close").mockImplementation(() => {});
  daemon.installAcquisition(handle);
  const info = spyOn(logger, "info").mockImplementation(() => {});
  const runner = spyOn(shutdownCleanup, "runShutdownCleanupStages").mockImplementation(
    async (stages) => {
      const stage = stages.find(({ name }) => name === "managed execution release");
      expect(stage).toBeDefined();
      await stage!.run({
        remainingMs: () => 1_000,
        unsettledStages: () => [],
        unsettledDatabaseWriters: () => [],
        waitForUnsettledStages: async () => true,
      });
    },
  );
  try {
    await daemon.stop();
    expect(runner).toHaveBeenCalledTimes(1);
    expect(close).toHaveBeenCalledTimes(1);
    expect(daemon.hasAcquisition()).toBe(false);
    expect(timer.now()).toBe(0);
  } finally {
    runner.mockRestore();
    info.mockRestore();
    daemon.getSessionManager().stopCleanupTimer();
    if (DaemonState.getInstance().isInitialized()) {
      DaemonState.getInstance().reset();
    }
  }
});
