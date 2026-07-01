import { afterEach, describe, expect, test } from "bun:test";
import path from "path";
import { mkdtemp, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { DefaultStartupFailureTracker } from "../../src/daemon/DaemonStartupFailureTracker";

describe("DefaultStartupFailureTracker", () => {
  let tempDir: string | undefined;

  afterEach(async () => {
    if (tempDir) {
      await rm(tempDir, { recursive: true, force: true });
      tempDir = undefined;
    }
  });

  test("persists an escalating count across independent tracker instances (fresh processes)", async () => {
    tempDir = await mkdtemp(path.join(tmpdir(), "am-breaker-"));
    const filePath = path.join(tempDir, "failures.json");

    // Each new instance models a fresh respawned process reading the same file.
    expect(new DefaultStartupFailureTracker(filePath).recordFailure("permanent", 1_000)).toBe(1);
    expect(new DefaultStartupFailureTracker(filePath).recordFailure("permanent", 2_000)).toBe(2);
    expect(new DefaultStartupFailureTracker(filePath).recordFailure("permanent", 3_000)).toBe(3);
  });

  test("drops failures older than the rolling window", async () => {
    tempDir = await mkdtemp(path.join(tmpdir(), "am-breaker-"));
    const filePath = path.join(tempDir, "failures.json");
    const windowMs = 5_000;

    expect(new DefaultStartupFailureTracker(filePath, windowMs).recordFailure("permanent", 1_000)).toBe(1);
    // 10s later — the first failure has aged out of the 5s window.
    expect(new DefaultStartupFailureTracker(filePath, windowMs).recordFailure("permanent", 11_000)).toBe(1);
  });

  test("reset clears persisted state", async () => {
    tempDir = await mkdtemp(path.join(tmpdir(), "am-breaker-"));
    const filePath = path.join(tempDir, "failures.json");

    const tracker = new DefaultStartupFailureTracker(filePath);
    tracker.recordFailure("permanent", 1_000);
    expect(existsSync(filePath)).toBe(true);
    tracker.reset();
    expect(existsSync(filePath)).toBe(false);
    expect(new DefaultStartupFailureTracker(filePath).recordFailure("permanent", 2_000)).toBe(1);
  });

  test("throttles when persistence itself fails (unwritable state dir)", () => {
    // A path whose parent cannot be created (a file used as a directory segment)
    // forces the write to fail; the tracker must still report a backoff-triggering
    // count so a permanent failure does not hot-loop at count 1 forever.
    const unwritable = path.join("/dev/null", "failures.json");
    const tracker = new DefaultStartupFailureTracker(unwritable);

    expect(tracker.recordFailure("permanent", 1_000)).toBeGreaterThanOrEqual(2);
  });
});
