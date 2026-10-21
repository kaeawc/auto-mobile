import { describe, expect, test } from "bun:test";
import { ReleaseEpochLedger } from "../../../src/daemon/proxy/ReleaseEpochLedger";

describe("ReleaseEpochLedger", () => {
  test("a release advances the epoch even when nothing tracks the session", () => {
    const ledger = new ReleaseEpochLedger();
    ledger.recordSessionReleased("s1", "idle");
    expect(ledger.epoch).toBe(1);
    expect(ledger.releasedSessionEpochs.size).toBe(0);
    expect(ledger.sessionReleaseReasonSince("s1", 0)).toBeUndefined();
  });

  test("a blank session uuid is ignored and does not advance the epoch", () => {
    const ledger = new ReleaseEpochLedger();
    ledger.recordSessionReleased("   ");
    expect(ledger.epoch).toBe(0);
  });

  test("an in-flight reference sees a later release of its own uuid only", () => {
    const ledger = new ReleaseEpochLedger();
    ledger.retainReleaseEpochReference("s1");
    const forwardEpoch = ledger.epoch;
    ledger.recordSessionReleased("other", "idle");
    ledger.recordSessionReleased(" s1 ", "daemon_restart");
    expect(ledger.sessionReleaseReasonSince("s1", forwardEpoch)).toBe("daemon_restart");
    expect(ledger.sessionReleaseReasonSince("other", forwardEpoch)).toBeUndefined();
    expect(ledger.sessionReleaseReasonSince("s1", ledger.epoch)).toBeUndefined();
  });

  test("a release without a reason is reported as released", () => {
    const ledger = new ReleaseEpochLedger();
    ledger.retainReleaseEpochReference("s1");
    ledger.recordSessionReleased("s1");
    expect(ledger.sessionReleaseReasonSince("s1", 0)).toBe("released");
  });

  test("the last reference dropping evicts the record", () => {
    const ledger = new ReleaseEpochLedger();
    ledger.retainReleaseEpochReference("s1");
    ledger.retainReleaseEpochReference("s1");
    ledger.recordSessionReleased("s1", "idle");
    ledger.releaseReleaseEpochReference("s1");
    expect(ledger.releasedSessionEpochs.has("s1")).toBe(true);
    ledger.releaseReleaseEpochReference("s1");
    expect(ledger.releasedSessionEpochs.size).toBe(0);
    expect(ledger.releasedSessionReasons.size).toBe(0);
    expect(ledger.activeReleaseEpochReferences.size).toBe(0);
  });

  test("an active acquisition keeps a later release until the acquisition ends", () => {
    const ledger = new ReleaseEpochLedger();
    ledger.retainAcquisitionReleaseEpoch(true, ledger.epoch);
    ledger.retainReleaseEpochReference("s1");
    ledger.recordSessionReleased("s1", "idle");
    ledger.releaseReleaseEpochReference("s1");
    expect(ledger.releasedSessionEpochs.has("s1")).toBe(true);
    ledger.releaseAcquisitionReleaseEpoch(true, 0);
    expect(ledger.releasedSessionEpochs.size).toBe(0);
    expect(ledger.activeAcquisitionReleaseEpochs.size).toBe(0);
  });

  test("acquisition tracking is skipped for calls that do not acquire a session", () => {
    const ledger = new ReleaseEpochLedger();
    ledger.retainAcquisitionReleaseEpoch(false, 0);
    expect(ledger.activeAcquisitionReleaseEpochs.size).toBe(0);
    ledger.recordSessionReleased("s1", "idle");
    expect(ledger.releasedSessionEpochs.size).toBe(0);
  });

  test("clearing drops the per-uuid records but not the epoch or acquisition counts", () => {
    const ledger = new ReleaseEpochLedger();
    ledger.retainAcquisitionReleaseEpoch(true, 0);
    ledger.retainReleaseEpochReference("s1");
    ledger.recordSessionReleased("s1", "idle");
    ledger.clearReleaseRecords();
    expect(ledger.releasedSessionEpochs.size).toBe(0);
    expect(ledger.releasedSessionReasons.size).toBe(0);
    expect(ledger.activeReleaseEpochReferences.size).toBe(0);
    expect(ledger.activeAcquisitionReleaseEpochs.size).toBe(1);
    expect(ledger.epoch).toBe(1);
  });
});
