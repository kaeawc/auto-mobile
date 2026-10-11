import { describe, expect, test } from "bun:test";
import type { AppearanceConfig, AppearanceMode } from "../../src/models";
import {
  AppearanceSyncScheduler,
  type AppearanceSyncTarget,
} from "../../src/daemon/AppearanceSyncScheduler";
import { FakeTimer } from "../fakes/FakeTimer";

/**
 * The background host-appearance sync decides who holds a device when a tick starts
 * (`scope.getTargets()`), but the write (`cmd uimode night …`) can be due much later: a tick walks
 * its devices one at a time and waits up to the 10 s apply deadline on each, and `beforeApply`
 * (the daemon's settings-default record) waits behind a pending acquisition reset. By then the
 * holder may have released the device, another session with its own appearance config (#10976)
 * may hold it, the holder may have turned sync off, or the scheduler may have stopped.
 *
 * Contract (#11641): control writes on a device are for its holder only, so the scheduler re-reads
 * the holder, its config, the kill switch and its own stopped flag immediately before each write.
 */

const SYNC_ON: AppearanceConfig = { syncWithHost: true, defaultMode: "auto", applyOnConnect: true };
const SYNC_OFF: AppearanceConfig = {
  syncWithHost: false,
  defaultMode: "light",
  applyOnConnect: true,
};

function target(deviceId: string, sessionKey: string): AppearanceSyncTarget {
  return { deviceId, name: deviceId, platform: "android", incarnation: 1, sessionKey };
}

async function flushMicrotasks(): Promise<void> {
  for (let i = 0; i < 40; i++) {
    await Promise.resolve();
  }
}

interface Harness {
  timer: FakeTimer;
  scheduler: AppearanceSyncScheduler;
  applied: Array<{ deviceId: string; mode: AppearanceMode }>;
  /** The devices sessions hold right now, as the daemon's scope reports them. */
  held: { targets: AppearanceSyncTarget[] };
  /** Each session's stored config, mutable so a holder can change it mid-flight. */
  configs: Record<string, AppearanceConfig>;
  switches: { enabled: boolean };
  beforeApplied: string[];
}

function harness(options: {
  configs: Record<string, AppearanceConfig>;
  hangOn?: string;
  beforeApply?: (device: AppearanceSyncTarget) => Promise<void>;
}): Harness {
  const timer = new FakeTimer();
  const applied: Harness["applied"] = [];
  const held: Harness["held"] = { targets: [] };
  const switches = { enabled: true };
  const beforeApplied: string[] = [];
  const configs = { ...options.configs };
  const scheduler = new AppearanceSyncScheduler(timer, {
    isEnabled: () => switches.enabled,
    getConfig: async (sessionKey?: string) => configs[sessionKey ?? ""] ?? SYNC_ON,
    resolveMode: async () => "dark",
    apply: async (device, mode) => {
      applied.push({ deviceId: device.deviceId, mode });
      if (device.deviceId === options.hangOn) {
        await new Promise<void>(() => {});
      }
    },
  });
  const beforeApply = options.beforeApply;
  scheduler.setScope({
    getTargets: () => held.targets,
    beforeApply: beforeApply
      ? (device) => {
          beforeApplied.push(device.deviceId);
          return beforeApply(device);
        }
      : undefined,
  });
  return { timer, scheduler, applied, held, configs, switches, beforeApplied };
}

/** A beforeApply that parks until the test settles it. */
function parkedBeforeApply(): { beforeApply: () => Promise<void>; settle: () => void } {
  let settle: () => void = () => {};
  return {
    beforeApply: () =>
      new Promise<void>((resolve) => {
        settle = resolve;
      }),
    settle: () => settle(),
  };
}

describe("host appearance sync re-reads the holder immediately before each write", () => {
  test("a device released while the tick waited on another device's apply is not written", async () => {
    const { timer, scheduler, applied, held } = harness({
      configs: { "session-a": SYNC_ON, "session-b": SYNC_ON },
      hangOn: "emulator-5554",
    });
    held.targets = [target("emulator-5554", "session-a"), target("emulator-5556", "session-b")];

    const tick = scheduler.trigger();
    await flushMicrotasks();
    expect(applied).toEqual([{ deviceId: "emulator-5554", mode: "dark" }]);

    // session-b loses its heartbeat and is released while adb hangs on session-a's device:
    // emulator-5556 has no holder any more.
    held.targets = [target("emulator-5554", "session-a")];
    timer.advanceTime(10_001);
    await flushMicrotasks();
    await tick;

    expect(applied.map((write) => write.deviceId)).toEqual(["emulator-5554"]);
    await scheduler.stop();
  });

  test("the previous holder's config never re-themes the device for a new holder with sync off", async () => {
    const { timer, scheduler, applied, held } = harness({
      configs: { "session-a": SYNC_ON, "session-b": SYNC_ON, "session-c": SYNC_OFF },
      hangOn: "emulator-5554",
    });
    held.targets = [target("emulator-5554", "session-a"), target("emulator-5556", "session-b")];

    const tick = scheduler.trigger();
    await flushMicrotasks();

    // session-b is released and session-c, whose own config says "do not follow the host",
    // acquires emulator-5556 before the tick reaches it.
    held.targets = [target("emulator-5554", "session-a"), target("emulator-5556", "session-c")];
    timer.advanceTime(10_001);
    await flushMicrotasks();
    await tick;

    expect(applied.filter((write) => write.deviceId === "emulator-5556")).toEqual([]);
    await scheduler.stop();
  });

  test("a new holder that follows the host is written under its own config on the next tick", async () => {
    const parked = parkedBeforeApply();
    const { scheduler, applied, held } = harness({
      configs: { "session-a": SYNC_ON, "session-b": SYNC_ON },
      beforeApply: parked.beforeApply,
    });
    held.targets = [target("emulator-5554", "session-a")];
    const first = scheduler.trigger();
    await flushMicrotasks();

    held.targets = [target("emulator-5554", "session-b")];
    parked.settle();
    await first;
    // The skipped write is not remembered as applied, so session-b's device is not left stale.
    expect(applied).toEqual([]);

    const second = scheduler.trigger();
    await flushMicrotasks();
    parked.settle();
    await second;

    expect(applied).toEqual([{ deviceId: "emulator-5554", mode: "dark" }]);
    await scheduler.stop();
  });

  test("an apply parked behind beforeApply does not write after its holder released the device", async () => {
    const parked = parkedBeforeApply();
    const { scheduler, applied, held } = harness({
      configs: { "session-a": SYNC_ON },
      // The daemon's beforeApply waits behind the device's pending acquisition reset (#11145).
      beforeApply: parked.beforeApply,
    });
    const device = target("emulator-5554", "session-a");
    held.targets = [device];

    // What the daemon runs when session-a is created on the device.
    const sync = scheduler.syncDevice(device);
    await flushMicrotasks();
    expect(applied).toEqual([]);

    // session-a is released before the reset it waited behind finishes.
    held.targets = [];
    parked.settle();
    await flushMicrotasks();
    await sync;

    expect(applied).toEqual([]);
    await scheduler.stop();
  });

  test("an apply parked behind beforeApply does not write after its holder turned sync off", async () => {
    const parked = parkedBeforeApply();
    const { scheduler, applied, held, configs } = harness({
      configs: { "session-a": SYNC_ON },
      beforeApply: parked.beforeApply,
    });
    const device = target("emulator-5554", "session-a");
    held.targets = [device];

    const sync = scheduler.syncDevice(device);
    await flushMicrotasks();
    // The holder runs `set_appearance light`, which stores syncWithHost false under its session.
    configs["session-a"] = SYNC_OFF;
    parked.settle();
    await sync;

    expect(applied).toEqual([]);
    await scheduler.stop();
  });

  test("an apply parked behind beforeApply does not write after the kill switch was thrown", async () => {
    const parked = parkedBeforeApply();
    const { scheduler, applied, held, switches } = harness({
      configs: { "session-a": SYNC_ON },
      beforeApply: parked.beforeApply,
    });
    const device = target("emulator-5554", "session-a");
    held.targets = [device];

    const sync = scheduler.syncDevice(device);
    await flushMicrotasks();
    switches.enabled = false;
    parked.settle();
    await sync;

    expect(applied).toEqual([]);
    await scheduler.stop();
  });

  test("an apply parked behind beforeApply does not write after the scheduler was stopped", async () => {
    const parked = parkedBeforeApply();
    const { timer, scheduler, applied, held } = harness({
      configs: { "session-a": SYNC_ON },
      beforeApply: parked.beforeApply,
    });
    held.targets = [target("emulator-5554", "session-a")];

    const tick = scheduler.trigger();
    await flushMicrotasks();
    const stopping = scheduler.stop();
    // stop() waits for the tick only until the apply deadline; nothing has been written yet.
    timer.advanceTime(10_001);
    await stopping;
    await tick;
    expect(applied).toEqual([]);

    parked.settle();
    await flushMicrotasks();

    expect(applied).toEqual([]);
  });

  test("beforeApply is not run for a device its decided holder no longer holds", async () => {
    const { scheduler, applied, held, beforeApplied } = harness({
      configs: { "session-a": SYNC_ON },
      beforeApply: async () => {},
    });
    held.targets = [];

    // The session-created sync races the session's release.
    await scheduler.syncDevice(target("emulator-5554", "session-a"));

    expect(beforeApplied).toEqual([]);
    expect(applied).toEqual([]);
    await scheduler.stop();
  });
});
