import { expect, test } from "bun:test";
import { ScrollUntilVisible } from "../../../../src/features/action/swipeon/ScrollUntilVisible";
import { DefaultElementGeometry } from "../../../../src/features/utility/ElementGeometry";
import { FakeTimer } from "../../../fakes/FakeTimer";
import { FakeAdbExecutor } from "../../../fakes/FakeAdbExecutor";
import { FakeObserveScreen } from "../../../fakes/FakeObserveScreen";
import { FakeAccessibilityDetector } from "../../../fakes/FakeAccessibilityDetector";
import { FakeScrollAccessibilityService } from "../../../fakes/FakeScrollAccessibilityService";
import { FakeOverlayDetector } from "../../../fakes/FakeOverlayDetector";
import { FakeTalkBackSwipeExecutor } from "../../../fakes/FakeTalkBackSwipeExecutor";
import type { ObserveResult, SwipeOnResult } from "../../../../src/models";

const VIEWPORT = 1800;
const PITCH = 300;
interface Step {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  duration: number;
  holdDurationMs?: number;
}

function listHarness({
  overshoot = false,
  stuckRecovery = false,
  platform = "android",
}: { overshoot?: boolean; stuckRecovery?: boolean; platform?: "android" | "ios" } = {}) {
  const timer = new FakeTimer();
  timer.enableAutoAdvance();
  let offset = 0;
  const steps: Step[] = [];
  const observe = (): ObserveResult => ({
    timestamp: timer.now(),
    screenSize: { width: 1080, height: 2400 },
    viewHierarchy: {
      hierarchy: {
        node: {
          bounds: { left: 0, top: 0, right: 1080, bottom: 2400 },
          node: {
            "resource-id": "list",
            scrollable: true,
            bounds: { left: 0, top: 300, right: 1080, bottom: 2100 },
            node: Array.from({ length: 6 }, (_, index) => ({
              text: `row ${offset + index + 1}`,
              "resource-id": "row",
              bounds: {
                left: 0,
                top: 300 + index * PITCH,
                right: 1080,
                bottom: 300 + (index + 1) * PITCH,
              },
            })),
          },
        },
      },
    },
  });
  const observation = new FakeObserveScreen();
  observation.setObserveResult(observe);
  const geometry = new DefaultElementGeometry();
  const scroll = new ScrollUntilVisible({
    device: { name: "fake", platform, deviceId: "fake-list" },
    geometry,
    timer,
    adb: new FakeAdbExecutor(),
    observeScreen: observation,
    accessibilityDetector: new FakeAccessibilityDetector(),
    accessibilityService: new FakeScrollAccessibilityService(),
    overlayDetector: new FakeOverlayDetector(),
    talkBackExecutor: new FakeTalkBackSwipeExecutor(),
    getDuration: (options) => options.duration ?? geometry.getSwipeDurationFromSpeed(options.speed),
    resolveBoomerangConfig: () => undefined,
    buildPredictionArgs: () => ({}),
    observedInteraction: async (action) => ({
      ...(await action(observe())),
      observation: observe(),
    }),
  });
  const swipe = async (step: Step): Promise<SwipeOnResult & { observation: ObserveResult }> => {
    steps.push(step);
    const distance = Math.abs(step.y2 - step.y1);
    const fastRelease =
      platform === "android" && (step.holdDurationMs ?? 0) < 100 && distance / step.duration > 0.05;
    const rows =
      (overshoot && steps.length === 1) || fastRelease
        ? 12
        : Math.max(1, Math.floor(distance / PITCH));
    const delta = step.y2 < step.y1 ? rows : -rows;
    if (!(stuckRecovery && steps.length > 1)) {
      offset = Math.max(0, Math.min(24, offset + delta));
    }
    timer.advanceTime(step.duration + (step.holdDurationMs ?? 0));
    return { ...step, success: true, targetType: "screen", observation: observe() };
  };
  const search = (text: string, extra = {}) =>
    scroll.executeWithStrategy({
      options: { direction: "up", lookFor: { text }, ...extra },
      strategy: { observe: async () => observe(), swipe },
    });
  return { search, steps, timer };
}

test("lookFor row 11 is found without a fling", async () => {
  const h = listHarness();
  expect(await h.search("row 11")).toMatchObject({ found: true, element: { text: "row 11" } });
});

test("maxSwipes stops the search after that many swipes", async () => {
  const h = listHarness();
  await expect(h.search("row 25", { lookFor: { text: "row 25", maxSwipes: 2 } })).rejects.toThrow(
    'text "row 25" not found',
  );
  expect(h.steps).toHaveLength(2);
});

test("maxSwipes still finds a target that needs no more swipes than the cap", async () => {
  const h = listHarness();
  expect(await h.search("row 11", { lookFor: { text: "row 11", maxSwipes: 8 } })).toMatchObject({
    found: true,
    element: { text: "row 11" },
  });
  expect(h.steps.length).toBeLessThanOrEqual(8);
});

test("every search step leaves at least a quarter viewport and holds before release", async () => {
  const h = listHarness();
  await h.search("row 25", { duration: 1, speed: "fast" });
  expect(h.steps.length).toBeGreaterThan(0);
  for (const step of h.steps) {
    expect(Math.abs(step.y2 - step.y1)).toBeLessThanOrEqual(VIEWPORT * 0.75);
    expect(step.duration).toBeGreaterThanOrEqual(600);
    expect(step.holdDurationMs).toBe(100);
  }
});

test("a two-viewport overshoot back-scrolls partially and still finds row 11", async () => {
  const h = listHarness({ overshoot: true });
  expect(await h.search("row 11")).toMatchObject({ found: true });
  const backwards = h.steps.filter((step) => step.y2 > step.y1);
  expect(backwards.length).toBeGreaterThan(0);
  expect(backwards.length).toBeLessThanOrEqual(3);
  expect(h.steps[1].y2).toBeGreaterThan(h.steps[1].y1);
  for (const step of backwards) {
    expect(Math.abs(step.y2 - step.y1)).toBe(VIEWPORT / 2);
  }
});

test("unrecoverable zero overlap falls back to the normal end-of-list detector", async () => {
  const h = listHarness({ overshoot: true, stuckRecovery: true });
  await expect(h.search("row 11")).rejects.toThrow("Scroll reached end of container");
  expect(h.steps.filter((step) => step.y2 < step.y1)).toHaveLength(2);
  expect(h.steps).toHaveLength(6);
});

test("an absent target retains the two-observation end detector and error shape", async () => {
  const h = listHarness();
  await expect(h.search("absent")).rejects.toThrow(
    'Scroll reached end of container (no change after 1 scrolls). text "absent" not found',
  );
  expect(h.steps.length).toBeLessThan(20);
  expect(h.timer.now()).toBeLessThan(15000);
  const last = h.steps.at(-1)!;
  expect(last.y2).toBeGreaterThan(last.y1);
});

test("iOS skips the Android overlap guard while preserving its gesture parameters", async () => {
  const h = listHarness({ platform: "ios", overshoot: true });
  expect(await h.search("row 25", { duration: 300 })).toMatchObject({ found: true });
  expect(h.steps[0]).toMatchObject({ x1: 540, y1: 1920, x2: 540, y2: 480, duration: 300 });
  expect(h.steps.every((step) => step.holdDurationMs === undefined)).toBe(true);
  expect(h.steps.every((step) => step.y2 < step.y1)).toBe(true);
});

function scriptedPages(pages: string[][], stuckBack = false) {
  const timer = new FakeTimer();
  timer.enableAutoAdvance();
  const geometry = new DefaultElementGeometry();
  let page = 0;
  const backwards: boolean[] = [];
  const observe = (): ObserveResult => ({
    timestamp: timer.now(),
    screenSize: { width: 1080, height: 2400 },
    viewHierarchy: {
      hierarchy: {
        node: {
          "resource-id": "list",
          scrollable: true,
          bounds: { left: 0, top: 300, right: 1080, bottom: 2100 },
          node: pages[page].map((text, index) => ({
            text,
            "resource-id": "row",
            bounds: {
              left: 0,
              top: 300 + index * (VIEWPORT / pages[page].length),
              right: 1080,
              bottom: 300 + (index + 1) * (VIEWPORT / pages[page].length),
            },
          })),
        },
      },
    },
  });
  const screen = new FakeObserveScreen();
  screen.setObserveResult(observe);
  const scroll = new ScrollUntilVisible({
    device: { name: "fake", platform: "android", deviceId: "scripted-list" },
    geometry,
    timer,
    adb: new FakeAdbExecutor(),
    observeScreen: screen,
    accessibilityDetector: new FakeAccessibilityDetector(),
    accessibilityService: new FakeScrollAccessibilityService(),
    overlayDetector: new FakeOverlayDetector(),
    talkBackExecutor: new FakeTalkBackSwipeExecutor(),
    getDuration: (options) => options.duration ?? geometry.getSwipeDurationFromSpeed(options.speed),
    resolveBoomerangConfig: () => undefined,
    buildPredictionArgs: () => ({}),
    observedInteraction: async (action) => ({
      ...(await action(observe())),
      observation: observe(),
    }),
  });
  return {
    backwards,
    search: () =>
      scroll.executeWithStrategy({
        options: { direction: "up", lookFor: { text: "Target" } },
        strategy: {
          observe: async () => observe(),
          swipe: async (step) => {
            const back = step.y2 > step.y1;
            backwards.push(back);
            if (!back || !stuckBack) {
              page = Math.max(0, Math.min(pages.length - 1, page + (back ? -1 : 1)));
            }
            timer.advanceTime(600);
            return { ...step, success: true, targetType: "screen", observation: observe() };
          },
        },
      }),
  };
}

const distinctPage = (prefix: string) => Array.from({ length: 6 }, (_, i) => `${prefix} ${i}`);

test("review: target on zero-overlap drag page is searched before recovery", async () => {
  const h = scriptedPages([distinctPage("first"), [...distinctPage("second"), "Target"]]);
  expect(await h.search()).toMatchObject({ found: true, scrollIterations: 1 });
  expect(h.backwards).toEqual([false]);
});

test("review: forty identical rows reach the unique target without back-scrolls", async () => {
  const pages = Array.from({ length: 9 }, (_, i) => [
    ...Array(Math.min(5, 40 - i * 5)).fill("Identical"),
    `page ${i}`,
    ...(i === 8 ? ["Target"] : []),
  ]);
  const h = scriptedPages(pages);
  expect(await h.search()).toMatchObject({ found: true, scrollIterations: 8 });
  expect(h.backwards).toEqual(Array(8).fill(false));
});

for (const count of [1, 2]) {
  test(`review: ${count} large cards skip overlap recovery`, async () => {
    const h = scriptedPages([
      Array.from({ length: count }, (_, i) => `first ${i}`),
      Array.from({ length: count }, (_, i) => `second ${i}`),
      ["Target"],
    ]);
    expect(await h.search()).toMatchObject({ found: true, scrollIterations: 2 });
    expect(h.backwards).toEqual([false, false]);
  });
}

test("review: unique recycled row duplicated after step still overlaps", async () => {
  const h = scriptedPages([["Buy", "first"], ["Buy", "Buy", "second"], ["Target"]]);
  expect(await h.search()).toMatchObject({ found: true, scrollIterations: 2 });
  expect(h.backwards).toEqual([false, false]);
});

test("review: failed overlap recovery continues forward to target", async () => {
  const h = scriptedPages([distinctPage("first"), distinctPage("second"), ["Target"]], true);
  expect(await h.search()).toMatchObject({ found: true, scrollIterations: 2 });
  expect(h.backwards.filter(Boolean)).toHaveLength(3);
  expect(h.backwards.at(-1)).toBe(false);
});

test("review: guard-restored original page is not end-of-list evidence", async () => {
  const h = scriptedPages([distinctPage("first"), distinctPage("second"), ["Target"]]);
  expect(await h.search()).toMatchObject({ found: true, scrollIterations: 3 });
  expect(h.backwards).toEqual([false, true, false, false]);
});
