import { afterEach, describe, expect, test } from "bun:test";
import { RealObserveScreen } from "../../../src/features/observe/ObserveScreen";
import { FakeAdbExecutor } from "../../fakes/FakeAdbExecutor";
import { FakeAdbClientFactory } from "../../fakes/FakeAdbClientFactory";
import { FakeTimer } from "../../fakes/FakeTimer";
import { FakeObserveCacheStore } from "../../fakes/FakeObserveCacheStore";
import { resetObserveCacheStore } from "../../../src/features/observe/cache/ObserveCacheRegistry";
import type { BootedDevice, ObserveResult } from "../../../src/models";

/**
 * Regression coverage for cross-platform contamination: ObserveScreen.execute()
 * must reject a hierarchy that belongs to the other platform AT THE SOURCE, so
 * that neither the returned result nor the shared observe cache (read by the
 * LATEST_OBSERVATION resource and the navigation-graph recorder) ever exposes
 * the other platform's data.
 */
describe("ObserveScreen.execute cross-platform hierarchy rejection", () => {
  afterEach(() => resetObserveCacheStore());

  const androidDevice: BootedDevice = {
    deviceId: "android-device",
    name: "Android Device",
    platform: "android",
  };

  // A fake collector that returns an iOS hierarchy (screenScale set, UIWindow
  // root) along with the fields execute() derives from it — simulating a stale
  // connection that hands an Android device the other platform's data.
  const iosHierarchyCollector = () => ({
    collect: async (result: ObserveResult) => {
      result.viewHierarchy = {
        hierarchy: {
          node: {
            $: { class: "UIWindow", bounds: { left: 0, top: 0, right: 390, bottom: 844 } },
            node: [
              {
                $: {
                  class: "UIButton",
                  text: "Continue",
                  bounds: { left: 0, top: 0, right: 200, bottom: 80 },
                },
              },
            ],
          },
        },
        screenScale: 3.0,
        screenWidth: 390,
        screenHeight: 844,
        wakefulness: "Awake",
        packageName: "com.apple.springboard",
      } as unknown as ObserveResult["viewHierarchy"];
      result.focusedElement = { text: "Stale iOS field" } as never;
      result.intentChooserDetected = true;
    },
    collectRaw: async () => undefined,
    extractScreenSize: () => null,
  });

  const buildScreen = (cacheStore: FakeObserveCacheStore) =>
    new RealObserveScreen(androidDevice, new FakeAdbClientFactory(new FakeAdbExecutor()), {
      hierarchyCollector: iosHierarchyCollector() as never,
      cacheStore,
      performanceAuditor: { run: async () => undefined } as never,
      accessibilityAuditor: { run: async () => undefined } as never,
      accessibilityStateDetector: { run: async () => undefined } as never,
    });

  test("discards the hierarchy and every derived field from the result", async () => {
    const screen = buildScreen(new FakeObserveCacheStore(new FakeTimer()));

    const result = await screen.execute({ skipScreenshot: true, skipBackStack: true });

    expect(result.viewHierarchy).toBeUndefined();
    expect(result.elements).toBeUndefined();
    expect(result.focusedElement).toBeUndefined();
    expect(result.intentChooserDetected).toBeUndefined();
    // The iOS package must not leak through activeWindow.
    expect(result.activeWindow).toBeUndefined();
    // The iOS logical screen size (390x844) must not survive to mislead tap scaling.
    expect(result.screenSize).toEqual({ width: 0, height: 0 });
    expect(result.error).toContain("iOS hierarchy for Android device");
  });

  test("never writes contaminated data to the shared observe cache", async () => {
    const cacheStore = new FakeObserveCacheStore(new FakeTimer());
    const screen = buildScreen(cacheStore);

    await screen.execute({ skipScreenshot: true, skipBackStack: true });

    // The LATEST_OBSERVATION resource and navigation graph read this cache.
    const cached = await cacheStore.getMostRecent("android-device");
    expect(cached).toBeDefined();
    expect(cached?.viewHierarchy).toBeUndefined();
    expect(cached?.elements).toBeUndefined();
    expect(cached?.focusedElement).toBeUndefined();
    expect(cached?.activeWindow).toBeUndefined();
  });

  test("raw-mode append is skipped when the primary hierarchy was rejected", async () => {
    let collectRawCalled = false;
    const screen = new RealObserveScreen(
      androidDevice,
      new FakeAdbClientFactory(new FakeAdbExecutor()),
      {
        hierarchyCollector: {
          ...iosHierarchyCollector(),
          collectRaw: async (result: ObserveResult) => {
            collectRawCalled = true;
            result.rawViewHierarchy = {
              json: "stale-ios-raw",
              source: "accessibility-service",
            } as never;
          },
        } as never,
        cacheStore: new FakeObserveCacheStore(new FakeTimer()),
        performanceAuditor: { run: async () => undefined } as never,
        accessibilityAuditor: { run: async () => undefined } as never,
        accessibilityStateDetector: { run: async () => undefined } as never,
      },
    );

    const result = await screen.execute({ skipScreenshot: true, skipBackStack: true });
    // Mirrors the observe handler's `if (args.raw)` path.
    await screen.appendRawViewHierarchy(result);

    // The scrubbed primary hierarchy must prevent the unfiltered raw companion
    // from re-fetching and re-attaching the other platform's data.
    expect(collectRawCalled).toBe(false);
    expect(result.rawViewHierarchy).toBeUndefined();
  });
});
