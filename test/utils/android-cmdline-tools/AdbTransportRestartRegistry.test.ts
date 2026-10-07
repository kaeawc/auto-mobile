import { describe, expect, test } from "bun:test";
import { AdbClient } from "../../../src/utils/android-cmdline-tools/AdbClient";
import {
  ADB_TRANSPORT_RESTART_GRACE_MS,
  InMemoryAdbTransportRestartRegistry,
  isAdbTransportRestartCommand,
} from "../../../src/utils/android-cmdline-tools/AdbTransportRestartRegistry";
import { createExecResult } from "../../../src/utils/execResult";
import { DefaultRetryExecutor } from "../../../src/utils/retry/RetryExecutor";
import type { BootedDevice } from "../../../src/models";
import { FakeTimer } from "../../fakes/FakeTimer";

const PHONE = "57281FDCH00462";

describe("InMemoryAdbTransportRestartRegistry", () => {
  test("marks a serial while the restart runs and for the grace after it", async () => {
    const timer = new FakeTimer();
    const registry = new InMemoryAdbTransportRestartRegistry(timer);
    const gate = Promise.withResolvers<void>();
    const restart = registry.runRestart(PHONE, () => gate.promise);
    expect(registry.isRestarting(PHONE)).toBe(true);
    expect(registry.isRestarting("OTHER")).toBe(false);
    timer.advanceTime(60_000);
    expect(registry.isRestarting(PHONE)).toBe(true);
    gate.resolve();
    await restart;
    timer.advanceTime(ADB_TRANSPORT_RESTART_GRACE_MS - 1);
    expect(registry.isRestarting(PHONE)).toBe(true);
    timer.advanceTime(1);
    expect(registry.isRestarting(PHONE)).toBe(false);
    expect(timer.getSleepHistory()).toEqual([]);
  });

  test("a failed restart still clears after the grace", async () => {
    const timer = new FakeTimer();
    const registry = new InMemoryAdbTransportRestartRegistry(timer);
    await expect(
      registry.runRestart(PHONE, async () => {
        throw new Error("adbd refused");
      }),
    ).rejects.toThrow("adbd refused");
    expect(registry.isRestarting(PHONE)).toBe(true);
    timer.advanceTime(ADB_TRANSPORT_RESTART_GRACE_MS);
    expect(registry.isRestarting(PHONE)).toBe(false);
  });

  test("overlapping restarts keep the serial marked until the last ends", async () => {
    const timer = new FakeTimer();
    const registry = new InMemoryAdbTransportRestartRegistry(timer);
    const first = Promise.withResolvers<void>();
    const second = Promise.withResolvers<void>();
    const a = registry.runRestart(PHONE, () => first.promise);
    const b = registry.runRestart(PHONE, () => second.promise);
    first.resolve();
    await a;
    timer.advanceTime(ADB_TRANSPORT_RESTART_GRACE_MS);
    expect(registry.isRestarting(PHONE)).toBe(true);
    second.resolve();
    await b;
    timer.advanceTime(ADB_TRANSPORT_RESTART_GRACE_MS);
    expect(registry.isRestarting(PHONE)).toBe(false);
  });

  test.each([
    [["root"], true],
    [["unroot"], true],
    [["shell", "id"], false],
    [["wait-for-device"], false],
    [[], false],
  ])("isAdbTransportRestartCommand(%p) -> %p", (args, expected) => {
    expect(isAdbTransportRestartCommand(args)).toBe(expected);
  });
});

describe("AdbClient transport restart marking", () => {
  const device: BootedDevice = { deviceId: PHONE, platform: "android", name: "Pixel" };

  function client(registry: InMemoryAdbTransportRestartRegistry, seen: boolean[]) {
    const timer = new FakeTimer();
    timer.enableAutoAdvance();
    return new AdbClient(
      device,
      async () => {
        seen.push(registry.isRestarting(PHONE));
        return createExecResult("", "");
      },
      null,
      new DefaultRetryExecutor(timer),
      timer,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      registry,
    );
  }

  test.each(["root", "unroot"])(
    "adb %s marks the serial during and after the command",
    async (cmd) => {
      const registry = new InMemoryAdbTransportRestartRegistry(new FakeTimer());
      const seen: boolean[] = [];
      await client(registry, seen).executeCommand(cmd);
      expect(seen).toEqual([true]);
      expect(registry.isRestarting(PHONE)).toBe(true);
    },
  );

  test("other commands leave the serial unmarked", async () => {
    const registry = new InMemoryAdbTransportRestartRegistry(new FakeTimer());
    const seen: boolean[] = [];
    await client(registry, seen).executeCommand("shell id");
    expect(seen).toEqual([false]);
    expect(registry.isRestarting(PHONE)).toBe(false);
  });
});
