import { describe, expect, test } from "bun:test";
import {
  AndroidRecoveryRecordLedger,
  type AndroidRecoveryRecord,
  type AndroidRecoveryRecordPoolPort,
} from "../../src/daemon/androidRecoveryRecordLedger";
import type { PooledDevice } from "../../src/daemon/devicePool";
import { FakeTimer } from "../fakes/FakeTimer";

class FakePoolPort implements AndroidRecoveryRecordPoolPort {
  readonly cleared: AndroidRecoveryRecord[] = [];

  getDevice(_deviceId: string): PooledDevice | null {
    return null;
  }

  getSession(_sessionId: string): null {
    return null;
  }

  clearAdbResetReservation(record: AndroidRecoveryRecord): void {
    this.cleared.push(record);
  }
}

function createLedger() {
  const port = new FakePoolPort();
  const timer = new FakeTimer();
  return { port, timer, ledger: new AndroidRecoveryRecordLedger(port, timer) };
}

describe("AndroidRecoveryRecordLedger", () => {
  test("creates a record and reuses it for another attempt", () => {
    const { ledger } = createLedger();
    const first = ledger.startAndroidRecoveryRecord("session", { deviceId: "device" }, ["image"]);
    first.deferredUntil = 500;
    first.state = "deferred";

    const reused = ledger.startAndroidRecoveryRecord("session", { avdName: "Pixel" }, ["loss"]);

    expect(reused).toBe(first);
    expect(reused.generation).toBe(1);
    expect(reused.deviceId).toBe("device");
    expect(reused.deferredUntil).toBeUndefined();
    expect(reused.state).toBe("pending");
    expect(reused.reservations).toEqual(new Set(["image", "loss"]));
  });

  test("replacement increments generation and rejects stale finalization", () => {
    const { ledger, port } = createLedger();
    const first = ledger.startAndroidRecoveryRecord("session", { deviceId: "old" }, []);
    const replacement = ledger.startAndroidRecoveryRecord("session", { deviceId: "new" }, [], true);

    expect(replacement).not.toBe(first);
    expect(replacement.generation).toBe(2);
    expect(ledger.finalizeRecoveryRecord("session", first)).toBeUndefined();
    expect(ledger.recoveringSessionLosses.get("session")).toBe(replacement);
    expect(port.cleared).toEqual([]);
  });

  test("marks a record released and retains that state on reuse", () => {
    const { ledger } = createLedger();
    const record = ledger.startAndroidRecoveryRecord("session", { deviceId: "device" }, []);

    expect(ledger.markAndroidRecoveryRecordReleased("session")).toBe(record);
    expect(record.state).toBe("released");
    expect(ledger.startAndroidRecoveryRecord("session", {}, [])).toBe(record);
    expect(record.state).toBe("released");
  });

  test("finalizes and clears the ADB reset and failed-release reservations", () => {
    const { ledger, port } = createLedger();
    const record = ledger.startAndroidRecoveryRecord("session", { deviceId: "device" }, [
      "reset-cohort",
    ]);
    ledger.markAndroidRecoveryReleaseFailure(record);

    const finalization = ledger.finalizeRecoveryRecord("session", record);
    expect(finalization?.record).toBe(record);
    finalization?.clearAdbResetReservation();
    finalization?.finish();
    expect(record.state).toBe("finalized");
    expect(port.cleared).toEqual([record]);
    expect(ledger.recoveringSessionLosses.has("session")).toBe(false);
    expect(ledger.failedTerminalRecoveryReleases.has("session")).toBe(false);
    expect(record.reservations.has("failed-release")).toBe(false);
    expect(record.failedReleaseAttempts).toBe(0);
  });

  test("failed terminal releases increment attempts and use fake time for backoff", () => {
    const { ledger, timer } = createLedger();
    const record = ledger.startAndroidRecoveryRecord("session", { deviceId: "device" }, []);

    ledger.markAndroidRecoveryReleaseFailure(record);
    expect(record.failedReleaseAttempts).toBe(1);
    expect(record.deferredUntil).toBe(timer.now() + 5_000);
    timer.advanceTime(1_000);
    ledger.markAndroidRecoveryReleaseFailure(record);
    expect(record.failedReleaseAttempts).toBe(2);
    expect(record.deferredUntil).toBe(timer.now() + 10_000);
    expect(ledger.failedTerminalRecoveryReleases.has("session")).toBe(true);
  });
});
