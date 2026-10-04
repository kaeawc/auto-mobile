import { afterEach, describe, expect, mock, spyOn, test } from "bun:test";
import {
  SessionPreservingRecoveryRunner,
  type SessionPreservingRecoveryPoolPort,
} from "../../src/daemon/sessionPreservingRecovery";
import { AndroidRecoveryRecordLedger } from "../../src/daemon/androidRecoveryRecordLedger";
import { UnconfirmedRecoveryShutdownError } from "../../src/daemon/androidRebootCoordinator";
import type { SessionContinuityDevice } from "../../src/daemon/devicePool";
import { SessionManager } from "../../src/daemon/sessionManager";
import { FakeDeviceSessionPersistence } from "../fakes/FakeDeviceSessionPersistence";
import { logger } from "../../src/utils/logger";
import { FakeTimer } from "../fakes/FakeTimer";

async function harness() {
  const timer = new FakeTimer();
  const device: SessionContinuityDevice = {
    id: "emulator-5554",
    name: "Pixel",
    platform: "android",
    sessionId: "session",
    status: "busy",
    lastUsedAt: 0,
    assignmentCount: 1,
    errorCount: 0,
    incarnation: 1,
    avdName: "Pixel",
    androidImage: { name: "Pixel", platform: "android", isRunning: true },
    autolockSessionId: "owner",
  };
  const sessions = new SessionManager(timer, new FakeDeviceSessionPersistence());
  const session = await sessions.createSession("session", device.id, "android");
  const ledger = new AndroidRecoveryRecordLedger(
    { getDevice: () => device, getSession: () => session, clearAdbResetReservation: () => {} },
    timer,
  );
  const events: string[] = [];
  const port: SessionPreservingRecoveryPoolPort = {
    getRecoveringSessionLoss: (id) => ledger.recoveringSessionLosses.get(id),
    startAndroidRecoveryRecord: (...args) => ledger.startAndroidRecoveryRecord(...args),
    isAndroidEmulatorActiveRelaunchEligible: (
      candidate,
    ): candidate is typeof candidate & {
      avdName: string;
      androidImage: NonNullable<typeof candidate.androidImage>;
    } => candidate.platform === "android" && !!candidate.avdName && !!candidate.androidImage,
    rebootDisconnectedAndroidDevice: async () => {
      events.push("reboot");
      return true;
    },
    getRecoveryPolicy: () => ({ onLoss: true }),
    deviceSessionContinuityEnabled: () => true,
    cancelDeviceSessionExecutions: async () => {
      events.push("cancel");
      return 0;
    },
    refreshReleasedRecoverySettlementAfterAwait: async () => void events.push("refresh"),
    finalizeReleasedRecoveryAfterAwait: async (record) => {
      events.push("check-release");
      if (record.state !== "released") {
        return false;
      }
      port.finalizeRecoveryRecord(record.sessionId, record);
      port.settleEmulatorLossIncident("incident");
      return true;
    },
    finalizeRecoveryRecord: (id, record) => {
      events.push("finalize");
      const finalization = ledger.finalizeRecoveryRecord(id, record);
      finalization?.finish();
      return !!finalization;
    },
    finalizeReleasedRecoveryAfterCleanupFailure: async () => false,
    markAndroidRecoveryReleaseFailure: (record) => {
      events.push("failed-release");
      ledger.markAndroidRecoveryReleaseFailure(record);
    },
    completeEmulatorLossRecovery: async (_id, outcome, state) =>
      void events.push(`complete:${outcome}:${state ?? ""}`),
    settleEmulatorLossIncident: () => void events.push("settle"),
    isPreservedSessionCurrent: () => true,
    releaseDisconnectedRecoverySessionWithRetry: async (_session, _device, reason) =>
      void events.push(`release:${reason}`),
    stableDeviceIdFor: () => "Pixel",
    getPooledDevice: () => device,
    removeDevice: async () => void events.push("remove"),
    suppressAutoStartForDevice: () => void events.push("suppress"),
    getEmulatorLossIncident: async () => undefined,
    getFinalizedReleaseReason: () => "device-restart:Pixel",
    now: () => timer.now(),
  };
  const runner = new SessionPreservingRecoveryRunner(port);
  return {
    port,
    device,
    session,
    ledger,
    timer,
    events,
    run: () => runner.performSessionPreservingRecovery(device, session, "incident"),
  };
}

afterEach(() => mock.restore());

describe("SessionPreservingRecoveryRunner", () => {
  test.each(["new-owner", "same-owner-new-assignment"])(
    "failed recovery preserves a %s device",
    async (scenario) => {
      const h = await harness();
      h.device.androidImage = undefined;
      h.port.releaseDisconnectedRecoverySessionWithRetry = async () => {
        h.device.sessionId = scenario === "new-owner" ? "other-session" : "session";
        h.device.assignmentCount++;
        h.device.status = "busy";
      };
      expect(await h.run()).toBe("released");
      expect(h.device).toMatchObject({
        sessionId: scenario === "new-owner" ? "other-session" : "session",
        status: "busy",
        assignmentCount: 2,
      });
      expect(h.events).not.toContain("remove");
      expect(h.events).not.toContain("suppress");
    },
  );

  const traces = {
    recovered: "reboot,refresh,check-release,finalize,settle",
    "ios-passive":
      "refresh,check-release,release:device-restart:Pixel,suppress,remove,complete:not-attempted:awaiting-device,finalize,settle",
    "android-passive":
      "refresh,check-release,release:device-restart:Pixel,suppress,remove,complete:not-attempted:awaiting-device,finalize,settle",
    stale: "complete:exhausted:,finalize,settle",
    deferred: "",
    "released-before-shutdown": "complete:exhausted:,check-release,finalize,settle,finalize,settle",
    "runtime-error":
      "release:device-restart:Pixel,suppress,remove,complete:not-attempted:awaiting-device,finalize,settle",
    "cleanup-finalized": "finalize,settle",
    "cleanup-failed": "failed-release,complete:exhausted:,settle",
  };
  for (const scenario of Object.keys(traces) as Array<keyof typeof traces>) {
    test(scenario, async () => {
      const h = await harness();
      const runtimeError = new Error("reboot failed");
      const releaseError = new Error("persistence failed");
      const warn = spyOn(logger, "warn").mockImplementation(() => {});
      if (scenario.endsWith("passive")) {
        h.device.platform = scenario === "ios-passive" ? "ios" : "android";
        h.device.androidImage = undefined;
      } else if (scenario === "stale") {
        h.port.cancelDeviceSessionExecutions = async () => {
          h.events.push("cancel");
          h.port.isPreservedSessionCurrent = () => false;
          return 0;
        };
      } else if (scenario !== "recovered") {
        h.port.rebootDisconnectedAndroidDevice = async () => {
          if (scenario === "released-before-shutdown") {
            h.ledger.recoveringSessionLosses.get("session")!.state = "released";
          }
          if (scenario === "deferred" || scenario === "released-before-shutdown") {
            throw new UnconfirmedRecoveryShutdownError("Pixel", runtimeError);
          }
          throw runtimeError;
        };
      }
      if (scenario.startsWith("cleanup")) {
        h.port.releaseDisconnectedRecoverySessionWithRetry = async () => {
          throw releaseError;
        };
        h.port.finalizeReleasedRecoveryAfterCleanupFailure = async (record) => {
          if (scenario === "cleanup-failed") {
            return false;
          }
          h.port.finalizeRecoveryRecord(record.sessionId, record);
          h.port.settleEmulatorLossIncident("incident");
          return true;
        };
      }
      h.timer.setCurrentTime(123);
      if (scenario === "cleanup-failed") {
        await expect(h.run()).rejects.toBe(releaseError);
        expect(h.ledger.failedTerminalRecoveryReleases.has("session")).toBe(true);
      } else {
        expect(await h.run()).toBe(
          scenario === "recovered"
            ? "recovered"
            : scenario === "deferred"
              ? "deferred"
              : "released",
        );
        if (scenario === "deferred") {
          expect(h.ledger.recoveringSessionLosses.get("session")).toMatchObject({
            state: "deferred",
            deferredUntil: 30_123,
            deferredShutdowns: 1,
          });
        } else {
          expect(h.ledger.recoveringSessionLosses.size).toBe(0);
        }
      }
      const tail = traces[scenario];
      expect(h.events.join(",")).toBe(`cancel,refresh,check-release${tail ? "," + tail : ""}`);
      if (scenario === "runtime-error") {
        expect(warn).toHaveBeenCalledWith(
          `[DevicePool] Session-preserving recovery failed for ${h.device.id}: ${runtimeError}`,
          runtimeError,
        );
      }
      if (scenario.endsWith("passive")) {
        expect(h.device).toMatchObject({ sessionId: null, status: "idle" });
      }
    });
  }
});
