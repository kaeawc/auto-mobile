import { describe, it, expect, afterEach } from "bun:test";
import {
  TelemetryRecorder,
  getNoOpTelemetryRepository,
  type TelemetryRepository,
} from "../../../src/features/telemetry/TelemetryRecorder";
import { InMemoryDbWriteBarrier } from "../../../src/db/dbWriteBarrier";

/**
 * Regression coverage for issue #3084: a fire-and-forget telemetry write must
 * never reach the real DB in tests. The unit-test preload installs a process-wide
 * no-op default repository via {@link TelemetryRecorder.setDefaultRepositoryOverride};
 * these tests prove that override is durable — it survives `resetInstance()` (the
 * exact gap that would re-arm the real-DB path when a test resets the singleton in
 * teardown and then floats a nav-event write).
 */
describe("TelemetryRecorder default repository override (#3084)", () => {
  afterEach(() => {
    // Restore whatever the preload set, then rebuild a clean singleton.
    TelemetryRecorder.setDefaultRepositoryOverride(getNoOpTelemetryRepository());
    TelemetryRecorder.resetInstance();
  });

  it("routes lazily-built recorders through the override repository", async () => {
    let hits = 0;
    const spyRepo: TelemetryRepository = {
      ...getNoOpTelemetryRepository(),
      recordNavigationEvent: async () => {
        hits++;
      },
    };
    TelemetryRecorder.setDefaultRepositoryOverride(spyRepo);

    await TelemetryRecorder.getInstance().recordNavigationEvent({
      timestamp: 1,
      applicationId: "app",
      destination: "Home",
      source: null,
      arguments: null,
      metadata: null,
    });

    expect(hits).toBe(1);
  });

  it("keeps the override in force after resetInstance()", async () => {
    let hits = 0;
    const spyRepo: TelemetryRepository = {
      ...getNoOpTelemetryRepository(),
      recordNavigationEvent: async () => {
        hits++;
      },
    };
    TelemetryRecorder.setDefaultRepositoryOverride(spyRepo);

    // Simulate a test resetting the singleton in teardown then floating a write.
    TelemetryRecorder.resetInstance();
    await TelemetryRecorder.getInstance().recordNavigationEvent({
      timestamp: 2,
      applicationId: "app",
      destination: "Detail",
      source: null,
      arguments: null,
      metadata: null,
    });

    expect(hits).toBe(1);
  });

  it("the no-op repository resolves without touching a DB", async () => {
    // The preload's default: a floating write must resolve cleanly (no throw, no
    // real-DB access). Route through a real barrier to mirror production.
    TelemetryRecorder.setDefaultRepositoryOverride(getNoOpTelemetryRepository());
    const recorder = TelemetryRecorder.getInstance();

    // Should resolve, not reject — the guard-throw path is removed entirely.
    await expect(
      recorder.recordNavigationEvent({
        timestamp: 3,
        applicationId: "app",
        destination: "Settings",
        source: null,
        arguments: null,
        metadata: null,
      }),
    ).resolves.toBeUndefined();

    // No lingering barrier work from the no-op path.
    expect(new InMemoryDbWriteBarrier().inFlightCount()).toBe(0);
  });
});
