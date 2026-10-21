import { mock, afterEach, beforeAll, describe, expect, spyOn, test } from "bun:test";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import * as util from "node:util";
import { DefaultObserveElementCollector } from "../../../../src/features/observe/ObserveElementCollector";
import { FileSystemObserveCacheStore } from "../../../../src/features/observe/cache/FileSystemObserveCacheStore";
import { sanitizeObserveResult } from "../../../../src/features/observe/output/ObserveResultOutput";
import { parseObserveResultJson } from "../../../../src/features/observe/output/observeResultWire";
import type { ObserveResult } from "../../../../src/models/ObserveResult";
import { FakeTimer } from "../../../fakes/FakeTimer";
import { useScratchRoot } from "../../../helpers/scratchRoot";
import { createObserveResultForTest } from "../flatHierarchyBuilders";
import {
  capturedFloatingCoverHierarchy,
  observationOf,
} from "../../../helpers/prototypeWindowCapture";

afterEach(() => {
  mock.restore();
});

const config = { dropElements: true, compact: true, project: "skeleton" } as const;
const captures = [
  [
    "android-focus/playground-text-field-post-tap.json",
    "android",
    "15b23aa6e14b3622b4439c8c0f9cdb113deb7a66d63163b9eab5ae64d23eb74d",
  ],
  [
    "android-overlay-window/app-layer-overlay-over-playground.raw.json",
    "android",
    "a8c9506889f2b398a10c94dbc051c532915eba32dde3cbc6d8efcdc8a3cb6917",
  ],
  [
    "ios/nested-selection/cart-a-item-44-quantity-focused.json",
    "ios",
    "367b29173478559b5dec0e601a292fa49ef9570166b4bb5cadc0cbac7bd0b060",
  ],
  [
    "observe-output/ios-keyboard-states/ios-keyboard-visible.raw.json",
    "ios",
    "890c25ec9e4cea31c04d2cae7d212722701c046c46a1a0db0e06d249637616a1",
  ],
  [
    "android-settings/open-by-default-radio-rows.observe.json",
    "android",
    "3abdeaa0b3d606ecd045a153d168c881f9008d7a77166746c341f521ec0fad86",
  ],
  [
    "observe/diff/text-input-typed.json",
    "android",
    "70ba6cde7e3f8fc125efdb0fe7dd9a5ccf74213f657f429ab758b5ce3341fe18",
  ],
  [
    "observe/diff/scroll-after.json",
    "android",
    "9cc4cbd7a1f1f0697623494a6d6f0642cb58d182de418f5efe1f138e89dd6229",
  ],
  [
    "observe/android-home.json",
    "android",
    "a8b0503bf352a1ed5fd65393fec3912de16f53b1b484aafdb446d2097eba295c",
  ],
  [
    "observe-output/ios-overlay-window/ios-floating-overlay-over-settings.raw.json",
    "ios",
    "8a391258a54cc1b03642addb8228f8c5f3d4dcbf787180a5299e490fbf522231",
  ],
  [
    "ios/nested-selection/scroll-cart-duplicate-container-id.json",
    "ios",
    "7e66eaaf295e508a0b0102a5d5155e9c0f7c5ba8e17c28ee961ba58564d0649f",
  ],
] as const;

describe("cached skeleton projection validation", () => {
  const scratch = useScratchRoot("skeleton-projection-cache-");
  const projectedBytes = new Map<
    string,
    {
      fresh: string;
      structuredClone: string;
      "JSON clone": string;
      cacheFirst: string;
      cacheNext: string;
    }
  >();
  const smallCapture = createObserveResultForTest({
    viewHierarchy: {
      hierarchy: {
        node: {
          class: "android.widget.Button",
          text: "Original",
          "resource-id": "button",
          clickable: true,
          bounds: { left: 0, top: 0, right: 100, bottom: 100 },
        },
      },
    },
  });
  const cacheReads: ObserveResult[][] = [];
  const fullProjectionBytes: string[] = [];
  let collectorSpy: ReturnType<typeof spyOn<DefaultObserveElementCollector, "collect">> | undefined;
  let compareSpy: ReturnType<typeof spyOn<typeof util, "isDeepStrictEqual">> | undefined;

  beforeAll(async () => {
    for (const [file, platform] of captures) {
      const observation = parseObserveResultJson(readFileSync(`test/fixtures/${file}`, "utf8"));
      delete observation.rawViewHierarchy;
      if (!observation.viewHierarchy) {
        throw new Error(`Missing hierarchy: ${file}`);
      }
      observation.elements = new DefaultObserveElementCollector().collect(
        observation.viewHierarchy,
        platform,
      );
      const store = new FileSystemObserveCacheStore(
        new FakeTimer(),
        scratch.next(),
        async () => {},
      );
      await store.put("device", observation);
      // Materialize captured-fixture projections once; assertions and the narrow
      // counting tests stay inside the per-test 100 ms budget on loaded runners.
      projectedBytes.set(file, {
        fresh: JSON.stringify(sanitizeObserveResult(observation, config)),
        cacheFirst: JSON.stringify(
          sanitizeObserveResult(store.getRecentInMemoryForDevice("device")!, config),
        ),
        cacheNext: JSON.stringify(
          sanitizeObserveResult(store.getRecentInMemoryForDevice("device")!, config),
        ),
        structuredClone: JSON.stringify(
          sanitizeObserveResult(structuredClone(observation), config),
        ),
        "JSON clone": JSON.stringify(
          sanitizeObserveResult(parseObserveResultJson(JSON.stringify(observation)), config),
        ),
      });
    }
    const covered = {
      ...observationOf(capturedFloatingCoverHierarchy()),
      screenSize: { width: 1080, height: 2400 },
    };
    const store = new FileSystemObserveCacheStore(new FakeTimer(), scratch.next(), async () => {});
    await store.put("device", covered);
    const fullConfig = { dropElements: false, compact: true, project: "full" } as const;
    const firstCovered = store.getRecentInMemoryForDevice("device")!;
    for (const capture of [covered, firstCovered, store.getRecentInMemoryForDevice("device")!]) {
      fullProjectionBytes.push(JSON.stringify(sanitizeObserveResult(capture, fullConfig)));
    }
    if (!firstCovered.viewHierarchy) {
      throw new Error("Missing covered hierarchy");
    }
    firstCovered.viewHierarchy.hierarchy = {};
    delete firstCovered.viewHierarchy.windows;
    fullProjectionBytes.push(
      JSON.stringify(
        sanitizeObserveResult(store.getRecentInMemoryForDevice("device")!, fullConfig),
      ),
    );
    if (!smallCapture.viewHierarchy) {
      throw new Error("Missing small hierarchy");
    }
    smallCapture.elements = new DefaultObserveElementCollector().collect(
      smallCapture.viewHierarchy,
      "android",
    );
    for (let i = 0; i < 2; i++) {
      const store = new FileSystemObserveCacheStore(
        new FakeTimer(),
        scratch.next(),
        async () => {},
      );
      await store.put("device", structuredClone(smallCapture));
      cacheReads.push([
        store.getRecentInMemoryForDevice("device")!,
        store.getRecentInMemoryEntry()!.result,
        (await store.getMostRecent("device"))!,
      ]);
    }
  });

  afterEach(() => {
    collectorSpy?.mockRestore();
    compareSpy?.mockRestore();
  });

  for (const [file, , hash] of captures) {
    for (const kind of [
      "fresh",
      "structuredClone",
      "JSON clone",
      "cacheFirst",
      "cacheNext",
    ] as const) {
      test(`${kind} retains golden skeleton bytes: ${file}`, () => {
        const projected = projectedBytes.get(file);
        if (!projected) {
          throw new Error(`Missing projections: ${file}`);
        }
        const bytes = projected[kind];
        expect(bytes).toBe(projected.fresh);
        expect(createHash("sha256").update(bytes).digest("hex")).toBe(hash);
      });
    }
  }

  test("repeated cache reads preserve full-projection node occlusion bytes", () => {
    expect(fullProjectionBytes[1]).toBe(fullProjectionBytes[0]);
    expect(fullProjectionBytes[2]).toBe(fullProjectionBytes[0]);
    expect(fullProjectionBytes[3]).toBe(fullProjectionBytes[0]);
  });

  test("collects and deep-compares once across production cache reads and return wrappers", () => {
    const expected = JSON.stringify(sanitizeObserveResult(smallCapture, config));
    const [first, second, third] = cacheReads[0];
    collectorSpy = spyOn(DefaultObserveElementCollector.prototype, "collect");
    compareSpy = spyOn(util, "isDeepStrictEqual");
    expect(JSON.stringify(sanitizeObserveResult(first, config))).toBe(expected);
    expect(collectorSpy).toHaveBeenCalledTimes(1);
    expect(compareSpy).toHaveBeenCalledTimes(1);
    expect(second).not.toBe(first);
    for (const cached of [first, { ...second }, { ...third }]) {
      expect(JSON.stringify(sanitizeObserveResult(cached, config))).toBe(expected);
    }
    expect(collectorSpy).toHaveBeenCalledTimes(1);
    expect(compareSpy).toHaveBeenCalledTimes(1);
  });

  test("revalidates changed elements and retains the authoritative mismatch across clones", () => {
    const [cached, next] = cacheReads[1];
    sanitizeObserveResult(cached, config);
    if (!cached.elements) {
      throw new Error("Missing elements");
    }
    cached.elements.clickable = [];
    cached.elements.text = [];
    const expected = sanitizeObserveResult(structuredClone(cached), config);
    collectorSpy = spyOn(DefaultObserveElementCollector.prototype, "collect");
    compareSpy = spyOn(util, "isDeepStrictEqual");
    expect(sanitizeObserveResult(cached, config)).toEqual(expected);
    expect(sanitizeObserveResult(cached, config)).toEqual(expected);
    expect(collectorSpy).toHaveBeenCalledTimes(1);
    expect(compareSpy).toHaveBeenCalledTimes(1);
    // A sibling's mutation must not contaminate the stored entry's next read.
    expect(sanitizeObserveResult(next, config)).toEqual(
      sanitizeObserveResult(smallCapture, config),
    );
    expect(collectorSpy).toHaveBeenCalledTimes(2);
  });

  test("revalidates in-place hierarchy changes even when the elements reference is unchanged", () => {
    const cached = structuredClone(smallCapture);
    sanitizeObserveResult(cached, config);
    if (!cached.viewHierarchy) {
      throw new Error("Missing hierarchy");
    }
    cached.viewHierarchy.hierarchy = {};
    delete cached.viewHierarchy.windows;
    const expected = sanitizeObserveResult(structuredClone(cached), config);
    collectorSpy = spyOn(DefaultObserveElementCollector.prototype, "collect");
    compareSpy = spyOn(util, "isDeepStrictEqual");
    expect(sanitizeObserveResult(cached, config)).toEqual(expected);
    expect(sanitizeObserveResult(cached, config)).toEqual(expected);
    expect(collectorSpy).toHaveBeenCalledTimes(1);
    expect(compareSpy).toHaveBeenCalledTimes(1);
  });

  test("non-cloneable hierarchy metadata retains the uncached legacy behavior", () => {
    const cached = structuredClone(smallCapture);
    if (!cached.viewHierarchy) {
      throw new Error("Missing hierarchy");
    }
    const hierarchy = { ...cached.viewHierarchy, callback: () => undefined };
    cached.viewHierarchy = hierarchy;
    const expected = sanitizeObserveResult(smallCapture, config);
    collectorSpy = spyOn(DefaultObserveElementCollector.prototype, "collect");
    expect(sanitizeObserveResult(cached, config)).toEqual(expected);
    expect(sanitizeObserveResult(cached, config)).toEqual(expected);
    expect(collectorSpy).toHaveBeenCalledTimes(2);
  });

  test("a failed collection is not cached or swallowed", () => {
    const cached = structuredClone(smallCapture);
    collectorSpy = spyOn(DefaultObserveElementCollector.prototype, "collect");
    collectorSpy.mockImplementationOnce(() => {
      throw new Error("collector failed");
    });
    expect(() => sanitizeObserveResult(cached, config)).toThrow("collector failed");
    expect(sanitizeObserveResult(cached, config)).toEqual(
      sanitizeObserveResult(smallCapture, config),
    );
    expect(collectorSpy).toHaveBeenCalledTimes(2);
  });
});
