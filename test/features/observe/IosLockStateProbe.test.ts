import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { ExecResult } from "../../../src/models";
import {
  NotifyutilIosLockStateProbe,
  type IosLockStateExecutor,
} from "../../../src/features/observe/ios/IosLockStateProbe";

const fixtures = join(import.meta.dir, "../../fixtures/ios-lock-state");
const deviceId = "1CBBDFF1-96B4-479E-85D2-489FFAC3BC3E";

class FakeExecutor implements IosLockStateExecutor {
  command?: string;
  timeoutMs?: number;
  signal?: AbortSignal;
  output = "";
  failure?: Error;

  async executeCommand(
    command: string,
    timeoutMs?: number,
    signal?: AbortSignal,
  ): Promise<ExecResult> {
    this.command = command;
    this.timeoutMs = timeoutMs;
    this.signal = signal;
    if (this.failure) {
      throw this.failure;
    }
    return {
      stdout: this.output,
      stderr: "",
      toString: () => this.output,
      trim: () => this.output.trim(),
      includes: (value) => this.output.includes(value),
    };
  }
}

describe("iOS simulator lock-state probe", () => {
  for (const filename of [
    "notifyutil-locked-immediately-after-power.txt",
    "notifyutil-locked-t9s.txt",
    "notifyutil-locked-screen-blanked.txt",
  ]) {
    test(`reads locked state from ${filename}`, async () => {
      const executor = new FakeExecutor();
      executor.output = readFileSync(join(fixtures, filename), "utf8");
      const signal = new AbortController().signal;
      expect(await new NotifyutilIosLockStateProbe(executor).read(deviceId, signal)).toEqual({
        locked: true,
        keyguardShowing: true,
      });
      expect(executor.command).toBe(
        `spawn ${deviceId} notifyutil -g com.apple.springboard.lockstate`,
      );
      expect(executor.timeoutMs).toBe(2_000);
      expect(executor.signal).toBe(signal);
    });
  }

  test("reads unlocked state", async () => {
    const executor = new FakeExecutor();
    executor.output = readFileSync(join(fixtures, "notifyutil-unlocked.txt"), "utf8");
    expect(await new NotifyutilIosLockStateProbe(executor).read(deviceId)).toEqual({
      locked: false,
      keyguardShowing: false,
    });
  });

  test("returns undefined for unparseable output", async () => {
    const executor = new FakeExecutor();
    executor.output = "garbage";
    expect(await new NotifyutilIosLockStateProbe(executor).read(deviceId)).toBeUndefined();
  });

  test("returns undefined when the executor fails", async () => {
    const executor = new FakeExecutor();
    executor.failure = new Error("simctl unavailable");
    expect(await new NotifyutilIosLockStateProbe(executor).read(deviceId)).toBeUndefined();
  });
});
