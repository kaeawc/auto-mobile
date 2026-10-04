import { describe, expect, test } from "bun:test";
import { ScrollUntilVisible } from "../../../../src/features/action/swipeon/ScrollUntilVisible";
import { DefaultElementGeometry } from "../../../../src/features/utility/ElementGeometry";
import type { ObserveResult, ViewHierarchyResult } from "../../../../src/models";
import { FakeAccessibilityDetector } from "../../../fakes/FakeAccessibilityDetector";
import { FakeAdbExecutor } from "../../../fakes/FakeAdbExecutor";
import { FakeObserveScreen } from "../../../fakes/FakeObserveScreen";
import { FakeOverlayDetector } from "../../../fakes/FakeOverlayDetector";
import { FakeScrollAccessibilityService } from "../../../fakes/FakeScrollAccessibilityService";
import { FakeTalkBackSwipeExecutor } from "../../../fakes/FakeTalkBackSwipeExecutor";
import { FakeTimer } from "../../../fakes/FakeTimer";
import {
  navigationExposureCases,
  coveredNavigationRow,
  partialNavigationRow,
  visibleNavigationRow,
  navigationScreen,
  navigationViewport,
  syntheticNavigationHierarchy,
} from "../../../fixtures/observe/iosNavigationOcclusion";

function harness(hierarchies: ViewHierarchyResult[], platform: "ios" | "android" = "ios") {
  let swipes = 0;
  const observations: ObserveResult[] = hierarchies.map((viewHierarchy) => ({
    observationId: "synthetic-navigation",
    updatedAt: 1,
    screenSize: navigationScreen,
    systemInsets: viewHierarchy.systemInsets,
    viewHierarchy,
  }));
  const current = () => observations[Math.min(swipes, observations.length - 1)];
  const timer = new FakeTimer();
  timer.enableAutoAdvance();
  const observeScreen = new FakeObserveScreen();
  observeScreen.setObserveResult(current);
  const scroll = new ScrollUntilVisible({
    device: { name: "synthetic", deviceId: "synthetic", platform },
    geometry: new DefaultElementGeometry(),
    observeScreen,
    accessibilityService: new FakeScrollAccessibilityService(),
    accessibilityDetector: new FakeAccessibilityDetector(),
    adb: new FakeAdbExecutor(),
    overlayDetector: new FakeOverlayDetector(),
    talkBackExecutor: new FakeTalkBackSwipeExecutor(),
    timer,
    getDuration: () => 300,
    resolveBoomerangConfig: () => undefined,
    buildPredictionArgs: () => ({}),
    observedInteraction: async (action) => ({
      ...(await action(current())),
      observation: current(),
    }),
  });
  const execute = (includeSystemInsets = false) =>
    scroll.executeWithStrategy({
      options: {
        direction: "up",
        lookFor: { text: "Forms & Input", maxTime: 3000 },
        includeSystemInsets,
      },
      strategy: {
        observe: async () => current(),
        swipe: async ({ x1, y1, x2, y2, duration }) => {
          swipes++;
          return { success: true, x1, y1, x2, y2, duration, observation: current() };
        },
      },
    });
  return { execute, scroll, swipeCount: () => swipes };
}

describe("scroll-until-visible synthetic iOS navigation occlusion (#9096)", () => {
  test("no chrome or unavailable geometry preserves the centre-in-container test", async () => {
    const row = { left: 80, top: 230, right: 380, bottom: 280 };
    const noChrome = syntheticNavigationHierarchy(row);
    noChrome.systemInsets = { top: 0, right: 0, bottom: 0, left: 0 };
    const root = noChrome.hierarchy.node!;
    root.node = root.node!.slice(0, 1);
    // A content-only root resolves to a 460x200 screen, below the target's centre.
    root.$!.bounds = { left: 20, top: 100, right: 480, bottom: 300 };
    const h = harness([noChrome]);
    expect(await h.execute()).toMatchObject({ found: true, scrollIterations: 0 });
    expect(h.swipeCount()).toBe(0);

    for (const observation of [
      { viewHierarchy: noChrome, screenSize: navigationScreen },
      {},
      { screenSize: navigationScreen },
      { viewHierarchy: { hierarchy: {} } },
    ] satisfies ObserveResult[]) {
      expect(
        h.scroll["isElementWithinContainer"]({ bounds: row }, navigationViewport, observation),
      ).toBe(true);
      expect(
        h.scroll["isElementWithinContainer"](
          { bounds: row },
          { ...navigationViewport, bottom: 200 },
          observation,
        ),
      ).toBe(false);
    }
  });

  test("visible row needs no swipe; a row under chrome needs two observations before found", async () => {
    const visible = syntheticNavigationHierarchy(visibleNavigationRow);
    const already = harness([visible]);
    expect((await already.execute()).scrollIterations).toBe(0);
    expect(already.swipeCount()).toBe(0);
    // First post-swipe frame remains covered: both found-test call sites must reject it.
    const covered = syntheticNavigationHierarchy();
    const later = harness([covered, { ...covered, updatedAt: 2 }, visible]);
    const result = await later.execute();
    expect(result.found).toBe(true);
    expect(result.scrollIterations).toBe(2);
    expect(later.swipeCount()).toBe(2);
  });

  test("partial rows are found only when the exposed portion has a tappable point", async () => {
    // Ordinary centre y=110 is covered; exposed area [116,120] has a safe centre y=118.
    const partial = harness([
      syntheticNavigationHierarchy({ ...partialNavigationRow, top: 100, bottom: 120 }),
    ]);
    expect((await partial.execute()).scrollIterations).toBe(0);
    const covered = harness([
      syntheticNavigationHierarchy(coveredNavigationRow),
      syntheticNavigationHierarchy(partialNavigationRow),
    ]);
    expect((await covered.execute()).scrollIterations).toBe(1);
  });

  test("includeSystemInsets cannot make a covered match count as found", async () => {
    const scroll = harness([
      syntheticNavigationHierarchy(),
      syntheticNavigationHierarchy(visibleNavigationRow),
    ]);
    expect((await scroll.execute(true)).scrollIterations).toBe(1);
    // Synthetic capture without safe-area metadata: the navigation edge still bounds content.
    const aboveBar = syntheticNavigationHierarchy({ ...coveredNavigationRow, top: 10, bottom: 40 });
    delete aboveBar.systemInsets;
    expect(
      (await harness([aboveBar, syntheticNavigationHierarchy(visibleNavigationRow)]).execute())
        .scrollIterations,
    ).toBe(1);
  });

  test("a permanently covered row exhausts the existing reverse bound honestly", async () => {
    const scroll = harness([syntheticNavigationHierarchy()]);
    await expect(scroll.execute()).rejects.toThrow("not found");
    expect(scroll.swipeCount()).toBe(2);
  });

  for (const overlay of ["bottomBar", "keyboard"] as const) {
    test(`row covered by ${overlay} continues until exposed`, async () => {
      const row = { ...visibleNavigationRow, top: 810, bottom: 860 };
      const scroll = harness([
        syntheticNavigationHierarchy(row, { [overlay]: true }),
        syntheticNavigationHierarchy(visibleNavigationRow, { [overlay]: true }),
      ]);
      expect((await scroll.execute()).scrollIterations).toBe(1);
    });
  }

  test("Android still finds the same geometry immediately, while iOS scrolls", async () => {
    const sequence = [
      syntheticNavigationHierarchy(),
      syntheticNavigationHierarchy(visibleNavigationRow),
    ];
    expect((await harness(sequence, "android").execute()).scrollIterations).toBe(0);
    expect((await harness(sequence).execute()).scrollIterations).toBe(1);
  });
});

for (const { name, navBarBottom, bottom, point } of navigationExposureCases) {
  test(`swipeOn exposed navigation strip: ${name}`, async () => {
    const h = harness([
      syntheticNavigationHierarchy({ ...partialNavigationRow, top: 90, bottom }, { navBarBottom }),
      syntheticNavigationHierarchy(visibleNavigationRow),
    ]);
    const result = await h.execute();
    expect(result.found).toBe(true);
    expect(result.scrollIterations).toBe(point ? 0 : 1);
    expect(h.swipeCount()).toBe(point ? 0 : 1);
  });
}

test("swipeOn still finds unclipped one-point dividers on both platforms", async () => {
  for (const platform of ["ios", "android"] as const) {
    const h = harness(
      [syntheticNavigationHierarchy({ ...visibleNavigationRow, top: 200, bottom: 201 })],
      platform,
    );
    expect(await h.execute()).toMatchObject({ found: true, scrollIterations: 0 });
  }
});

test("swipeOn agrees with tapOn between navigation and keyboard edges", async () => {
  for (const { navBarBottom, keyboardTop, iterations } of [
    { navBarBottom: 116, keyboardTop: 120.5, iterations: 0 },
    { navBarBottom: 116.2, keyboardTop: 116.4, iterations: 1 },
  ]) {
    const h = harness([
      syntheticNavigationHierarchy(
        { ...partialNavigationRow, top: 110, bottom: 650 },
        { navBarBottom, keyboard: true, keyboardTop },
      ),
      syntheticNavigationHierarchy(visibleNavigationRow),
    ]);
    expect((await h.execute()).scrollIterations).toBe(iterations);
  }
});

test("swipeOn rejects an unclipped fractional width with no integer tap point", async () => {
  const h = harness([
    syntheticNavigationHierarchy({ left: 16.3, right: 16.8, top: 200, bottom: 201 }),
    syntheticNavigationHierarchy(visibleNavigationRow),
  ]);
  expect((await h.execute()).scrollIterations).toBe(1);
});
