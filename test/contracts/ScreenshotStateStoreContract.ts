import { describe, expect, test } from "bun:test";
import {
  MAX_OBSERVATION_SCREENSHOT_STATES_PER_DEVICE,
  OBSERVE_RESULT_CACHE_TTL_MS,
  type ScreenshotStateStore,
} from "../../src/features/observe/screenshot/ScreenshotStateRegistry";
import { FakeTimer } from "../fakes/FakeTimer";

/**
 * Shared behavioural contract for {@link ScreenshotStateStore} (#11868): the fake and the
 * in-memory production store run the same scenarios on the same FakeTimer.
 */
export function runScreenshotStateStoreContract(
  name: string,
  make: (timer: FakeTimer) => ScreenshotStateStore,
): void {
  const withStore = async (
    body: (store: ScreenshotStateStore, timer: FakeTimer) => Promise<void> | void,
  ): Promise<void> => {
    const timer = new FakeTimer();
    timer.setCurrentTime(1_000_000);
    await body(make(timer), timer);
  };

  describe(`ScreenshotStateStore contract: ${name}`, () => {
    test("an empty store has no path or error", () =>
      withStore((store) => {
        expect(store.getPath()).toBeUndefined();
        expect(store.getPath("d1")).toBeUndefined();
        expect(store.getError("d1")).toBeUndefined();
        expect(store.getReferencedScreenshotPaths()).toEqual([]);
      }));

    test("update is per device and the latest device wins when none is named", () =>
      withStore((store, timer) => {
        store.update("d1", "/a.png");
        timer.advanceTime(10);
        store.update("d2", undefined, "boom");
        expect(store.getPath("d1")).toBe("/a.png");
        expect(store.getError("d1")).toBeUndefined();
        expect(store.getPath("d2")).toBeUndefined();
        expect(store.getError("d2")).toBe("boom");
        expect(store.getError()).toBe("boom");
        expect(store.getPath()).toBeUndefined();
        timer.advanceTime(10);
        store.update("d1", "/b.png");
        expect(store.getPath()).toBe("/b.png");
      }));

    test("latest state expires after the TTL", () =>
      withStore((store, timer) => {
        store.update("d1", "/a.png");
        timer.advanceTime(OBSERVE_RESULT_CACHE_TTL_MS);
        expect(store.getPath("d1")).toBe("/a.png");
        timer.advanceTime(1);
        expect(store.getPath("d1")).toBeUndefined();
        expect(store.getPath()).toBeUndefined();
      }));

    test("observation state is keyed by device and observation, with size only for the same path", () =>
      withStore((store) => {
        store.updateForObservation("d1", "o1", "/a.png", undefined, { width: 10, height: 20 });
        store.updateForObservation("d1", "o2", undefined, "failed");
        expect(store.getPathForObservation("d1", "o1")).toBe("/a.png");
        expect(store.getErrorForObservation("d1", "o2")).toBe("failed");
        expect(store.getPathForObservation("d2", "o1")).toBeUndefined();
        expect(store.getImageSizeForObservation("d1", "o1", "/a.png")).toEqual({
          width: 10,
          height: 20,
        });
        expect(store.getImageSizeForObservation("d1", "o1", "/other.png")).toBeUndefined();
        // Per-observation writes do not touch the device-level latest state.
        expect(store.getPath("d1")).toBeUndefined();
      }));

    test("observation state expires after the TTL", () =>
      withStore((store, timer) => {
        store.updateForObservation("d1", "o1", "/a.png");
        timer.advanceTime(OBSERVE_RESULT_CACHE_TTL_MS + 1);
        expect(store.getPathForObservation("d1", "o1")).toBeUndefined();
      }));

    test("only the newest observation states per device are retained", () =>
      withStore((store) => {
        const total = MAX_OBSERVATION_SCREENSHOT_STATES_PER_DEVICE + 2;
        for (let i = 0; i < total; i++) {
          store.updateForObservation("d1", `o${i}`, `/${i}.png`);
        }
        expect(store.getPathForObservation("d1", "o0")).toBeUndefined();
        expect(store.getPathForObservation("d1", "o1")).toBeUndefined();
        expect(store.getPathForObservation("d1", "o2")).toBe("/2.png");
        expect(store.getPathForObservation("d1", `o${total - 1}`)).toBe(`/${total - 1}.png`);
      }));

    test("a pending observation resolves its waiter when its result is written", () =>
      withStore(async (store) => {
        store.beginObservation("d1", "o1");
        expect(store.isObservationPending("d1", "o1")).toBe(true);
        let resolved = false;
        const waiting = store.waitForObservation("d1", "o1", 5_000).then(() => {
          resolved = true;
        });
        await Promise.resolve();
        expect(resolved).toBe(false);
        store.updateForObservation("d1", "o1", "/a.png");
        await waiting;
        expect(resolved).toBe(true);
        expect(store.isObservationPending("d1", "o1")).toBe(false);
      }));

    test("waiting on an unknown observation resolves immediately and a wait times out", () =>
      withStore(async (store, timer) => {
        await store.waitForObservation("d1", "unknown", 5_000);
        store.beginObservation("d1", "o1");
        let resolved = false;
        const waiting = store.waitForObservation("d1", "o1", 100).then(() => {
          resolved = true;
        });
        timer.advanceTime(100);
        await waiting;
        expect(resolved).toBe(true);
        expect(store.isObservationPending("d1", "o1")).toBe(true);
      }));

    test("endObservation records the reason only when nothing was recorded", () =>
      withStore((store) => {
        store.beginObservation("d1", "o1");
        store.endObservation("d1", "o1", "capture cancelled");
        expect(store.getErrorForObservation("d1", "o1")).toBe("capture cancelled");
        expect(store.isObservationPending("d1", "o1")).toBe(false);

        store.beginObservation("d1", "o2");
        store.updateForObservation("d1", "o2", "/real.png");
        store.endObservation("d1", "o2", "late cancel");
        expect(store.getPathForObservation("d1", "o2")).toBe("/real.png");
        expect(store.getErrorForObservation("d1", "o2")).toBeUndefined();
      }));

    test("clear(device) drops that device, releases its waiters and fences late writes", () =>
      withStore(async (store) => {
        store.update("d1", "/a.png");
        store.update("d2", "/b.png");
        store.beginObservation("d1", "pending");
        const waiting = store.waitForObservation("d1", "pending", 5_000);
        store.clear("d1");
        await waiting;
        expect(store.getPath("d1")).toBeUndefined();
        expect(store.getPath("d2")).toBe("/b.png");
        expect(store.isObservationPending("d1", "pending")).toBe(false);

        // The capture behind the cleared observation may still call back late.
        store.updateForObservation("d1", "pending", "/late.png");
        store.endObservation("d1", "pending", "late");
        expect(store.getPathForObservation("d1", "pending")).toBeUndefined();

        // Reusing the id starts a fresh observation.
        store.beginObservation("d1", "pending");
        store.updateForObservation("d1", "pending", "/fresh.png");
        expect(store.getPathForObservation("d1", "pending")).toBe("/fresh.png");
      }));

    test("clear() drops every device", () =>
      withStore((store) => {
        store.update("d1", "/a.png");
        store.updateForObservation("d2", "o1", "/b.png");
        store.clear();
        expect(store.getPath("d1")).toBeUndefined();
        expect(store.getPathForObservation("d2", "o1")).toBeUndefined();
        expect(store.getReferencedScreenshotPaths()).toEqual([]);
      }));

    test("referenced paths cover unexpired latest and observation state", () =>
      withStore((store, timer) => {
        store.update("d1", "/old.png");
        timer.advanceTime(OBSERVE_RESULT_CACHE_TTL_MS);
        store.update("d2", "/latest.png");
        store.updateForObservation("d2", "o1", "/obs.png");
        timer.advanceTime(1);
        expect([...store.getReferencedScreenshotPaths()].sort()).toEqual([
          "/latest.png",
          "/obs.png",
        ]);
      }));
  });
}
