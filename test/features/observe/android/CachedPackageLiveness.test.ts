import { describe, expect, test } from "bun:test";
import {
  CachedPackageLiveness,
  PACKAGE_LIVENESS_REUSE_MS,
} from "../../../../src/features/observe/android/CachedPackageLiveness";
import type {
  AccessibilityHierarchy,
  CachedHierarchy,
} from "../../../../src/features/observe/android/types";
import { FakeAdbClient } from "../../../fakes/FakeAdbClient";
import { FakeTimer } from "../../../fakes/FakeTimer";

const PROCESSES = "shell dumpsys activity processes";

function cached(packageName: string, userId?: number): CachedHierarchy {
  return {
    hierarchy: { updatedAt: 0, packageName, userId } as AccessibilityHierarchy,
    receivedAt: 0,
    fresh: true,
  };
}

function setup() {
  const adb = new FakeAdbClient();
  const timer = new FakeTimer();
  const liveness = new CachedPackageLiveness(() => adb, timer);
  const probes = () => adb.getCommandCalls().filter((call) => call.command === PROCESSES).length;
  return { adb, timer, liveness, probes };
}

describe("CachedPackageLiveness (#18902)", () => {
  test("a settle poll reuses a running answer instead of re-reading the process table", async () => {
    const { adb, timer, liveness, probes } = setup();
    adb.setCommandResult(PROCESSES, "1234:com.example.app/u0a123\n");

    expect(await liveness.isRunning(cached("com.example.app"), 1_000)).toBe(true);
    timer.advanceTime(150);
    expect(await liveness.isRunning(cached("com.example.app"), 1_000)).toBe(true);
    timer.advanceTime(150);
    expect(await liveness.isRunning(cached("com.example.app"), 1_000)).toBe(true);

    expect(probes()).toBe(1);
  });

  test("the answer is read again once the reuse window has passed", async () => {
    const { adb, timer, liveness, probes } = setup();
    adb.setCommandResult(PROCESSES, "1234:com.example.app/u0a123\n");

    await liveness.isRunning(cached("com.example.app"), 1_000);
    timer.advanceTime(PACKAGE_LIVENESS_REUSE_MS);
    adb.setCommandResult(PROCESSES, "");

    expect(await liveness.isRunning(cached("com.example.app"), 1_000)).toBe(false);
    expect(probes()).toBe(2);
  });

  test("a dead package is never reused", async () => {
    const { adb, liveness, probes } = setup();
    adb.setCommandResult(PROCESSES, "");

    expect(await liveness.isRunning(cached("com.example.app"), 1_000)).toBe(false);
    expect(await liveness.isRunning(cached("com.example.app"), 1_000)).toBe(false);
    expect(probes()).toBe(2);
  });

  test("another package or user is probed afresh", async () => {
    const { adb, liveness, probes } = setup();
    adb.setCommandResult(PROCESSES, "1234:com.example.app/u0a123\n5678:com.other.app/u10a7\n");

    await liveness.isRunning(cached("com.example.app"), 1_000);
    expect(await liveness.isRunning(cached("com.other.app", 10), 1_000)).toBe(true);
    expect(await liveness.isRunning(cached("com.example.app", 10), 1_000)).toBe(false);
    expect(probes()).toBe(3);
  });

  test("a failed probe keeps the cache and is not reused", async () => {
    const { adb, liveness, probes } = setup();
    adb.setCommandError(PROCESSES, new Error("dumpsys unavailable"));

    expect(await liveness.isRunning(cached("com.example.app"), 1_000)).toBe(true);
    expect(await liveness.isRunning(cached("com.example.app"), 1_000)).toBe(true);
    expect(probes()).toBe(2);
  });
});
