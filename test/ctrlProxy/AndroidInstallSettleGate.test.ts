import { describe, expect, test } from "bun:test";
import {
  createAdbAndroidInstallSettleProbe,
  AndroidInstallSettleGate,
} from "../../src/ctrlProxy/AndroidInstallSettleGate";
import { ActionableError } from "../../src/models/ActionableError";
import { sequenceBackoff } from "../../src/utils/Backoff";
import { createExecResult } from "../../src/utils/execResult";
import { FakeAdbExecutor } from "../fakes/FakeAdbExecutor";
import { FakeAndroidInstallSettleProbe } from "../fakes/FakeAndroidInstallSettleProbe";
import { FakeTimer } from "../fakes/FakeTimer";

describe("Android install settle gate", () => {
  test.each(["packageReady", "bootReady", "userReady"] as const)(
    "waits for %s then passes with fake time",
    async (field) => {
      const timer = new FakeTimer();
      timer.enableAutoAdvance();
      const probe = new FakeAndroidInstallSettleProbe();
      probe[field] = [false, true];
      await new AndroidInstallSettleGate(probe, timer, {
        backoff: sequenceBackoff([10]),
      }).wait("automotive");
      expect(timer.now()).toBe(10);
      expect(probe.calls.filter((s) => s === "pm path android")).toHaveLength(2);
    },
  );

  test.each([
    ["packageReady", "pm path android"],
    ["bootReady", "sys.boot_completed"],
    ["userReady", "foreground user"],
  ] as const)("names %s when its budget expires", async (field, signal) => {
    const timer = new FakeTimer();
    timer.enableAutoAdvance();
    const probe = new FakeAndroidInstallSettleProbe();
    probe[field] = [false];
    const pending = new AndroidInstallSettleGate(probe, timer, {
      budgetMs: 25,
      backoff: sequenceBackoff([10]),
    }).wait("automotive");
    await expect(pending).rejects.toBeInstanceOf(ActionableError);
    await expect(pending).rejects.toThrow(signal);
    expect(timer.now()).toBe(25);
  });

  test("phone issues no probe commands", async () => {
    const adb = new FakeAdbExecutor();
    await new AndroidInstallSettleGate(
      createAdbAndroidInstallSettleProbe(adb, { formFactor: "phone" }),
      new FakeTimer(),
    ).wait("phone");
    expect(adb.getExecutedCommands()).toEqual([]);
  });

  test("watch never asks for the foreground user", async () => {
    const probe = new FakeAndroidInstallSettleProbe();
    await new AndroidInstallSettleGate(probe, new FakeTimer()).wait("watch");
    expect(probe.calls).toEqual(["pm path android", "sys.boot_completed"]);
  });

  test("a missing framework package service stays within the settle gate", async () => {
    class FrameworkStartingProbe extends FakeAndroidInstallSettleProbe {
      attempts = 0;
      override async packageManagerReady(): Promise<boolean> {
        if (++this.attempts === 1) {
          throw new Error("cmd: Can't find service: package");
        }
        return true;
      }
    }
    const timer = new FakeTimer();
    timer.enableAutoAdvance();
    const probe = new FrameworkStartingProbe();
    await new AndroidInstallSettleGate(probe, timer).wait("watch");
    expect(probe.attempts).toBe(2);
    expect(timer.now()).toBe(250);
  });

  test("a hung probe is cancelled at the budget with its signal named", async () => {
    class HungProbe extends FakeAndroidInstallSettleProbe {
      signal?: AbortSignal;
      override packageManagerReady(signal: AbortSignal): Promise<boolean> {
        this.signal = signal;
        return new Promise(() => {});
      }
    }
    const timer = new FakeTimer();
    timer.enableAutoAdvance();
    const probe = new HungProbe();
    await expect(
      new AndroidInstallSettleGate(probe, timer, { budgetMs: 25 }).wait("watch"),
    ).rejects.toThrow("pm path android");
    expect(timer.now()).toBe(25);
    expect(probe.signal?.aborted).toBe(true);
    expect(timer.getPendingTimeoutCount()).toBe(0);
  });

  test("retries adb authorization during first boot inside the settle budget", async () => {
    class AuthorizingAdbExecutor extends FakeAdbExecutor {
      attempts = 0;
      override async executeCommand(
        command: string,
        options: Parameters<FakeAdbExecutor["executeCommand"]>[1] = {},
      ) {
        const result = await super.executeCommand(command, options);
        if (command === "shell pm path android" && ++this.attempts === 1) {
          throw new Error("adb: device still authorizing");
        }
        return result;
      }
    }
    const adb = new AuthorizingAdbExecutor();
    adb.setCommandResponse(
      "pm path android",
      createExecResult("package:/system/framework/framework-res.apk", ""),
    );
    adb.setCommandResponse("getprop sys.boot_completed", createExecResult("1", ""));
    adb.setCommandResponse("am get-current-user", createExecResult("10", ""));
    const timer = new FakeTimer();
    timer.enableAutoAdvance();
    await new AndroidInstallSettleGate(
      createAdbAndroidInstallSettleProbe(adb, { formFactor: "automotive" }),
      timer,
      { backoff: sequenceBackoff([10]) },
    ).wait("automotive");
    expect(timer.now()).toBe(10);
    const calls = adb.getCommandCalls().filter((call) => call.command === "shell pm path android");
    expect(calls).toHaveLength(2);
    for (const call of calls) {
      expect(call.noRetry).toBe(true);
      expect(call.signal).toBeInstanceOf(AbortSignal);
      expect(call.signal).toBe(calls[0]!.signal);
    }
  });

  test("persistent adb authorization exhausts the pm path android settle budget", async () => {
    const adb = new FakeAdbExecutor();
    adb.setCommandError("pm path android", new Error("adb: device still authorizing"));
    const timer = new FakeTimer();
    timer.enableAutoAdvance();
    const pending = new AndroidInstallSettleGate(
      createAdbAndroidInstallSettleProbe(adb, { formFactor: "automotive" }),
      timer,
      { budgetMs: 25, backoff: sequenceBackoff([10]) },
    ).wait("automotive");
    await expect(pending).rejects.toBeInstanceOf(ActionableError);
    await expect(pending).rejects.toThrow("pm path android");
    expect(timer.now()).toBe(25);
  });

  test("unrelated adb failures propagate without retrying pm path android", async () => {
    const adb = new FakeAdbExecutor();
    const error = new Error("adb: device offline");
    adb.setCommandError("pm path android", error);
    const timer = new FakeTimer();
    timer.enableAutoAdvance();
    await expect(
      new AndroidInstallSettleGate(
        createAdbAndroidInstallSettleProbe(adb, { formFactor: "automotive" }),
        timer,
        { backoff: sequenceBackoff([10]) },
      ).wait("automotive"),
    ).rejects.toBe(error);
    expect(adb.getExecutedCommands()).toEqual(["shell pm path android"]);
    expect(timer.now()).toBe(0);
  });

  test("live probe uses the existing automotive user resolver through headless boot", async () => {
    const adb = new FakeAdbExecutor();
    adb.setCommandResponse(
      "pm path android",
      createExecResult("package:/system/framework/framework-res.apk\n", ""),
    );
    adb.setCommandResponse("getprop sys.boot_completed", createExecResult("1\n", ""));
    adb.setCommandResponseSequence(
      "am get-current-user",
      ["", "0", "10"].map((s) => createExecResult(s, "")),
    );
    adb.setCommandResponse("headless_system_user", createExecResult("true", ""));
    const timer = new FakeTimer();
    timer.enableAutoAdvance();
    await new AndroidInstallSettleGate(
      createAdbAndroidInstallSettleProbe(adb, { formFactor: "automotive" }),
      timer,
    ).wait("automotive");
    expect(adb.getExecutedCommands().filter((s) => s === "shell am get-current-user")).toHaveLength(
      3,
    );
    expect(adb.getCommandCalls().every((call) => call.noRetry && call.signal)).toBe(true);
  });

  test("abort cancels a pending gate without another probe", async () => {
    const timer = new FakeTimer();
    const probe = new FakeAndroidInstallSettleProbe();
    probe.packageReady = [false];
    const controller = new AbortController();
    const pending = new AndroidInstallSettleGate(probe, timer).wait("watch", controller.signal);
    for (let i = 0; i < 20; i++) {
      await Promise.resolve();
    }
    const before = probe.calls.length;
    controller.abort();
    await expect(pending).rejects.toThrow(/cancel|abort/i);
    timer.advanceTime(60_000);
    expect(probe.calls).toHaveLength(before);
    expect(timer.getPendingTimeoutCount()).toBe(0);
  });
});
