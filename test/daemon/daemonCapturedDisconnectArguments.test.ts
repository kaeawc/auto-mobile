import { expect, mock, test } from "bun:test";
import { Daemon } from "../../src/daemon/daemon";
import { DevicePool } from "../../src/daemon/devicePool";
import { SessionManager } from "../../src/daemon/sessionManager";
import { FakeTimer } from "../fakes/FakeTimer";
import { FakeDeviceManager } from "../fakes/FakeDeviceManager";
import { FakeDeviceSessionPersistence } from "../fakes/FakeDeviceSessionPersistence";
import { FakeInstalledAppsRepository } from "../fakes/FakeInstalledAppsRepository";
import { createDevicePoolDependencies } from "../helpers/devicePoolDependencies";

test.each(["waiting", "in-flight", "absent", "prepared"])(
  "captured disconnect preserves the %s preparation path",
  async (branch) => {
    const timer = new FakeTimer();
    const sessions = new SessionManager(timer, new FakeDeviceSessionPersistence());
    const pool = new DevicePool(
      createDevicePoolDependencies(sessions, "daemon", {
        timer,
        deviceManager: new FakeDeviceManager(),
        installedAppsRepository: new FakeInstalledAppsRepository(),
      }),
    );
    const preparation =
      branch === "prepared" ? { sessionId: "session", token: Symbol() } : undefined;
    pool.isShutdownReservationHeld = async () => false;
    pool.prepareSessionPreservingRecovery = () => preparation;
    pool.recordEmulatorLossIncident = async () => "incident";
    const wait = mock(async () => branch === "waiting");
    pool.waitForSessionPreservingRecovery = wait;
    const inFlight = mock(() => branch === "in-flight");
    pool.isSessionRecoveryInFlight = inFlight;
    const finishIncident = mock(async () => {});
    pool.finishEmulatorLossIncident = finishIncident;
    const finishPreparation = mock(() => {});
    pool.finishSessionPreservingRecoveryPreparation = finishPreparation;
    const daemon: Daemon = Object.create(Daemon.prototype);
    Object.assign(daemon, { devicePool: pool, forceDisconnectedDeviceIds: new Set<string>() });
    daemon["shouldSkipStaleDisconnectCleanup"] = async () => false;
    daemon["isCapturedDisconnectTargetCurrent"] = () => true;
    const retire = mock(() => {});
    daemon["retireAdbServerResetDisconnectState"] = retire;
    try {
      expect(
        await daemon["recordAndTryRecoverCapturedDisconnect"](
          "device",
          null,
          0,
          "session",
          null,
          undefined,
        ),
      ).toEqual({
        incidentId: "incident",
        handled: branch === "waiting" || branch === "in-flight",
      });
      expect(wait.mock.calls.length).toBe(branch === "prepared" ? 0 : 1);
      expect(inFlight.mock.calls.length).toBe(
        branch === "prepared" || branch === "waiting" ? 0 : 1,
      );
      expect(finishIncident.mock.calls).toEqual(
        branch === "in-flight" ? [["incident", "not-attempted"]] : [],
      );
      expect(retire.mock.calls).toEqual(
        branch === "waiting" || branch === "in-flight" ? [["device", undefined]] : [],
      );
      expect(finishPreparation.mock.calls).toEqual([[preparation]]);
    } finally {
      sessions.stopCleanupTimer();
    }
  },
);
