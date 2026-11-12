import { observedAndroidXr } from "../../../../src/features/xr/xrPanelSpace";
import { createFlatNodeForTest } from "../../observe/flatHierarchyBuilders";
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
import type { BackStackInfo, ObserveResult, SwipeOnResult } from "../../../../src/models";
import { xrBackStack } from "../../../helpers/xrHeadset";

const VIEWPORT = 1800;
const PITCH = 300;
// From the end (offset 24), each half-screen reverse sweep moves three rows: eight swipes reach the top.
const MOVED_BACK = 8;
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
  backStackAfterFirstSwipe,
  initialOffset = 0,
  pauseSwipes = [],
  staleSwipes = [],
}: {
  overshoot?: boolean;
  stuckRecovery?: boolean;
  platform?: "android" | "ios";
  backStackAfterFirstSwipe?: BackStackInfo;
  initialOffset?: number;
  pauseSwipes?: number[];
  staleSwipes?: number[];
} = {}) {
  const timer = new FakeTimer();
  timer.enableAutoAdvance();
  let offset = initialOffset;
  const steps: Step[] = [];
  const observe = (): ObserveResult => ({
    updatedAt: timer.now(),
    observationId: "test-observation",
    freshness: { isFresh: !staleSwipes.includes(steps.length) },
    display: { key: "default", role: "unknown", posture: "unknown", generation: 0 },
    systemInsets: { top: 0, bottom: 0, left: 0, right: 0 },
    screenSize: { width: 1080, height: 2400 },
    ...(steps.length > 0 && backStackAfterFirstSwipe
      ? { backStack: backStackAfterFirstSwipe }
      : {}),
    viewHierarchy: {
      hierarchy: {
        node: createFlatNodeForTest({
          bounds: { left: 0, top: 0, right: 1080, bottom: 2400 },
          node: [
            createFlatNodeForTest({
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
            }),
          ],
        }),
      },
    },
  });
  const observation = new FakeObserveScreen();
  observation.setObserveResult(observe);
  const geometry = new DefaultElementGeometry();
  const scroll = new ScrollUntilVisible({
    // No device handle: the shared predicate decides from the back stack.
    androidXr: observedAndroidXr(() => ({ device: { deviceId: "fake-list", platform } })),
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
    if (!(stuckRecovery && steps.length > 1) && !pauseSwipes.includes(steps.length)) {
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
  expect(await h.search("row 11")).toMatchObject({
    found: true,
    movedSwipes: 2,
    element: { text: "row 11" },
  });
});

test("a search already past its target stalls at the end, then finds it in the reverse sweep", async () => {
  const h = listHarness({ initialOffset: 24 });
  const result = await h.search("row 12");
  expect(result).toMatchObject({ success: true, found: true, element: { text: "row 12" } });
  expect(result.reachedEnd).toBeUndefined();
  // Two unchanged forward swipes establish the end before the sweep turns back.
  expect(h.steps.slice(0, 2).every((step) => step.y2 < step.y1)).toBe(true);
  expect(h.steps.slice(2).every((step) => step.y2 > step.y1)).toBe(true);
  expect(h.steps.length).toBeGreaterThan(2);
  expect(h.timer.getSleepHistory()).toEqual([]);
});

test("a target missing in both directions reports reachedEnd after both sweeps", async () => {
  const h = listHarness({ initialOffset: 24 });
  const result = await h.search("Item 12");
  expect(result).toMatchObject({
    success: false,
    found: false,
    reachedEnd: true,
    movedSwipes: MOVED_BACK,
    scrollIterations: 4 + MOVED_BACK,
    error: `Scroll reached end of container in both directions (up and down; no change after 2 consecutive swipes each way). text "Item 12" not found. ${MOVED_BACK} swipes moved the screen. The item may be absent from this container, or the swipe direction may be wrong.`,
  });
  expect(h.steps.slice(0, 2).every((step) => step.y2 < step.y1)).toBe(true);
  expect(h.steps.slice(2).every((step) => step.y2 > step.y1)).toBe(true);
  expect(h.timer.getSleepHistory()).toEqual([]);
});

test("a miss after forward movement bounds the reverse sweep by the forward swipes", async () => {
  // Two moving forward swipes reach the end from offset 18; the reverse sweep may take
  // 2 x 2 + 2 half-screen swipes, which returns past the start without reaching the top.
  const h = listHarness({ initialOffset: 18 });
  const result = await h.search("absent");
  expect(result).toMatchObject({
    success: false,
    found: false,
    reachedEnd: true,
    movedSwipes: 2 + 6,
    scrollIterations: 2 + 2 + 6,
  });
  expect(result.error).toContain(
    "the down sweep then covered the searched range back past the start (6 swipes)",
  );
  expect(result.error).toContain(
    "may be absent from this container, or the swipe direction may be wrong",
  );
  expect(h.steps.slice(4).every((step) => step.y2 > step.y1)).toBe(true);
  expect(h.timer.getSleepHistory()).toEqual([]);
});

test("a target behind a forward-moving start is still found within the reverse budget", async () => {
  const h = listHarness({ initialOffset: 18 });
  expect(await h.search("row 12")).toMatchObject({
    success: true,
    found: true,
    element: { text: "row 12" },
  });
  expect(h.steps.length).toBeLessThanOrEqual(2 + 2 + 6);
});

test("a reverse sweep the time budget cannot cover ends with reachedEnd before maxTime", async () => {
  const maxTime = 6000;
  const h = listHarness({ initialOffset: 24 });
  const result = await h.search("absent", { lookFor: { text: "absent", maxTime } });
  expect(result).toMatchObject({ success: false, found: false, reachedEnd: true });
  expect(result.error).toContain(
    `because the ${maxTime}ms search time budget could not cover another swipe`,
  );
  expect(result.error).toContain("the swipe direction may be wrong");
  expect(h.timer.now()).toBeLessThanOrEqual(maxTime);
  expect(result.scrollIterations).toBeLessThan(2 + MOVED_BACK + 2);
  expect(h.timer.getSleepHistory()).toEqual([]);
});

test("end detection counts only swipes that changed the settled screen", async () => {
  const h = listHarness();
  const result = await h.search("absent");
  expect(result).toMatchObject({
    success: false,
    reachedEnd: true,
    // Six forward swipes reach the end and two unchanged ones confirm it; the reverse
    // sweep then moves back to the top and two more unchanged swipes confirm that end.
    movedSwipes: 6 + MOVED_BACK,
    scrollIterations: 8 + MOVED_BACK + 2,
  });
  expect(h.steps).toHaveLength(8 + MOVED_BACK + 2);
  expect(h.timer.now()).toBe(12600);
  expect(h.timer.getSleepHistory()).toEqual([]);
});

test.each([1, 3])(
  "a list at its end turns back after the configured threshold of %i swipes",
  async (maxUnchangedSwipes) => {
    const h = listHarness({ initialOffset: 24 });
    expect(
      await h.search("absent", { lookFor: { text: "absent", maxUnchangedSwipes } }),
    ).toMatchObject({
      success: false,
      reachedEnd: true,
      movedSwipes: MOVED_BACK,
      scrollIterations: 2 * maxUnchangedSwipes + MOVED_BACK,
    });
    expect(h.steps.slice(0, maxUnchangedSwipes).every((step) => step.y2 < step.y1)).toBe(true);
    expect(h.steps.slice(maxUnchangedSwipes).every((step) => step.y2 > step.y1)).toBe(true);
    expect(h.timer.getSleepHistory()).toEqual([]);
  },
);

test("an isolated unchanged swipe and later changing content still reach the target", async () => {
  const h = listHarness({ pauseSwipes: [1, 3] });
  expect(await h.search("row 15")).toMatchObject({
    success: true,
    found: true,
    scrollIterations: 5,
  });
  expect(h.steps.every((step) => step.y2 < step.y1)).toBe(true);
  expect(h.timer.getSleepHistory()).toEqual([]);
});

test("the consecutive-no-change threshold is configurable for slower content", async () => {
  const h = listHarness({ pauseSwipes: [1, 2] });
  expect(
    await h.search("row 11", { lookFor: { text: "row 11", maxUnchangedSwipes: 3 } }),
  ).toMatchObject({
    success: true,
    found: true,
    scrollIterations: 4,
  });
  expect(h.steps.every((step) => step.y2 < step.y1)).toBe(true);
  expect(h.timer.getSleepHistory()).toEqual([]);
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

test.each([true, false])(
  "overlap recovery counts only the forward swipe's movement (fresh=%s)",
  async (fresh) => {
    const h = listHarness({ overshoot: true, staleSwipes: fresh ? [] : [1] });
    expect(await h.search("row 11")).toMatchObject({
      found: true,
      scrollIterations: 1,
      movedSwipes: fresh ? 1 : 0,
      element: { text: "row 11" },
    });
    const backwards = h.steps.filter((step) => step.y2 > step.y1);
    expect(backwards.length).toBeGreaterThan(0);
    expect(backwards.length).toBeLessThanOrEqual(3);
    expect(h.steps[1].y2).toBeGreaterThan(h.steps[1].y1);
    for (const step of backwards) {
      expect(Math.abs(step.y2 - step.y1)).toBe(VIEWPORT / 2);
    }
  },
);

test("overlap recovery refuses its back-scroll when the post-swipe XR pose is invalid", async () => {
  const backStack = xrBackStack("swipe-up");
  const settings = backStack.tasks.find((task) => task.id === 6)!;
  backStack.tasks.push({ ...settings, id: 7, packageName: "com.example.second" });
  const h = listHarness({ overshoot: true, backStackAfterFirstSwipe: backStack });
  await expect(h.search("row 11")).rejects.toThrow("2 app panels are open");
  // Only the forward swipe ran: the overshoot's recovery back-scroll was refused before input.
  expect(h.steps).toHaveLength(1);
  expect(h.steps[0].y2).toBeLessThan(h.steps[0].y1);
});

test("unrecoverable zero overlap falls back to the normal end-of-list detector", async () => {
  const h = listHarness({ overshoot: true, stuckRecovery: true });
  expect(await h.search("row 11")).toMatchObject({ success: false, reachedEnd: true });
  expect(h.steps.filter((step) => step.y2 < step.y1)).toHaveLength(3);
  // The stuck list cannot move back either, so the reverse sweep ends after two unchanged swipes.
  expect(h.steps).toHaveLength(8);
});

test("an absent target reports reachedEnd only after the reverse sweep", async () => {
  const h = listHarness();
  expect(await h.search("absent")).toMatchObject({ success: false, reachedEnd: true });
  expect(h.steps.length).toBeLessThan(40);
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
    updatedAt: timer.now(),
    observationId: "test-observation",
    display: { key: "default", role: "unknown", posture: "unknown", generation: 0 },
    systemInsets: { top: 0, bottom: 0, left: 0, right: 0 },
    screenSize: { width: 1080, height: 2400 },
    viewHierarchy: {
      hierarchy: {
        node: createFlatNodeForTest({
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
        }),
      },
    },
  });
  const screen = new FakeObserveScreen();
  screen.setObserveResult(observe);
  const scroll = new ScrollUntilVisible({
    androidXr: async () => false,
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
  expect(await h.search()).toMatchObject({ found: true, scrollIterations: 3, movedSwipes: 3 });
  expect(h.backwards).toEqual([false, true, false, false]);
});
