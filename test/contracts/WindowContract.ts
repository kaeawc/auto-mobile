import { describe, expect, test } from "bun:test";
import type { Window } from "../../src/features/observe/interfaces/Window";

/** What the contract drives: a Window plus a way to change what the "device" shows. */
export interface WindowContractHarness {
  window: Window;
  /** Make the next fresh read report window `which`. */
  show(which: "primary" | "secondary"): void;
}

/** Identity the fresh read must report for each window (the harness's fixtures). */
export interface WindowContractExpectations {
  primary: { appId: string; activityName: string };
  secondary: { appId: string; activityName: string };
}

/**
 * Shared behavioural contract for the observe {@link Window} (#11868): the fake and the real
 * adb-backed window run the same scenarios. The real side reads captured `dumpsys window windows`
 * output through an injected executor with the disk cache disabled.
 */
export function runWindowContract(
  name: string,
  make: () => WindowContractHarness,
  expected: WindowContractExpectations,
): void {
  describe(`Window contract: ${name}`, () => {
    test("nothing is cached before the first read", async () => {
      const { window } = make();
      expect(await window.getCachedActiveWindow()).toBeNull();
    });

    test("a first uncached read reports the shown window and caches it", async () => {
      const { window, show } = make();
      show("primary");
      const active = await window.getActive();
      expect(active).toMatchObject(expected.primary);
      expect(await window.getCachedActiveWindow()).toEqual(active);
    });

    test("a cached read does not see a window change until refreshed", async () => {
      const { window, show } = make();
      show("primary");
      await window.getActive();
      show("secondary");
      expect(await window.getActive()).toMatchObject(expected.primary);
      expect(await window.getActive(true)).toMatchObject(expected.secondary);
    });

    test("a forced refresh replaces the cached window", async () => {
      const { window, show } = make();
      show("primary");
      await window.getActive();
      show("secondary");
      await window.getActive(true);
      expect(await window.getCachedActiveWindow()).toMatchObject(expected.secondary);
    });

    test("a refresh with cacheResult false reports the window but leaves the cache alone", async () => {
      const { window, show } = make();
      show("primary");
      await window.getActive();
      show("secondary");
      expect(await window.getActive(true, undefined, { cacheResult: false })).toMatchObject(
        expected.secondary,
      );
      expect(await window.getCachedActiveWindow()).toMatchObject(expected.primary);
    });

    test("setCachedActiveWindow serves later cached reads and clearCache drops it", async () => {
      const { window, show } = make();
      show("secondary");
      const injected = {
        appId: "injected.app",
        activityName: "injected.Activity",
        layoutSeqSum: 7,
      };
      await window.setCachedActiveWindow(injected);
      expect(await window.getCachedActiveWindow()).toEqual(injected);
      expect(await window.getActive()).toEqual(injected);
      await window.clearCache();
      expect(await window.getCachedActiveWindow()).toBeNull();
      expect(await window.getActive()).toMatchObject(expected.secondary);
    });

    test("the activity hash is stable for one window and differs between windows", async () => {
      const { window, show } = make();
      show("primary");
      const first = await window.getActiveHash();
      expect(first.length).toBeGreaterThan(0);
      expect(await window.getActiveHash()).toBe(first);
      show("secondary");
      expect(await window.getActiveHash()).not.toBe(first);
    });

    test("the activity hash always refreshes past a stale cache", async () => {
      const { window, show } = make();
      show("primary");
      const primaryHash = await window.getActiveHash();
      await window.setCachedActiveWindow({
        appId: "stale",
        activityName: "Stale",
        layoutSeqSum: 0,
      });
      expect(await window.getActiveHash()).toBe(primaryHash);
      expect(await window.getCachedActiveWindow()).toMatchObject(expected.primary);
    });
  });
}
