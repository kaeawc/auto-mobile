import { describe, expect, test } from "bun:test";
import {
  deviceReadinessLockKey,
  getDeviceAcquisitionReadiness,
  moveDeviceAcquisitionReadiness,
  trackDeviceAcquisitionReadiness,
} from "../../src/utils/deviceReadinessLock";

/** Drain pending microtasks (composite markers resolve across several ticks). */
async function flush(): Promise<void> {
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
}

interface Deferred {
  settle: () => void;
  started: Promise<void>;
}

function deferred(): Deferred {
  let settle!: () => void;
  const started = new Promise<void>((resolve) => {
    settle = resolve;
  });
  return { settle, started };
}

describe("moveDeviceAcquisitionReadiness", () => {
  test("moves an in-flight marker onto a replacement key that has none", async () => {
    const fromKey = deviceReadinessLockKey("android", "emulator-5554");
    const toKey = deviceReadinessLockKey("android", "emulator-5560");

    const a = deferred();
    const tracked = trackDeviceAcquisitionReadiness(fromKey, async () => {
      await a.started;
    });
    // Let trackDeviceAcquisitionReadiness install its marker.
    await Promise.resolve();

    const marker = getDeviceAcquisitionReadiness(fromKey);
    expect(marker).toBeDefined();

    moveDeviceAcquisitionReadiness(fromKey, toKey);
    // A lone pending acquisition is handed out by identity - no composite.
    expect(getDeviceAcquisitionReadiness(toKey)).toBe(marker);

    a.settle();
    await tracked;
    // Settling clears every alias of the marker, including the moved-to key.
    expect(getDeviceAcquisitionReadiness(toKey)).toBeUndefined();
    expect(getDeviceAcquisitionReadiness(fromKey)).toBeUndefined();
  });

  test("keeps the replacement key pending until the incoming acquisition also settles", async () => {
    // A recovery replaces acquisition A's serial with one that a concurrent
    // acquisition B is already preparing. B settling first must NOT clear the
    // shared key while A is still binding: an awaiter that sampled the key
    // would otherwise see nothing pending and start a duplicate CtrlProxy
    // setup - the #6280 double-setup race the marker exists to prevent.
    const fromKey = deviceReadinessLockKey("android", "emulator-5554");
    const sharedKey = deviceReadinessLockKey("android", "emulator-5560");

    const a = deferred();
    const b = deferred();

    const trackedA = trackDeviceAcquisitionReadiness(fromKey, async () => {
      await a.started;
    });
    const trackedB = trackDeviceAcquisitionReadiness(sharedKey, async () => {
      await b.started;
    });
    await Promise.resolve();

    const markerB = getDeviceAcquisitionReadiness(sharedKey);
    const markerA = getDeviceAcquisitionReadiness(fromKey);
    expect(markerB).toBeDefined();
    expect(markerA).not.toBe(markerB);

    moveDeviceAcquisitionReadiness(fromKey, sharedKey);

    const shared = getDeviceAcquisitionReadiness(sharedKey);
    expect(shared).toBeDefined();
    let sharedSettled = false;
    void shared!.then(() => {
      sharedSettled = true;
    });

    // B finishes first - the shared key still covers A.
    b.settle();
    await trackedB;
    await flush();
    expect(sharedSettled).toBe(false);
    expect(getDeviceAcquisitionReadiness(sharedKey)).toBeDefined();

    a.settle();
    await trackedA;
    await flush();
    expect(sharedSettled).toBe(true);
    expect(getDeviceAcquisitionReadiness(sharedKey)).toBeUndefined();
    expect(getDeviceAcquisitionReadiness(fromKey)).toBeUndefined();
  });

  test("keeps the replacement key pending when the moved acquisition settles first", async () => {
    // The mirror case: A (moved onto B's key) settles first. B's own setup is
    // still in flight, so the key must stay pending until B settles too.
    const fromKey = deviceReadinessLockKey("android", "emulator-5554");
    const sharedKey = deviceReadinessLockKey("android", "emulator-5560");

    const a = deferred();
    const b = deferred();

    const trackedA = trackDeviceAcquisitionReadiness(fromKey, async () => {
      await a.started;
    });
    const trackedB = trackDeviceAcquisitionReadiness(sharedKey, async () => {
      await b.started;
    });
    await Promise.resolve();

    moveDeviceAcquisitionReadiness(fromKey, sharedKey);

    const shared = getDeviceAcquisitionReadiness(sharedKey);
    expect(shared).toBeDefined();
    let sharedSettled = false;
    void shared!.then(() => {
      sharedSettled = true;
    });

    a.settle();
    await trackedA;
    await flush();
    expect(sharedSettled).toBe(false);
    expect(getDeviceAcquisitionReadiness(sharedKey)).toBeDefined();

    b.settle();
    await trackedB;
    await flush();
    expect(sharedSettled).toBe(true);
    expect(getDeviceAcquisitionReadiness(sharedKey)).toBeUndefined();
  });

  test("is a no-op when the source key has no in-flight acquisition", async () => {
    const fromKey = deviceReadinessLockKey("android", "emulator-5554");
    const toKey = deviceReadinessLockKey("android", "emulator-5560");

    const b = deferred();
    const trackedB = trackDeviceAcquisitionReadiness(toKey, async () => {
      await b.started;
    });
    await Promise.resolve();
    const markerB = getDeviceAcquisitionReadiness(toKey);

    moveDeviceAcquisitionReadiness(fromKey, toKey);
    expect(getDeviceAcquisitionReadiness(toKey)).toBe(markerB);

    b.settle();
    await trackedB;
    expect(getDeviceAcquisitionReadiness(toKey)).toBeUndefined();
  });

  test("moving the same marker twice onto one key does not double-count it", async () => {
    // `startDevice` publishes a recovered replacement marker and then moves the
    // marker again for the settled boot identity; both can name the same key.
    const fromKey = deviceReadinessLockKey("android", "emulator-5554");
    const toKey = deviceReadinessLockKey("android", "emulator-5560");

    const a = deferred();
    const tracked = trackDeviceAcquisitionReadiness(fromKey, async () => {
      await a.started;
    });
    await Promise.resolve();

    moveDeviceAcquisitionReadiness(fromKey, toKey);
    moveDeviceAcquisitionReadiness(fromKey, toKey);
    expect(getDeviceAcquisitionReadiness(toKey)).toBe(getDeviceAcquisitionReadiness(fromKey));

    a.settle();
    await tracked;
    expect(getDeviceAcquisitionReadiness(toKey)).toBeUndefined();
    expect(getDeviceAcquisitionReadiness(fromKey)).toBeUndefined();
  });
});
