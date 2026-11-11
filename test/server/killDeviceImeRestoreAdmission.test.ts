import { describe, expect } from "bun:test";
import { InputDeviceOwnedError } from "../../src/daemon/inputDeviceOwnership";
import { pendingImeRestores } from "../../src/features/action/sendkeys/PendingImeRestore";
import { FakePendingImeRestoreRegistry } from "../fakes/FakePendingImeRestoreRegistry";
import { setDeviceToolsDependencies } from "../../src/server/deviceTools";
import { BASE, restartStopHarness } from "../helpers/restartStopHarness";

// killDevice's ownership check runs inside its handler, so the registry must not restore the
// target's keyboard before that check admits the caller (#16579).
describe("killDevice flushes the target's pending IME restore only after admission", () => {
  const { test, fixture, cleanups } = restartStopHarness();

  async function heldDeviceWithPendingRestore() {
    const f = await fixture("android", false, false, "owner-conn", false);
    const events: string[] = [];
    pendingImeRestores.store(f.device.deviceId, {
      snapshot: { prior: "keyboard/.Ime", wasEnabled: false, priorSubtype: { id: null } },
      userId: 0,
      restore: async () => {
        events.push(`restore:${f.manager.killed.length}`);
      },
    });
    cleanups.push(() => {
      pendingImeRestores.discard(f.device.deviceId);
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

  test("an injected registry receives the admitted caller's flush", async () => {
    const f = await fixture("android", false, false, "owner-conn", false);
    const injected = new FakePendingImeRestoreRegistry();
    setDeviceToolsDependencies({ pendingImeRestores: injected });
    await expect(f.call("killDevice", undefined, false, "rival-conn")).rejects.toBeInstanceOf(
      InputDeviceOwnedError,
    );
    expect(injected.flushes).toEqual([]);
    await f.call("killDevice", BASE, false, "owner-conn");
    expect(injected.flushes).toEqual([f.device.deviceId]);
  });
});

// A device about to stop does not need its keyboard back, so a failed restore must not stop the kill (#17879).
describe("killDevice continues when the pending IME restore fails", () => {
  const { test, fixture } = restartStopHarness();

  test("the admitted caller's kill proceeds after the registry's flush rejects", async () => {
    const f = await fixture("android", false, false, "owner-conn", false);
    const injected = new FakePendingImeRestoreRegistry();
    injected.error = new Error("ime list timed out");
    setDeviceToolsDependencies({ pendingImeRestores: injected });
    await f.call("killDevice", BASE, false, "owner-conn");
    expect(injected.flushes).toEqual([f.device.deviceId]);
    expect(f.manager.killed).toEqual([f.device.deviceId]);
  });
});
