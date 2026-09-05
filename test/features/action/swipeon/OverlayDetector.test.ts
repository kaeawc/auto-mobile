import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { SwipeOn } from "../../../../src/features/action/swipeon";
import { ObserveResult } from "../../../../src/models";
import { AndroidCtrlProxyClient } from "../../../../src/features/observe/android";
import { FakeAwaitIdle } from "../../../fakes/FakeAwaitIdle";
import { FakeAccessibilityDetector } from "../../../fakes/FakeAccessibilityDetector";
import { FakeObserveScreen } from "../../../fakes/FakeObserveScreen";
import { FakeGestureExecutor } from "../../../fakes/FakeGestureExecutor";
import { FakeWindow } from "../../../fakes/FakeWindow";
import { FakeTimer } from "../../../fakes/FakeTimer";
import type { Element, ElementBounds } from "../../../../src/models";
import { OverlayDetector } from "../../../../src/features/action/swipeon/OverlayDetector";
import { FakeElementFinder } from "../../../fakes/FakeElementFinder";
import { FakeElementGeometry } from "../../../fakes/FakeElementGeometry";
import { FakeElementParser } from "../../../fakes/FakeElementParser";

describe("OverlayDetector.collectOverlayCandidates container ancestors (#6128)", () => {
  const b = (left: number, top: number, right: number, bottom: number): ElementBounds => ({
    left,
    top,
    right,
    bottom,
  });
  const node = (bounds: ElementBounds, attrs: Record<string, string>, children: any[] = []) => ({
    $: { bounds, ...attrs },
    node: children,
  });
  const LIST_BOUNDS = b(0, 0, 1000, 2000);
  const listElement: Element = {
    bounds: LIST_BOUNDS,
    "resource-id": "list",
    scrollable: true,
  } as unknown as Element;
  // OverlayDetector resolves the selected container node itself (by
  // requiring a unique selector+exact-bounds match against the passed-in
  // containerElement — see resolveSelectedContainerNode) rather than
  // consulting the finder, so the finder is a bare, unconfigured fake here.
  // The bounds parser is faked too but delegates to the real, pure
  // src/utils/bounds parseBounds by default (see FakeElementParser), since
  // that logic is exactly what's under test. Geometry is never exercised by
  // collectOverlayCandidates. Per the repo's interfaces-and-fakes
  // convention, OverlayDetector remains the only concrete collaborator.
  const detector = () =>
    new OverlayDetector(
      new FakeElementFinder(),
      new FakeElementGeometry(),
      new FakeElementParser(),
    );

  test("a clickable ancestor of the container is not an overlay (issue repro: root(clickable) > list > row(clickable))", () => {
    const listNode = node(LIST_BOUNDS, { "resource-id": "list", scrollable: "true" }, [
      node(b(0, 0, 1000, 100), { "resource-id": "row", clickable: "true" }),
    ]);
    const hierarchy = {
      hierarchy: {
        node: [node(b(0, 0, 1000, 2000), { "resource-id": "root", clickable: "true" }, [listNode])],
      },
    };

    const overlays = detector().collectOverlayCandidates(
      hierarchy as any,
      { elementId: "list" },
      listElement,
    );

    expect(overlays).toEqual([]);
  });

  test("a genuine clickable sibling under a clickable root is still an overlay, and only it", () => {
    const fabBounds = b(800, 1700, 1000, 1900);
    const listNode = node(LIST_BOUNDS, { "resource-id": "list", scrollable: "true" });
    const hierarchy = {
      hierarchy: {
        node: [
          node(b(0, 0, 1000, 2000), { "resource-id": "root", focusable: "true" }, [
            node(b(0, 0, 1000, 2000), { "resource-id": "card", clickable: "true" }, [listNode]),
            node(fabBounds, { "resource-id": "fab", clickable: "true" }),
          ]),
        ],
      },
    };

    const overlays = detector().collectOverlayCandidates(
      hierarchy as any,
      { elementId: "list" },
      listElement,
    );

    expect(overlays).toHaveLength(1);
    expect(overlays[0].bounds).toEqual(fabBounds);
    expect(overlays[0].overlapBounds).toEqual(fabBounds);
  });

  test("a same-id node inside a topmost popup window does not donate its clickable ancestors to the skip set", () => {
    // The popup window is walked first (topmost-first). Its `list` shares the
    // container's resource-id but not its bounds, so it must not be taken as
    // the selected container — otherwise the clickable popup root (a genuine
    // overlay covering the list) would be suppressed as an "ancestor".
    const popupBounds = b(100, 600, 900, 1400);
    const realListNode = node(LIST_BOUNDS, { "resource-id": "list", scrollable: "true" });
    const hierarchy = {
      hierarchy: { node: [] },
      windows: [
        {
          windowLayer: 0,
          hierarchy: {
            node: [node(b(0, 0, 1000, 2000), { "resource-id": "root" }, [realListNode])],
          },
        },
        {
          windowLayer: 5,
          hierarchy: {
            node: [
              node(popupBounds, { "resource-id": "popup", clickable: "true" }, [
                node(b(100, 700, 900, 1300), { "resource-id": "list", scrollable: "true" }),
              ]),
            ],
          },
        },
      ],
    };

    const overlays = detector().collectOverlayCandidates(
      hierarchy as any,
      { elementId: "list" },
      listElement,
    );

    expect(overlays).toHaveLength(1);
    expect(overlays[0].bounds).toEqual(popupBounds);
    expect(overlays[0].overlapBounds).toEqual(popupBounds);
  });

  test("a same-id look-alike with missing or malformed bounds is not taken as the container either", () => {
    // Unparseable bounds must not fall through to an id-only match: the
    // popup's clickable root is still the one overlay in both variants.
    const popupBounds = b(100, 600, 900, 1400);
    const makeHierarchy = (lookAlikeAttrs: Record<string, string>) => ({
      hierarchy: { node: [] },
      windows: [
        {
          windowLayer: 0,
          hierarchy: {
            node: [
              node(b(0, 0, 1000, 2000), { "resource-id": "root" }, [
                node(LIST_BOUNDS, { "resource-id": "list", scrollable: "true" }),
              ]),
            ],
          },
        },
        {
          windowLayer: 5,
          hierarchy: {
            node: [
              node(popupBounds, { "resource-id": "popup", clickable: "true" }, [
                { $: { "resource-id": "list", scrollable: "true", ...lookAlikeAttrs }, node: [] },
              ]),
            ],
          },
        },
      ],
    });

    for (const lookAlike of [{}, { bounds: "not-a-rect" }]) {
      const overlays = detector().collectOverlayCandidates(
        makeHierarchy(lookAlike) as any,
        { elementId: "list" },
        listElement,
      );

      expect(overlays).toHaveLength(1);
      expect(overlays[0].bounds).toEqual(popupBounds);
    }
  });

  test("a same-id, same-bounds look-alike in a topmost popup still yields the genuine popup overlay (identity, not selector+bounds)", () => {
    // The popup's clickable root shares the real container's resource-id AND
    // exact bounds. A selector+bounds heuristic would accept it as "the
    // container" and donate the popup's own clickable root to the ancestor
    // skip set, silently suppressing a genuine overlay so the swipe would
    // pass through it. Only object identity to the finder-resolved node must
    // decide this: the popup's look-alike is a different parsed object, so
    // it can never match, and the popup's clickable root remains a detected
    // overlay. The real container lives in the MAIN hierarchy, which a real
    // ElementFinder always searches before any window — see
    // resolveSelectedContainerNode's main-first precedence.
    const realListNode = node(LIST_BOUNDS, { "resource-id": "list", scrollable: "true" });
    const hierarchy = {
      hierarchy: {
        node: [node(b(0, 0, 1000, 2000), { "resource-id": "root" }, [realListNode])],
      },
      windows: [
        {
          windowLayer: 5,
          hierarchy: {
            node: [
              node(LIST_BOUNDS, { "resource-id": "popup", clickable: "true" }, [
                node(LIST_BOUNDS, { "resource-id": "list", scrollable: "true" }),
              ]),
            ],
          },
        },
      ],
    };

    const overlays = detector().collectOverlayCandidates(
      hierarchy as any,
      { elementId: "list" },
      listElement,
    );

    expect(overlays).toHaveLength(1);
    expect(overlays[0].bounds).toEqual(LIST_BOUNDS);
  });

  test("anchors identity to the area-sorted selected match, not the first traversal match, when two `list` nodes share the id (terminal #6128 follow-up)", () => {
    // Two `list` nodes share the resource-id. The real ElementFinder resolves
    // the swipe target by AREA-SORTING matches and picking the smallest — here
    // listB, under cardB — while a first-match traversal (the earlier,
    // now-removed reliance on finder.findContainerNode) would instead land on
    // listA, under cardA, which is visited first and is larger.
    //
    // Anchoring ancestor-collection to the wrong node (listA) would exempt
    // cardA — a stranger to listB, not really its ancestor — while leaving
    // cardB, listB's REAL and fully-covering parent, unexempted: exactly the
    // "full-cover overlay blocks the whole swipe" bug this file exists to
    // prevent, just reintroduced via node-identity instead of selector+bounds.
    const cardABounds = b(0, 0, 1000, 1000);
    const listABounds = b(0, 0, 1000, 1000);
    const cardBBounds = b(0, 900, 1000, 1300);
    const listBBounds = b(100, 950, 900, 1250);

    const hierarchy = {
      hierarchy: {
        node: [
          node(cardABounds, { "resource-id": "cardA", clickable: "true" }, [
            node(listABounds, { "resource-id": "list", scrollable: "true" }),
          ]),
          node(cardBBounds, { "resource-id": "cardB", clickable: "true" }, [
            node(listBBounds, { "resource-id": "list", scrollable: "true" }),
          ]),
        ],
      },
    };

    // Mirrors what the real, area-sorted ElementFinder.findElementByResourceId
    // hands back as the swipe target: the smaller of the two `list` matches
    // (listB, area 640,000 vs listA's 1,000,000) — not the first one visited.
    const selectedListElement: Element = {
      bounds: listBBounds,
      "resource-id": "list",
      scrollable: true,
    } as unknown as Element;

    const overlays = detector().collectOverlayCandidates(
      hierarchy as any,
      { elementId: "list" },
      selectedListElement,
    );

    // cardB truly contains listB and must be exempted as its ancestor, not
    // reported as a full-cover overlay that would block the swipe outright.
    // cardA is a stranger to listB (not its ancestor) and clips the top of
    // its bounds; it must still be reported as a genuine overlay, not wrongly
    // exempted because identity was anchored to listA instead of listB.
    expect(overlays).toHaveLength(1);
    expect(overlays[0].overlapBounds).toEqual(b(100, 950, 900, 1000));
  });

  test("returns no ancestor skip set when no node has both the selector and the target's exact bounds", () => {
    // The `list` node's bounds don't match containerElement's bounds — as if
    // the resolved target and this hierarchy snapshot diverged. With no node
    // satisfying both the selector and the exact bounds, identity cannot be
    // anchored, so the safe fallback (no ancestor skip set) applies: the
    // clickable root is still reported as an overlay candidate rather than
    // risking exemption of the wrong node's ancestors.
    const mismatchedBounds = b(0, 0, 500, 500);
    const hierarchy = {
      hierarchy: {
        node: [
          node(b(0, 0, 1000, 2000), { "resource-id": "root", clickable: "true" }, [
            node(mismatchedBounds, { "resource-id": "list", scrollable: "true" }),
          ]),
        ],
      },
    };

    const overlays = detector().collectOverlayCandidates(
      hierarchy as any,
      { elementId: "list" },
      listElement,
    );

    expect(overlays).toHaveLength(1);
    expect(overlays[0].bounds).toEqual(b(0, 0, 1000, 2000));
  });

  test("returns no ancestor skip set when two nodes tie on the selector and the target's exact bounds", () => {
    // Two `list` nodes share both the resource-id and the exact bounds of
    // containerElement: resolveSelectedContainerNode cannot pick one over the
    // other, so identity is ambiguous. The safe fallback applies — no
    // ancestor is exempted — rather than risking anchoring to whichever tied
    // node happens to be visited.
    const hierarchy = {
      hierarchy: {
        node: [
          node(b(0, 0, 1000, 2000), { "resource-id": "root", clickable: "true" }, [
            node(LIST_BOUNDS, { "resource-id": "list", scrollable: "true" }),
            node(LIST_BOUNDS, { "resource-id": "list", scrollable: "true" }),
          ]),
        ],
      },
    };

    const overlays = detector().collectOverlayCandidates(
      hierarchy as any,
      { elementId: "list" },
      listElement,
    );

    expect(overlays).toHaveLength(1);
    expect(overlays[0].bounds).toEqual(b(0, 0, 1000, 2000));
  });

  test("a container selected from the MAIN hierarchy has its clickable ancestor exempted even when window hierarchies also exist (terminal #6128 follow-up: ancestor walk source-tree fix)", () => {
    // The container resolves from the MAIN hierarchy (resolveSelectedContainerNode's
    // main-first precedence), but the ancestor walk used to always run over
    // `rootGroups`, which is window-only once ANY window exists — excluding
    // the main hierarchy the identified node actually lives in. The node was
    // therefore never found by identity in that walk, so its real clickable
    // ancestor (a full-screen app-root) went unexempted and was reported as
    // a full-cover overlay, reproducing the exact blocked-swipe bug this PR
    // removes, just for main-hierarchy-selected containers specifically.
    const realListNode = node(LIST_BOUNDS, { "resource-id": "list", scrollable: "true" });
    const toastBounds = b(0, 1800, 1000, 2000);
    const hierarchy = {
      hierarchy: {
        node: [
          node(b(0, 0, 1000, 2000), { "resource-id": "appRoot", clickable: "true" }, [
            realListNode,
          ]),
        ],
      },
      windows: [
        {
          windowLayer: 5,
          hierarchy: {
            node: [node(toastBounds, { "resource-id": "toast", clickable: "true" })],
          },
        },
      ],
    };

    const overlays = detector().collectOverlayCandidates(
      hierarchy as any,
      { elementId: "list" },
      listElement,
    );

    // appRoot (the real, main-hierarchy ancestor) must be exempted; only the
    // genuine, unrelated window overlay (the toast) is reported.
    expect(overlays).toHaveLength(1);
    expect(overlays[0].bounds).toEqual(toastBounds);
  });

  test("a same-bounds sibling sharing only an incidental resource-id (different text) does not cause ambiguity (terminal #6128 follow-up: AND, not OR, identity matching)", () => {
    // containerElement carries BOTH a resource-id and text. A sibling node
    // happens to share the same resource-id and even the same bounds, but
    // has different text. Under OR-matching (any single populated field is
    // enough) that sibling would count as a second match, making identity
    // resolution "ambiguous" and forcing the safe empty-ancestor fallback —
    // resurfacing the full-cover-overlay/blocked-swipe bug for a case that
    // isn't actually ambiguous once the full identity (id AND text) must
    // agree.
    const selected: Element = {
      bounds: LIST_BOUNDS,
      "resource-id": "list",
      text: "Groceries",
    } as unknown as Element;

    const hierarchy = {
      hierarchy: {
        node: [
          node(b(0, 0, 1000, 2000), { "resource-id": "root", clickable: "true" }, [
            node(LIST_BOUNDS, { "resource-id": "list", text: "Groceries", scrollable: "true" }),
            node(LIST_BOUNDS, { "resource-id": "list", text: "Recents", scrollable: "true" }),
          ]),
        ],
      },
    };

    const overlays = detector().collectOverlayCandidates(
      hierarchy as any,
      { elementId: "list", text: "Groceries" },
      selected,
    );

    // root is the real, uniquely-identified target's genuine ancestor and
    // must be exempted — not reported as a full-cover overlay.
    expect(overlays).toEqual([]);
  });
});

describe("SwipeOn container overlays", () => {
  const device = { name: "test-device", platform: "android", deviceId: "device-1" } as const;
  let fakeObserveScreen: FakeObserveScreen;
  let fakeGesture: FakeGestureExecutor;
  let fakeAwaitIdle: FakeAwaitIdle;
  let fakeWindow: FakeWindow;
  let fakeTimer: FakeTimer;
  let fakeAccessibilityDetector: FakeAccessibilityDetector;
  let getInstanceSpy: ReturnType<typeof spyOn> | null = null;

  const createObserveResult = (viewHierarchy: any): ObserveResult => ({
    timestamp: Date.now(),
    screenSize: { width: 1000, height: 2000 },
    systemInsets: { top: 0, right: 0, bottom: 0, left: 0 },
    viewHierarchy,
  });

  const createHierarchy = (nodes: any[]) => ({
    hierarchy: {
      node: nodes,
    },
  });

  const b = (left: number, top: number, right: number, bottom: number): ElementBounds => ({
    left,
    top,
    right,
    bottom,
  });

  const createNode = (bounds: ElementBounds, attributes: Record<string, string>) => ({
    $: {
      bounds,
      ...attributes,
    },
  });

  const createContainerNode = (
    bounds: ElementBounds,
    resourceId: string,
    children: any[] = [],
  ) => ({
    $: {
      bounds,
      "resource-id": resourceId,
      scrollable: "true",
    },
    node: children,
  });

  const createSwipeOn = () => {
    const swipeOn = new SwipeOn(device, {} as any, {
      executeGesture: fakeGesture,
      observeScreen: fakeObserveScreen,
      accessibilityDetector: fakeAccessibilityDetector,
    });
    (swipeOn as any).awaitIdle = fakeAwaitIdle;
    (swipeOn as any).window = fakeWindow;
    (swipeOn as any).timer = fakeTimer;
    return swipeOn;
  };

  beforeEach(() => {
    fakeAccessibilityDetector = new FakeAccessibilityDetector();
    fakeAccessibilityDetector.setTalkBackEnabled(false);
    getInstanceSpy = spyOn(AndroidCtrlProxyClient, "getInstance").mockReturnValue(
      {} as AndroidCtrlProxyClient,
    );
    fakeObserveScreen = new FakeObserveScreen();
    fakeGesture = new FakeGestureExecutor();
    fakeAwaitIdle = new FakeAwaitIdle();
    fakeWindow = new FakeWindow();
    fakeTimer = new FakeTimer();
    fakeTimer.enableAutoAdvance();
    fakeWindow.configureCachedActiveWindow(null);
  });

  afterEach(() => {
    getInstanceSpy?.mockRestore();
  });

  test("avoids clickable overlays outside the container subtree", async () => {
    const containerNode = createContainerNode(b(0, 0, 1000, 2000), "map-container");
    const overlayTop = createNode(b(0, 0, 1000, 200), {
      "resource-id": "search-bar",
      clickable: "true",
    });
    const overlayCenter = createNode(b(400, 0, 600, 2000), {
      "resource-id": "overlay-strip",
      clickable: "true",
    });

    const hierarchy = createHierarchy([containerNode, overlayTop, overlayCenter]);
    fakeObserveScreen.setObserveResult(createObserveResult(hierarchy));

    const swipeOn = createSwipeOn();
    const result = await swipeOn.execute({
      direction: "down",
      container: { elementId: "map-container" },
    });

    expect(result.success).toBe(true);
    const [call] = fakeGesture.getSwipeCalls();
    expect(call).toBeDefined();
    expect(call.x1).toBe(call.x2);
    expect(call.x1 < 400 || call.x1 > 600).toBe(true);
    expect(call.y1).toBeGreaterThan(0);
  });

  test("ignores clickable elements inside the container subtree", async () => {
    const childOverlay = createNode(b(0, 0, 1000, 800), {
      "resource-id": "child-overlay",
      clickable: "true",
    });
    const containerNode = createContainerNode(b(0, 0, 1000, 2000), "list-container", [
      childOverlay,
    ]);

    const hierarchy = createHierarchy([containerNode]);
    fakeObserveScreen.setObserveResult(createObserveResult(hierarchy));

    const swipeOn = createSwipeOn();
    const result = await swipeOn.execute({
      direction: "down",
      container: { elementId: "list-container" },
    });

    expect(result.success).toBe(true);
    expect(result.warning).toBeUndefined();
    const [call] = fakeGesture.getSwipeCalls();
    expect(call).toBeDefined();
    expect(call.x1).toBe(500);
    expect(call.y1).toBe(200);
  });

  test("does not treat the container's clickable ancestor as an overlay (#6128)", async () => {
    // root(clickable) > list(scrollable) > row(clickable): the root is visited
    // before the container and fully covers it, so it used to be recorded as
    // an overlay and force the "No unobstructed swipe area" fallback.
    const row = createNode(b(0, 0, 1000, 100), { "resource-id": "row", clickable: "true" });
    const containerNode = createContainerNode(b(0, 0, 1000, 2000), "list-container", [row]);
    const clickableRoot = {
      $: { bounds: b(0, 0, 1000, 2000), "resource-id": "root", clickable: "true" },
      node: [containerNode],
    };

    fakeObserveScreen.setObserveResult(createObserveResult(createHierarchy([clickableRoot])));

    const swipeOn = createSwipeOn();
    const result = await swipeOn.execute({
      direction: "down",
      container: { elementId: "list-container" },
    });

    expect(result.success).toBe(true);
    expect(result.warning).toBeUndefined();
    const [call] = fakeGesture.getSwipeCalls();
    expect(call).toBeDefined();
    // Same coordinates as an unobstructed container: center x, default start y.
    expect(call.x1).toBe(500);
    expect(call.y1).toBe(200);
  });

  test("still avoids a genuine sibling overlay under a clickable root (#6128)", async () => {
    const containerNode = createContainerNode(b(0, 0, 1000, 2000), "list-container");
    const bottomBar = createNode(b(0, 1700, 1000, 2000), {
      "resource-id": "bottom-bar",
      clickable: "true",
    });
    const clickableRoot = {
      $: { bounds: b(0, 0, 1000, 2000), "resource-id": "root", clickable: "true" },
      node: [containerNode, bottomBar],
    };

    fakeObserveScreen.setObserveResult(createObserveResult(createHierarchy([clickableRoot])));

    const swipeOn = createSwipeOn();
    const result = await swipeOn.execute({
      direction: "down",
      container: { elementId: "list-container" },
    });

    expect(result.success).toBe(true);
    // Overlay avoidance must not have been abandoned via the fallback.
    expect(result.warning).toBeUndefined();
    const [call] = fakeGesture.getSwipeCalls();
    expect(call).toBeDefined();
    expect(call.x1).toBe(call.x2);
    // Both ends stay above the bottom bar (1700) minus the 8px overlay padding.
    expect(Math.max(call.y1, call.y2)).toBeLessThanOrEqual(1692);
  });

  test("handles a nested container inside a clickable card under a focusable root (#6128)", async () => {
    const containerNode = createContainerNode(b(0, 500, 1000, 1500), "nested-list");
    const card = {
      $: { bounds: b(0, 500, 1000, 1500), "resource-id": "card", clickable: "true" },
      node: [containerNode],
    };
    const focusableRoot = {
      $: { bounds: b(0, 0, 1000, 2000), "resource-id": "root", focusable: "true" },
      node: [card],
    };

    fakeObserveScreen.setObserveResult(createObserveResult(createHierarchy([focusableRoot])));

    const swipeOn = createSwipeOn();
    const result = await swipeOn.execute({
      direction: "down",
      container: { elementId: "nested-list" },
    });

    expect(result.success).toBe(true);
    expect(result.warning).toBeUndefined();
    const [call] = fakeGesture.getSwipeCalls();
    expect(call).toBeDefined();
    expect(call.x1).toBe(500);
    expect(call.y1).toBeGreaterThanOrEqual(500);
    expect(call.y2).toBeLessThanOrEqual(1500);
  });

  test("keeps the larger overlay when overlap is partial", async () => {
    const containerNode = createContainerNode(b(0, 0, 1000, 2000), "map-container");
    const overlayLarge = createNode(b(0, 0, 1000, 400), {
      "resource-id": "large-overlay",
      clickable: "true",
    });
    const overlaySmall = createNode(b(0, 0, 1000, 200), {
      "resource-id": "small-overlay",
      clickable: "true",
    });

    const hierarchy = createHierarchy([containerNode, overlayLarge, overlaySmall]);
    fakeObserveScreen.setObserveResult(createObserveResult(hierarchy));

    const swipeOn = createSwipeOn();
    const result = await swipeOn.execute({
      direction: "down",
      container: { elementId: "map-container" },
    });

    expect(result.success).toBe(true);
    const [call] = fakeGesture.getSwipeCalls();
    expect(call).toBeDefined();
    expect(call.y1).toBeGreaterThan(400);
  });

  test("avoids all overlapping clickable elements when multiple exist", async () => {
    const containerNode = createContainerNode(b(0, 0, 1000, 2000), "map-container");
    const overlayLarge = createNode(b(0, 0, 1000, 1000), {
      "resource-id": "large-overlay",
      clickable: "true",
    });
    const overlaySmall = createNode(b(0, 0, 1000, 900), {
      "resource-id": "small-overlay",
      clickable: "true",
    });

    const hierarchy = createHierarchy([containerNode, overlayLarge, overlaySmall]);
    fakeObserveScreen.setObserveResult(createObserveResult(hierarchy));

    const swipeOn = createSwipeOn();
    const result = await swipeOn.execute({
      direction: "down",
      container: { elementId: "map-container" },
    });

    expect(result.success).toBe(true);
    const [call] = fakeGesture.getSwipeCalls();
    expect(call).toBeDefined();
    // Should start after the largest overlay (1000px) plus padding
    expect(call.y1).toBeGreaterThan(1000);
  });

  test("handles complex scenarios like Google Maps with multiple overlays", async () => {
    // Simulate Google Maps layout with multiple overlays
    const containerNode = createContainerNode(
      b(0, 0, 1080, 2400),
      "com.google.android.apps.maps:id/fullscreens_group",
    );

    // Search bar at top
    const searchBar = createNode(b(0, 0, 1080, 226), {
      "resource-id": "com.google.android.apps.maps:id/search_omnibox_container",
      clickable: "true",
    });

    // Category chips below search bar
    const categoryChips = createNode(b(31, 226, 1080, 352), {
      "resource-id": "com.google.android.apps.maps:id/recycler_view",
      clickable: "true",
    });

    // Bottom controls
    const locationButton = createNode(b(881, 1886, 1080, 2072), {
      "resource-id": "com.google.android.apps.maps:id/mylocation_button",
      clickable: "true",
    });

    const streetViewThumb = createNode(b(36, 1907, 272, 2049), {
      "resource-id": "com.google.android.apps.maps:id/street_view_thumbnail",
      clickable: "true",
    });

    const layersButton = createNode(b(928, 378, 1080, 520), {
      "resource-id": "com.google.android.apps.maps:id/layers_fab",
      clickable: "true",
    });

    const hierarchy = createHierarchy([
      containerNode,
      searchBar,
      categoryChips,
      locationButton,
      streetViewThumb,
      layersButton,
    ]);
    fakeObserveScreen.setObserveResult(createObserveResult(hierarchy));

    const swipeOn = createSwipeOn();
    const result = await swipeOn.execute({
      direction: "down",
      container: { elementId: "com.google.android.apps.maps:id/fullscreens_group" },
    });

    expect(result.success).toBe(true);
    const [call] = fakeGesture.getSwipeCalls();
    expect(call).toBeDefined();

    // Should start below the category chips (352px) plus padding
    expect(call.y1).toBeGreaterThan(352);

    // The swipe should be vertical (same x coordinate)
    expect(call.x1).toBe(call.x2);

    // X coordinate should avoid overlays:
    // - Not in streetViewThumb range [36-272]
    // - Not in locationButton range [881-1080]
    // - Not in layersButton range [928-1080]
    // So it should be in the safe middle zone [272-881]
    expect(call.x1).toBeGreaterThan(272);
    expect(call.x1).toBeLessThan(881);

    // Swipe should have reasonable distance (at least 500px for "down" direction)
    const swipeDistance = Math.abs(call.y2 - call.y1);
    expect(swipeDistance).toBeGreaterThan(500);
  });

  test("uses default bounds when no overlays are present", async () => {
    const containerNode = createContainerNode(b(0, 0, 1000, 2000), "container-no-overlays");

    const hierarchy = createHierarchy([containerNode]);
    fakeObserveScreen.setObserveResult(createObserveResult(hierarchy));

    const swipeOn = createSwipeOn();
    const result = await swipeOn.execute({
      direction: "down",
      container: { elementId: "container-no-overlays" },
    });

    expect(result.success).toBe(true);
    expect(result.warning).toBeUndefined();
    const [call] = fakeGesture.getSwipeCalls();
    expect(call).toBeDefined();
    // Should use center x coordinate (500) since no overlays
    expect(call.x1).toBe(500);
  });

  test("handles horizontal swipes with overlays on top and bottom", async () => {
    const containerNode = createContainerNode(b(0, 0, 1000, 2000), "horizontal-container");
    const topOverlay = createNode(b(0, 0, 1000, 300), {
      "resource-id": "top-bar",
      clickable: "true",
    });
    const bottomOverlay = createNode(b(0, 1700, 1000, 2000), {
      "resource-id": "bottom-bar",
      clickable: "true",
    });

    const hierarchy = createHierarchy([containerNode, topOverlay, bottomOverlay]);
    fakeObserveScreen.setObserveResult(createObserveResult(hierarchy));

    const swipeOn = createSwipeOn();
    const result = await swipeOn.execute({
      direction: "left",
      container: { elementId: "horizontal-container" },
    });

    expect(result.success).toBe(true);
    const [call] = fakeGesture.getSwipeCalls();
    expect(call).toBeDefined();
    // Y should be in safe zone between overlays
    expect(call.y1).toBeGreaterThan(300);
    expect(call.y1).toBeLessThan(1700);
    expect(call.y1).toBe(call.y2); // Same Y for horizontal swipe
  });

  test("ignores non-clickable elements", async () => {
    const containerNode = createContainerNode(b(0, 0, 1000, 2000), "container-with-non-clickable");
    const nonClickableOverlay = createNode(b(0, 0, 1000, 500), {
      "resource-id": "non-clickable-element",
      clickable: "false",
    });

    const hierarchy = createHierarchy([containerNode, nonClickableOverlay]);
    fakeObserveScreen.setObserveResult(createObserveResult(hierarchy));

    const swipeOn = createSwipeOn();
    const result = await swipeOn.execute({
      direction: "down",
      container: { elementId: "container-with-non-clickable" },
    });

    expect(result.success).toBe(true);
    expect(result.warning).toBeUndefined();
    const [call] = fakeGesture.getSwipeCalls();
    expect(call).toBeDefined();
    // Should not avoid non-clickable overlay, so y1 can be anywhere
    // Including the area covered by the non-clickable element
    expect(call.y1).toBeLessThan(500);
  });

  test("avoids focusable elements even if not clickable", async () => {
    const containerNode = createContainerNode(b(0, 0, 1000, 2000), "container-with-focusable");
    const focusableOverlay = createNode(b(0, 0, 1000, 300), {
      "resource-id": "focusable-element",
      focusable: "true",
    });

    const hierarchy = createHierarchy([containerNode, focusableOverlay]);
    fakeObserveScreen.setObserveResult(createObserveResult(hierarchy));

    const swipeOn = createSwipeOn();
    const result = await swipeOn.execute({
      direction: "down",
      container: { elementId: "container-with-focusable" },
    });

    expect(result.success).toBe(true);
    const [call] = fakeGesture.getSwipeCalls();
    expect(call).toBeDefined();
    // Should avoid focusable overlay
    expect(call.y1).toBeGreaterThan(300);
  });

  test("ignores overlays completely outside container bounds", async () => {
    const containerNode = createContainerNode(b(100, 100, 900, 1900), "inner-container");
    // Overlay outside container bounds
    const outsideOverlay = createNode(b(0, 0, 50, 2000), {
      "resource-id": "outside-overlay",
      clickable: "true",
    });

    const hierarchy = createHierarchy([containerNode, outsideOverlay]);
    fakeObserveScreen.setObserveResult(createObserveResult(hierarchy));

    const swipeOn = createSwipeOn();
    const result = await swipeOn.execute({
      direction: "down",
      container: { elementId: "inner-container" },
    });

    expect(result.success).toBe(true);
    expect(result.warning).toBeUndefined();
    const [call] = fakeGesture.getSwipeCalls();
    expect(call).toBeDefined();
    // Should use container center (500) since overlay doesn't overlap
    expect(call.x1).toBe(500);
  });

  test("warns when overlays leave minimal safe space", async () => {
    const containerNode = createContainerNode(b(0, 0, 1000, 2000), "mostly-blocked-container");
    // Create overlays that cover most of the vertical space
    const overlay1 = createNode(b(0, 0, 1000, 1950), {
      "resource-id": "massive-overlay",
      clickable: "true",
    });

    const hierarchy = createHierarchy([containerNode, overlay1]);
    fakeObserveScreen.setObserveResult(createObserveResult(hierarchy));

    const swipeOn = createSwipeOn();
    const result = await swipeOn.execute({
      direction: "down",
      container: { elementId: "mostly-blocked-container" },
    });

    expect(result.success).toBe(true);
    // Should have warning about reduced swipe area
    expect(result.warning).toBeDefined();
    expect(result.warning).toContain("Swipe area reduced");
    const [call] = fakeGesture.getSwipeCalls();
    expect(call).toBeDefined();
    // Y should be in the small remaining gap
    expect(call.y1).toBeGreaterThan(1950);
  });

  test("handles overlays with partial intersection", async () => {
    const containerNode = createContainerNode(b(0, 0, 1000, 2000), "container");
    // Overlay that only partially overlaps container
    const partialOverlay = createNode(b(500, 0, 1500, 400), {
      "resource-id": "partial-overlay",
      clickable: "true",
    });

    const hierarchy = createHierarchy([containerNode, partialOverlay]);
    fakeObserveScreen.setObserveResult(createObserveResult(hierarchy));

    const swipeOn = createSwipeOn();
    const result = await swipeOn.execute({
      direction: "down",
      container: { elementId: "container" },
    });

    expect(result.success).toBe(true);
    const [call] = fakeGesture.getSwipeCalls();
    expect(call).toBeDefined();
    // Should avoid the overlapping part [500-1000, 0-400]
    // X should be < 500 or Y should start > 400
    expect(call.x1 < 500 || call.y1 > 400).toBe(true);
  });
});
