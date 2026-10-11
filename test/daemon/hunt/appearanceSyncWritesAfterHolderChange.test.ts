import { describe, expect, test } from "bun:test";
import type { AppearanceMode } from "../../../src/models";
import type { AppearanceConfig } from "../../../src/server/appearanceManager";
import {
  AppearanceSyncScheduler,
  type AppearanceSyncTarget,
} from "../../../src/daemon/AppearanceSyncScheduler";
import { FakeTimer } from "../../fakes/FakeTimer";

/**
 * HUNT: the background host-appearance sync decides who holds a device ONCE, when a tick starts
 * (`scope.getTargets()`), and never looks again before it writes `cmd uimode night …`. A tick
 * walks its devices one at a time and waits up to the 10 s apply deadline on each, so the write to
 * a later device can be issued up to 10 s per earlier device after its holder was read. That is as
 * long as the heartbeat release window: by then the holder may have released the device, and
 * another session with its own appearance config (#10976) may hold it.
 *
 * The same holds inside one apply: `beforeApply` (the daemon's settings-default record, which waits
 * up to 15 s behind a pending acquisition reset) is chained with `.then(() => apply(...))`, so the
 * write fires whenever that settles, with no re-check of the holder, the kill switch or `stop()`.
 *
 * Contract: control writes on a device are for its holder only, and one session's config never
 * re-themes a device another session holds (#10976). The scheduler already rechecks the kill
 * switch after an async config read (test/daemon/appearanceSyncOff.test.ts); it does not recheck
 * the holder.
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
}

function harness(options: {
  configs: Record<string, AppearanceConfig>;
  hangOn?: string;
  beforeApply?: (device: AppearanceSyncTarget) => Promise<void>;
}): Harness {
  const timer = new FakeTimer();
  const applied: Harness["applied"] = [];
  const held: Harness["held"] = { targets: [] };
  const scheduler = new AppearanceSyncScheduler(timer, {
    isEnabled: () => true,
    getConfig: async (sessionKey?: string) => options.configs[sessionKey ?? ""] ?? SYNC_ON,
    resolveMode: async () => "dark",
    apply: async (device, mode) => {
      applied.push({ deviceId: device.deviceId, mode });
      if (device.deviceId === options.hangOn) {
        await new Promise<void>(() => {});
      }
    },
  });
  scheduler.setScope({ getTargets: () => held.targets, beforeApply: options.beforeApply });
  return { timer, scheduler, applied, held };
}

describe("HUNT: host appearance sync writes to a device its tick's holder no longer holds", () => {
  test("a device released while the tick waited on another device's apply is still written", async () => {
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

    // FAILS: the tick writes night mode to emulator-5556, a device no session holds.
    expect(applied.map((write) => write.deviceId)).toEqual(["emulator-5554"]);
    await scheduler.stop();
  });

  test("the previous holder's config re-themes the device for a new holder that turned sync off", async () => {
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

    // FAILS: session-c's device is switched to dark under session-b's config.
    expect(applied.filter((write) => write.deviceId === "emulator-5556")).toEqual([]);
    await scheduler.stop();
  });

  test("an apply parked behind beforeApply still writes after its holder released the device", async () => {
    let settleBeforeApply: () => void = () => {};
    const { scheduler, applied, held } = harness({
      configs: { "session-a": SYNC_ON },
      // The daemon's beforeApply waits behind the device's pending acquisition reset (#11145).
      beforeApply: () =>
        new Promise<void>((resolve) => {
          settleBeforeApply = resolve;
        }),
    });
    const device = target("emulator-5554", "session-a");
    held.targets = [device];

    // What the daemon runs when session-a is created on the device.
    const sync = scheduler.syncDevice(device);
    await flushMicrotasks();
    expect(applied).toEqual([]);

    // session-a is released before the reset it waited behind finishes.
    held.targets = [];
    settleBeforeApply();
    await flushMicrotasks();
    await sync;

    // FAILS: night mode is written to a device nobody holds.
    expect(applied).toEqual([]);
    await scheduler.stop();
  });

  test("an apply parked behind beforeApply still writes after the scheduler was stopped", async () => {
    let settleBeforeApply: () => void = () => {};
    const { timer, scheduler, applied, held } = harness({
      configs: { "session-a": SYNC_ON },
      beforeApply: () =>
        new Promise<void>((resolve) => {
          settleBeforeApply = resolve;
        }),
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

    settleBeforeApply();
    await flushMicrotasks();

    // FAILS: the stopped scheduler (daemon shutting down) still issues the device write.
    expect(applied).toEqual([]);
  });
});
