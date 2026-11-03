import { describe, expect } from "bun:test";
import { InputDeviceOwnedError } from "../../src/daemon/inputDeviceOwnership";
import { pendingImeRestores } from "../../src/features/action/sendkeys/PendingImeRestore";
import { FakeTimer } from "../fakes/FakeTimer";
import { BASE, restartStopHarness } from "../helpers/restartStopHarness";

// killDevice's ownership check runs inside its handler, so the registry must not restore the
// target's keyboard before that check admits the caller (#16579).
describe("killDevice flushes the target's pending IME restore only after admission", () => {
  const { test, fixture, cleanups } = restartStopHarness();

  async function heldDeviceWithPendingRestore() {
    const f = await fixture("android", false, false, "owner-conn", false);
    const events: string[] = [];
    const imeTimer = new FakeTimer();
    pendingImeRestores.store(
      f.device.deviceId,
      {
        snapshot: { prior: "keyboard/.Ime", wasEnabled: false, priorSubtype: { id: null } },
        userId: 0,
        restore: async () => {
          events.push(`restore:${f.manager.killed.length}`);
        },
      },
      imeTimer,
    );
    cleanups.push(() => {
      pendingImeRestores.discard(f.device.deviceId);
      expect(imeTimer.getPendingTimeoutCount()).toBe(0);
    });
    return { f, events };
  }

  test("a refused sessionless non-owner call leaves the holder's restore pending", async () => {
    const { f, events } = await heldDeviceWithPendingRestore();
    await expect(f.call("killDevice", undefined, false, "rival-conn")).rejects.toBeInstanceOf(
      InputDeviceOwnedError,
    );
    expect(events).toEqual([]);
    expect(pendingImeRestores.hasPending(f.device.deviceId)).toBe(true);
    expect(f.manager.killed).toEqual([]);
  });

  test("the holder's call restores the keyboard before the platform kill", async () => {
    const { f, events } = await heldDeviceWithPendingRestore();
    await f.call("killDevice", BASE, false, "owner-conn");
    expect(events).toEqual(["restore:0"]);
    expect(pendingImeRestores.hasPending(f.device.deviceId)).toBe(false);
    expect(f.manager.killed).toEqual([f.device.deviceId]);
  });
});
