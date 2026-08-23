import { describe, it, expect, beforeEach } from "bun:test";
import {
  TelemetryEventBuffer,
  type BatchTelemetryRepository,
} from "../../../src/features/telemetry/TelemetryEventBuffer";
import type { RecordLogEventInput } from "../../../src/db/logEventRepository";
import type { RecordOsEventInput } from "../../../src/db/osEventRepository";
import type { RecordNavigationEventInput } from "../../../src/db/navigationEventRepository";
import type { RecordLayoutEventInput } from "../../../src/db/layoutEventRepository";
import { FakeTimer } from "../../fakes/FakeTimer";

/**
 * Recording fake for the batch sink. Captures every batch it is handed per kind
 * and, for serialization/snapshot tests, can hold the next log flush open until
 * the test releases it — modelling a slow DB commit without any real timer.
 */
class FakeBatchTelemetryRepository implements BatchTelemetryRepository {
  logBatches: RecordLogEventInput[][] = [];
  osBatches: RecordOsEventInput[][] = [];
  navigationBatches: RecordNavigationEventInput[][] = [];
  layoutBatches: RecordLayoutEventInput[][] = [];

  rejectLogsWith: Error | null = null;

  private pendingLogGate: Promise<void> | null = null;
  private releaseLogGate: (() => void) | null = null;

  /** Make the next recordLogEvents block until releaseLogFlush() is called. */
  holdNextLogFlush(): void {
    this.pendingLogGate = new Promise<void>((resolve) => {
      this.releaseLogGate = resolve;
    });
  }

  releaseLogFlush(): void {
    this.releaseLogGate?.();
    this.releaseLogGate = null;
    this.pendingLogGate = null;
  }

  async recordLogEvents(inputs: RecordLogEventInput[]): Promise<void> {
    if (this.pendingLogGate) {
      await this.pendingLogGate;
    }
    if (this.rejectLogsWith) {
      throw this.rejectLogsWith;
    }
    this.logBatches.push(inputs);
  }

  async recordOsEvents(inputs: RecordOsEventInput[]): Promise<void> {
    this.osBatches.push(inputs);
  }

  async recordNavigationEvents(inputs: RecordNavigationEventInput[]): Promise<void> {
    this.navigationBatches.push(inputs);
  }

  async recordLayoutEvents(inputs: RecordLayoutEventInput[]): Promise<void> {
    this.layoutBatches.push(inputs);
  }
}

function makeLog(message: string): RecordLogEventInput {
  return {
    deviceId: "device-1",
    timestamp: 0,
    applicationId: "com.example",
    sessionId: "session-1",
    level: 3,
    tag: "tag",
    message,
    filterName: "filter",
  };
}

function makeOs(kind: string): RecordOsEventInput {
  return {
    deviceId: "device-1",
    timestamp: 0,
    applicationId: "com.example",
    sessionId: "session-1",
    category: "lifecycle",
    kind,
    details: null,
  };
}

describe("TelemetryEventBuffer", () => {
  let repository: FakeBatchTelemetryRepository;
  let timer: FakeTimer;

  beforeEach(() => {
    repository = new FakeBatchTelemetryRepository();
    timer = new FakeTimer();
  });

  it("does not flush before the cap is reached or the interval fires", () => {
    const buffer = new TelemetryEventBuffer(repository, timer, { maxBufferedRows: 3 });
    buffer.addLog(makeLog("a"));
    buffer.addLog(makeLog("b"));
    expect(repository.logBatches).toHaveLength(0);
  });

  it("flushes immediately as one batch when the buffered row count reaches the cap", async () => {
    const buffer = new TelemetryEventBuffer(repository, timer, { maxBufferedRows: 3 });
    buffer.addLog(makeLog("a"));
    buffer.addLog(makeLog("b"));
    buffer.addLog(makeLog("c"));
    // Let the fire-and-forget cap flush settle without requesting one ourselves.
    await new Promise<void>((resolve) => setImmediate(resolve));

    expect(repository.logBatches).toHaveLength(1);
    expect(repository.logBatches[0].map((r) => r.message)).toEqual(["a", "b", "c"]);
  });

  it("counts rows across all kinds toward the cap", async () => {
    const buffer = new TelemetryEventBuffer(repository, timer, { maxBufferedRows: 3 });
    buffer.addLog(makeLog("a"));
    buffer.addOs(makeOs("resume"));
    buffer.addLog(makeLog("b"));
    await new Promise<void>((resolve) => setImmediate(resolve));

    expect(repository.logBatches[0].map((r) => r.message)).toEqual(["a", "b"]);
    expect(repository.osBatches[0].map((r) => r.kind)).toEqual(["resume"]);
  });

  it("flushes buffered events when the interval timer fires", async () => {
    const buffer = new TelemetryEventBuffer(repository, timer, {
      flushIntervalMs: 250,
      maxBufferedRows: 1000,
    });
    buffer.start();
    buffer.addLog(makeLog("tick"));
    expect(repository.logBatches).toHaveLength(0);

    timer.advanceTime(250);
    // Let the interval's fire-and-forget flush settle without requesting one ourselves.
    await new Promise<void>((resolve) => setImmediate(resolve));

    expect(repository.logBatches[0].map((r) => r.message)).toEqual(["tick"]);
  });

  it("drains remaining events on stop()", async () => {
    const buffer = new TelemetryEventBuffer(repository, timer, { maxBufferedRows: 1000 });
    buffer.start();
    buffer.addLog(makeLog("leftover"));

    await buffer.stop();

    expect(repository.logBatches[0].map((r) => r.message)).toEqual(["leftover"]);
    // The interval must be cleared so no timer keeps the process alive.
    expect(timer.getPendingIntervalCount()).toBe(0);
  });

  it("still records the other kinds when one kind's batch insert throws", async () => {
    repository.rejectLogsWith = new Error("log insert failed");
    const buffer = new TelemetryEventBuffer(repository, timer, { maxBufferedRows: 1000 });
    buffer.addLog(makeLog("dropped"));
    buffer.addOs(makeOs("resume"));

    await buffer.flush();

    expect(repository.logBatches).toHaveLength(0);
    expect(repository.osBatches[0].map((r) => r.kind)).toEqual(["resume"]);
  });

  it("emits nothing to the repository when there is nothing buffered", async () => {
    const buffer = new TelemetryEventBuffer(repository, timer, { maxBufferedRows: 1000 });
    await buffer.flush();
    expect(repository.logBatches).toHaveLength(0);
    expect(repository.osBatches).toHaveLength(0);
  });

  it("routes events added during an in-flight flush into the next batch without dropping or duplicating them", async () => {
    const buffer = new TelemetryEventBuffer(repository, timer, { maxBufferedRows: 1000 });
    buffer.addLog(makeLog("first"));

    repository.holdNextLogFlush();
    const firstFlush = buffer.flush();
    // Let doFlush snapshot+clear the buffer and park on the repository gate.
    await new Promise<void>((resolve) => setImmediate(resolve));

    // Arrives while the first flush is awaiting the repository — must not join the
    // in-flight batch (already snapshotted) nor be lost.
    buffer.addLog(makeLog("second"));

    repository.releaseLogFlush();
    await firstFlush;

    expect(repository.logBatches[0].map((r) => r.message)).toEqual(["first"]);

    await buffer.flush();
    expect(repository.logBatches[1].map((r) => r.message)).toEqual(["second"]);
  });

  it("serializes overlapping flushes so batches never interleave", async () => {
    const buffer = new TelemetryEventBuffer(repository, timer, { maxBufferedRows: 1000 });
    buffer.addLog(makeLog("first"));

    repository.holdNextLogFlush();
    const firstFlush = buffer.flush();
    // Let the first flush snapshot ["first"] and park on the repository gate.
    await new Promise<void>((resolve) => setImmediate(resolve));

    // A second flush requested while the first is still blocked must queue behind
    // it — crucially, its buffer snapshot must not happen until the first flush
    // completes.
    buffer.addLog(makeLog("second"));
    const secondFlush = buffer.flush();

    // Added AFTER the second flush() call but BEFORE the first flush is released.
    // Under serialization the second flush has not snapshotted the buffer yet, so
    // "third" joins its batch. If the two flushes ran concurrently the second would
    // have already snapshotted ["second"] and stranded "third" — so this row is
    // what discriminates the serialization the test names (drop `flushChain` and it
    // reds). The earlier single-shared-gate assertion held either way.
    buffer.addLog(makeLog("third"));

    repository.releaseLogFlush();
    await Promise.all([firstFlush, secondFlush]);

    expect(repository.logBatches).toHaveLength(2);
    expect(repository.logBatches[0].map((r) => r.message)).toEqual(["first"]);
    expect(repository.logBatches[1].map((r) => r.message)).toEqual(["second", "third"]);
  });
});
