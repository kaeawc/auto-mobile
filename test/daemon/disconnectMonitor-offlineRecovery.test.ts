import { describe, expect, test } from "bun:test";
import {
  pruneStaleOfflineRecoveryAttempts,
  selectOfflineRecoveryCandidates,
} from "../../src/daemon/disconnectMonitor";

describe("selectOfflineRecoveryCandidates", () => {
  test("selects an offline candidate that has not yet had a recovery attempt", () => {
    const targets = selectOfflineRecoveryCandidates(
      new Set(["emulator-5554"]),
      new Set(["emulator-5554"]),
      new Set(),
    );

    expect(targets).toEqual(["emulator-5554"]);
  });

  test("skips a candidate already attempted this episode", () => {
    const targets = selectOfflineRecoveryCandidates(
      new Set(["emulator-5554"]),
      new Set(["emulator-5554"]),
      new Set(["emulator-5554"]),
    );

    expect(targets).toEqual([]);
  });

  test("ignores an offline serial that is no longer a tracked candidate", () => {
    const targets = selectOfflineRecoveryCandidates(
      new Set(["emulator-5554"]),
      new Set(),
      new Set(),
    );

    expect(targets).toEqual([]);
  });

  test("selects only the offline ones out of several candidates", () => {
    const targets = selectOfflineRecoveryCandidates(
      new Set(["emulator-5554"]),
      new Set(["emulator-5554", "emulator-5556"]),
      new Set(),
    );

    expect(targets).toEqual(["emulator-5554"]);
  });

  test("excludes a serial with an in-flight provisionDevice/startDevice lease (#7536)", () => {
    // AndroidEmulatorClient's own fresh-provision readiness wait
    // (maybeRecoverFreshOffline) already owns bounded offline recovery for a
    // serial mid-startup, on its own 15s threshold. The monitor must not race
    // a second concurrent 'adb reconnect offline' against that dispatch.
    const targets = selectOfflineRecoveryCandidates(
      new Set(["emulator-5554"]),
      new Set(["emulator-5554"]),
      new Set(),
      new Set(["emulator-5554"]),
    );

    expect(targets).toEqual([]);
  });

  test("still selects an offline candidate with no in-flight startup lease", () => {
    const targets = selectOfflineRecoveryCandidates(
      new Set(["emulator-5554", "emulator-5556"]),
      new Set(["emulator-5554", "emulator-5556"]),
      new Set(),
      new Set(["emulator-5556"]),
    );

    expect(targets).toEqual(["emulator-5554"]);
  });

  test("defaults to no in-flight-startup exclusions when the parameter is omitted", () => {
    const targets = selectOfflineRecoveryCandidates(
      new Set(["emulator-5554"]),
      new Set(["emulator-5554"]),
      new Set(),
    );

    expect(targets).toEqual(["emulator-5554"]);
  });
});

describe("pruneStaleOfflineRecoveryAttempts", () => {
  test("keeps an attempted entry while the serial is still a candidate and still offline", () => {
    const pruned = pruneStaleOfflineRecoveryAttempts(
      new Set(["emulator-5554"]),
      new Set(["emulator-5554"]),
      new Set(["emulator-5554"]),
    );

    expect(pruned).toEqual(new Set(["emulator-5554"]));
  });

  test("drops an attempted entry once the serial recovers (leaves offline)", () => {
    const pruned = pruneStaleOfflineRecoveryAttempts(
      new Set(["emulator-5554"]),
      new Set(["emulator-5554"]),
      new Set(),
    );

    expect(pruned).toEqual(new Set());
  });

  test("drops an attempted entry once the serial leaves the candidate set", () => {
    const pruned = pruneStaleOfflineRecoveryAttempts(
      new Set(["emulator-5554"]),
      new Set(),
      new Set(["emulator-5554"]),
    );

    expect(pruned).toEqual(new Set());
  });

  test("a later offline episode gets a fresh recovery attempt after pruning", () => {
    let attempted = new Set(["emulator-5554"]);

    // Episode 1 ends: the serial came back online.
    attempted = pruneStaleOfflineRecoveryAttempts(attempted, new Set(["emulator-5554"]), new Set());
    expect(attempted.size).toBe(0);

    // Episode 2 begins: offline again, and it is a fresh recovery target.
    const targets = selectOfflineRecoveryCandidates(
      new Set(["emulator-5554"]),
      new Set(["emulator-5554"]),
      attempted,
    );
    expect(targets).toEqual(["emulator-5554"]);
  });
});
