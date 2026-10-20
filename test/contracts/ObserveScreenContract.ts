import { buildObserveResult } from "../helpers/observeFixture";
import { describe, expect, test } from "bun:test";
import type { ObserveResult } from "../../src/models";
import type {
  ObserveScreen,
  ObserveScreenExecuteOptions,
} from "../../src/features/observe/interfaces/ObserveScreen";

export interface ObserveScreenHandle {
  screen: ObserveScreen & Required<Pick<ObserveScreen, "cacheObserveResult">>;
  /** Make the NEXT observation carry `marker` as its updatedAt; geometry never changes, because a
   * geometry change legitimately invalidates the real cache. */
  present(marker: number): void;
  dispose?: () => void;
}

/**
 * Shared behavioural contract for {@link ObserveScreen} (#11868): the scripted FakeObserveScreen
 * and the real class (over FakeViewHierarchy, FakeObserveCacheStore and a FakeTimer) agree on how
 * `execute()` feeds the observe cache that `getMostRecentCachedObserveResult()` reads.
 */
export function runObserveScreenContract(name: string, make: () => ObserveScreenHandle): void {
  describe(`ObserveScreen contract: ${name}`, function () {
    const withScreen = async (
      body: (handle: ObserveScreenHandle) => Promise<void>,
    ): Promise<void> => {
      const handle = make();
      try {
        await body(handle);
      } finally {
        handle.dispose?.();
      }
    };
    const observe = (
      handle: ObserveScreenHandle,
      marker: number,
      skipCache = false,
      extra: ObserveScreenExecuteOptions = {},
    ) => {
      handle.present(marker);
      return handle.screen.execute({
        skipScreenshot: true,
        skipBackStack: true,
        skipCache,
        ...extra,
      });
    };

    test("execute reports the screen it observed", async function () {
      await withScreen(async (handle) => {
        const result = await observe(handle, 1080);

        expect(result.screenSize).toMatchObject({ width: 1080, height: 1920 });
        expect(result.updatedAt).toBe(1080);
      });
    });

    test("an empty cache answers with an error result instead of throwing", async function () {
      await withScreen(async ({ screen }) => {
        const result = await screen.getMostRecentCachedObserveResult();

        expect(result.error).toContain("No cached observe result");
        expect(result.viewHierarchy).toBeUndefined();
      });
    });

    test("a cache read replays the latest execute", async function () {
      await withScreen(async (handle) => {
        await observe(handle, 1000);
        await observe(handle, 1100);

        const cached = await handle.screen.getMostRecentCachedObserveResult();

        expect(cached.updatedAt).toBe(1100);
      });
    });

    test("a cache read is not an observation", async function () {
      await withScreen(async (handle) => {
        await observe(handle, 1000);
        handle.present(2000);

        const first = await handle.screen.getMostRecentCachedObserveResult();
        const second = await handle.screen.getMostRecentCachedObserveResult();

        expect(first.updatedAt).toBe(1000);
        expect(second.updatedAt).toBe(1000);
      });
    });

    test("skipCache leaves the previous cached observation in place", async function () {
      await withScreen(async (handle) => {
        await observe(handle, 1000);
        const intermediate = await observe(handle, 1500, true);

        const cached = await handle.screen.getMostRecentCachedObserveResult();

        expect(intermediate.updatedAt).toBe(1500);
        expect(cached.updatedAt).toBe(1000);
      });
    });

    const nonCachingModes: Array<[string, ObserveScreenExecuteOptions]> = [
      ["observerMode", { observerMode: true }],
      ["skipRecompositionTracking", { skipRecompositionTracking: true }],
      ["hierarchyOnly", { hierarchyOnly: true }],
    ];
    for (const [label, extra] of nonCachingModes) {
      test(`${label} leaves the previous cached observation in place`, async function () {
        await withScreen(async (handle) => {
          await observe(handle, 1000);
          await observe(handle, 1500, false, extra);

          const cached = await handle.screen.getMostRecentCachedObserveResult();

          expect(cached.updatedAt).toBe(1000);
        });
      });
    }

    test("cacheObserveResult replaces what a cache read returns", async function () {
      await withScreen(async (handle) => {
        await observe(handle, 1000);
        const selected = await observe(handle, 1500, true);

        await handle.screen.cacheObserveResult(selected);
        const cached = await handle.screen.getMostRecentCachedObserveResult();

        expect(cached.updatedAt).toBe(1500);
      });
    });

    test("appendRawViewHierarchy attaches nothing when the primary hierarchy is absent", async function () {
      await withScreen(async ({ screen }) => {
        const result: ObserveResult = buildObserveResult({
          updatedAt: new Date(0).toISOString(),
          screenSize: { width: 0, height: 0 },
          systemInsets: { top: 0, right: 0, bottom: 0, left: 0 },
        });

        await screen.appendRawViewHierarchy(result);

        expect(result.rawViewHierarchy).toBeUndefined();
      });
    });
  });
}
