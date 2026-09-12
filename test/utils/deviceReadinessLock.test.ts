import { describe, expect, test } from "bun:test";
import {
  deviceReadinessLockKey,
  getDeviceAcquisitionReadiness,
  moveDeviceAcquisitionReadiness,
  trackDeviceAcquisitionReadiness,
} from "../../src/utils/deviceReadinessLock";

describe("moveDeviceAcquisitionReadiness", () => {
  test("moves an in-flight marker onto a replacement key that has none", async () => {
    const fromKey = deviceReadinessLockKey("android", "emulator-5554");
    const toKey = deviceReadinessLockKey("android", "emulator-5560");

    let settle!: () => void;
    const started = new Promise<void>((resolve) => {
      settle = resolve;
    });
    const tracked = trackDeviceAcquisitionReadiness(fromKey, async () => {
      await started;
    });
    // Let trackDeviceAcquisitionReadiness install its marker.
    await Promise.resolve();

    const marker = getDeviceAcquisitionReadiness(fromKey);
    expect(marker).toBeDefined();

    moveDeviceAcquisitionReadiness(fromKey, toKey);
    expect(getDeviceAcquisitionReadiness(toKey)).toBe(marker);

    settle();
    await tracked;
    // Settling clears every alias of the marker, including the moved-to key.
    expect(getDeviceAcquisitionReadiness(toKey)).toBeUndefined();
    expect(getDeviceAcquisitionReadiness(fromKey)).toBeUndefined();
  });

  test("does not clobber a distinct in-flight marker already tracking the replacement key", async () => {
    // A recovery replaces acquisition A's serial with one that a concurrent
    // acquisition B is already preparing. Moving A's marker onto B's key must
    // not evict B's marker: an awaiter on that key would otherwise be handed
    // A's marker and could stop waiting the moment A settles while B's CtrlProxy
    // setup is still mid-flight — the double-setup race the marker prevents.
    const fromKey = deviceReadinessLockKey("android", "emulator-5554");
    const sharedKey = deviceReadinessLockKey("android", "emulator-5560");

    let settleA!: () => void;
    const startedA = new Promise<void>((resolve) => {
      settleA = resolve;
    });
    let settleB!: () => void;
    const startedB = new Promise<void>((resolve) => {
      settleB = resolve;
    });

    const trackedA = trackDeviceAcquisitionReadiness(fromKey, async () => {
      await startedA;
    });
    const trackedB = trackDeviceAcquisitionReadiness(sharedKey, async () => {
      await startedB;
    });
    await Promise.resolve();

    const markerB = getDeviceAcquisitionReadiness(sharedKey);
    const markerA = getDeviceAcquisitionReadiness(fromKey);
    expect(markerB).toBeDefined();
    expect(markerA).not.toBe(markerB);

    moveDeviceAcquisitionReadiness(fromKey, sharedKey);

    // B's live marker is preserved; A's did not overwrite it.
    expect(getDeviceAcquisitionReadiness(sharedKey)).toBe(markerB);

    settleA();
    settleB();
    await Promise.all([trackedA, trackedB]);
  });
});
