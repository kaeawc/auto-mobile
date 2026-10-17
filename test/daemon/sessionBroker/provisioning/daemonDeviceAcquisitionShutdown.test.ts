import { expect, spyOn, test } from "bun:test";
import { Daemon } from "../../../../src/daemon/daemon";
import { DaemonState } from "../../../../src/daemon/daemonState";
import { IncumbentOwnerGuard } from "../../../../src/daemon/incumbentOwnerGuard";
import type { BrokerDeviceAcquisition } from "../../../../src/daemon/sessionBroker/provisioning/deviceAcquisition";
import * as shutdownCleanup from "../../../../src/shutdownCleanup";
import { logger } from "../../../../src/utils/logger";
import { FakeDeviceSessionRepository } from "../../../fakes/FakeDeviceSessionRepository";
import { FakeIdGenerator } from "../../../fakes/FakeIdGenerator";
import { FakeInstalledAppsRepository } from "../../../fakes/FakeInstalledAppsRepository";
import { FakeTimer } from "../../../fakes/FakeTimer";

interface ManagedAcquisitionShutdownWiring {
  brokerDeviceAcquisition: { acquisition: Pick<BrokerDeviceAcquisition, "close"> } | undefined;
}

// Follow databaseFreeShutdownStages' stage-capture harness: run only the binding stage.
// The daemon is never started, and process identity and incumbent reads are injected fakes.
test("daemon stop closes its binding acquisition in the managed execution stage", async () => {
  const timer = new FakeTimer();
  const daemon = new Daemon(
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
  const wiring = daemon as unknown as ManagedAcquisitionShutdownWiring;
  let closes = 0;
  wiring.brokerDeviceAcquisition = {
    acquisition: {
      close: () => {
        closes++;
      },
    },
  };
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
    expect(closes).toBe(1);
    expect(wiring.brokerDeviceAcquisition).toBeUndefined();
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
