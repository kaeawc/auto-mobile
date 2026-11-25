import { afterEach, describe, expect, test } from "bun:test";
import type { WatchCommand } from "../../../src/features/watch/WatchRunnerClient";
import { watchRunners } from "../../../src/features/watch/WatchRunnerRegistry";
import { watchSwipeOn, watchTapOn } from "../../../src/features/watch/WatchActions";
import { watchSendKeys } from "../../../src/features/watch/WatchSendKeys";
import { WATCH_SCROLL_INTO_VIEW_SWIPE_DISTANCE } from "../../../src/features/watch/WatchScrollIntoView";
import { WatchRunnerError } from "../../../src/features/watch/WatchRunnerError";
import { FakeSequencedWatchRunner, FakeWatchRunnerClient } from "../../fakes/FakeWatchRunnerClient";
import { FakeTimer } from "../../fakes/FakeTimer";
import hierarchy from "../../fixtures/watchos-xcuitest/sdk-hierarchy-live.json";

// The captured fixture's screen is 184 x 224 points; rows are moved relative to its bottom edge.
type Bounds = { left: number; top: number; right: number; bottom: number };
const deviceId = "watch-scroll-into-view";

function timer() {
  const fake = new FakeTimer();
  fake.enableAutoAdvance();
  return fake;
}

function node(type: number, label: string, bounds: Bounds, extra: object = {}) {
  const root = structuredClone(hierarchy.root);
  return {
    ...root,
    className: `XCUIElementType(${type})`,
    accessibilityIdentifier: "",
    accessibilityLabel: label,
    bounds,
    children: [],
    ...extra,
  };
}

/** The captured app tree plus one "Text entry" row (an identified cell) at the given bounds. */
function withRow(bounds: Bounds) {
  const tree = structuredClone(hierarchy);
  tree.root.children = [
    ...tree.root.children,
    node(75, "Text entry", bounds, { accessibilityIdentifier: "watch-text-entry" }),
  ];
  return tree;
}

/** A permission alert whose Allow button sits below the screen edge until the crown scrolls it. */
function withAlert(allowTop: number) {
  const tree = structuredClone(hierarchy);
  tree.root.children = [
    node(
      7,
      "",
      { left: 0, top: 0, right: 184, bottom: 224 },
      {
        children: [
          node(48, "CtrlProxyWatch Would Like to Send You Notifications", {
            left: 15,
            top: 40,
            right: 169,
            bottom: 90,
          }),
          node(9, "Don’t Allow", { left: 0, top: allowTop - 51, right: 184, bottom: allowTop }),
          node(9, "Allow", { left: 0, top: allowTop, right: 184, bottom: allowTop + 50 }),
        ],
      },
    ),
  ];
  return tree;
}

let release: (() => void) | undefined;
function register<T extends FakeWatchRunnerClient>(client: T): T {
  release = watchRunners.register(deviceId, client);
  return client;
}
afterEach(() => release?.());

const actions = (client: FakeWatchRunnerClient): WatchCommand[] =>
  client.commands.filter((command) => command.type !== "hierarchy" && command.type !== "face");

describe("watch element-targeted tools below the fold (#19184)", () => {
  test("tapOn swipes a row below the screen edge into view, then taps it", async () => {
    const client = register(
      new FakeSequencedWatchRunner([
        withRow({ left: 2, top: 206, right: 182, bottom: 262 }),
        withRow({ left: 2, top: 116, right: 182, bottom: 172 }),
      ]),
    );
    const result = await watchTapOn(
      deviceId,
      { action: "tap", elementId: "watch-text-entry" },
      undefined,
      { timer: timer() },
    );
    expect(result).toMatchObject({
      success: true,
      element: { "resource-id": "watch-text-entry", bounds: { top: 116 } },
    });
    expect(actions(client)).toEqual([
      { type: "swipe", direction: "up", distance: WATCH_SCROLL_INTO_VIEW_SWIPE_DISTANCE },
      { type: "tap", identifier: "watch-text-entry" },
    ]);
  });

  test("tapOn scrolls content above the screen edge down", async () => {
    const client = register(
      new FakeSequencedWatchRunner([
        withRow({ left: 2, top: -40, right: 182, bottom: 16 }),
        withRow({ left: 2, top: 20, right: 182, bottom: 76 }),
      ]),
    );
    await watchTapOn(deviceId, { action: "tap", text: "Text entry" }, undefined, {
      timer: timer(),
    });
    expect(actions(client)).toEqual([
      { type: "swipe", direction: "down", distance: WATCH_SCROLL_INTO_VIEW_SWIPE_DISTANCE },
      { type: "tap", identifier: "watch-text-entry" },
    ]);
  });

  test("tapOn turns the crown, not a swipe, to reveal an alert's Allow button", async () => {
    const client = register(new FakeSequencedWatchRunner([withAlert(232), withAlert(150)]));
    const result = await watchTapOn(deviceId, { action: "tap", text: "Allow" }, undefined, {
      timer: timer(),
    });
    expect(result).toMatchObject({ success: true, element: { text: "Allow" } });
    expect(actions(client)).toEqual([
      { type: "crown", delta: 1, velocity: 1 },
      { type: "tap", x: 92, y: 175 },
    ]);
    expect(client.requestOptions[client.commands.findIndex((c) => c.type === "crown")]).toEqual({
      timeoutMs: 30_000,
    });
  });

  test("a crown at its scroll limit stops the reveal and taps the visible part", async () => {
    const client = register(new FakeWatchRunnerClient(withAlert(204)));
    const request = client.request.bind(client);
    client.request = async (command, signal, options) => {
      if (command.type === "crown") {
        client.commands.push(command);
        throw new WatchRunnerError(
          "rotateCrown changed nothing the accessibility tree shows. Tap the view that should receive the crown, then observe before trying again.",
          "command_failed",
        );
      }
      return request(command, signal, options);
    };
    await watchTapOn(deviceId, { action: "tap", text: "Allow" }, undefined, { timer: timer() });
    expect(actions(client)).toEqual([
      { type: "crown", delta: 1, velocity: 1 },
      { type: "tap", x: 92, y: 214 },
    ]);
  });

  test("a row that does not move taps its visible part after one step", async () => {
    const client = register(
      new FakeWatchRunnerClient(withRow({ left: 2, top: 206, right: 182, bottom: 262 })),
    );
    await watchTapOn(deviceId, { action: "tap", elementId: "watch-text-entry" }, undefined, {
      timer: timer(),
    });
    expect(actions(client)).toEqual([
      { type: "swipe", direction: "up", distance: WATCH_SCROLL_INTO_VIEW_SWIPE_DISTANCE },
      { type: "tap", x: 92, y: 215 },
    ]);
  });

  test("scrolling is bounded and an element that never shows fails with a scroll hint", async () => {
    const trees = [300, 290, 280, 270, 260, 250].map((top) =>
      withRow({ left: 2, top, right: 182, bottom: top + 56 }),
    );
    const client = register(new FakeSequencedWatchRunner(trees));
    await expect(
      watchTapOn(deviceId, { action: "tap", text: "Text entry" }, undefined, { timer: timer() }),
    ).rejects.toThrow(
      'The watch element "Text entry" is off-screen and scrolling did not bring it into view; scroll with swipeOn or rotateCrown, observe, then retry.',
    );
    expect(actions(client)).toHaveLength(4);
    expect(actions(client).every((command) => command.type === "swipe")).toBe(true);
  });

  test("an element beside the screen is not a target and nothing scrolls", async () => {
    const client = register(
      new FakeWatchRunnerClient(withRow({ left: 190, top: 40, right: 370, bottom: 96 })),
    );
    await expect(
      watchTapOn(deviceId, { action: "tap", text: "Text entry" }, undefined, { timer: timer() }),
    ).rejects.toThrow("No watch element matched");
    expect(actions(client)).toEqual([]);
  });

  /** Rows sharing the "Text entry" label, each with its own identifier. */
  function withRows(rows: Array<{ id: string; bounds: Bounds }>) {
    const tree = structuredClone(hierarchy);
    tree.root.children = [
      ...tree.root.children,
      ...rows.map(({ id, bounds }) =>
        node(75, "Text entry", bounds, { accessibilityIdentifier: id }),
      ),
    ];
    return tree;
  }

  test("tapOn prefers a visible match over an earlier off-screen one, without scrolling", async () => {
    const client = register(
      new FakeWatchRunnerClient(
        withRows([
          { id: "hidden-entry", bounds: { left: 2, top: -100, right: 182, bottom: -44 } },
          { id: "visible-entry", bounds: { left: 2, top: 40, right: 182, bottom: 96 } },
        ]),
      ),
    );
    const result = await watchTapOn(deviceId, { action: "tap", text: "Text entry" }, undefined, {
      timer: timer(),
    });
    expect(result).toMatchObject({ element: { "resource-id": "visible-entry" } });
    expect(actions(client)).toEqual([{ type: "tap", identifier: "visible-entry" }]);
  });

  test("tapOn index counts only visible matches when any is on screen", async () => {
    const client = register(
      new FakeWatchRunnerClient(
        withRows([
          { id: "hidden-entry", bounds: { left: 2, top: -100, right: 182, bottom: -44 } },
          { id: "first-entry", bounds: { left: 2, top: 20, right: 182, bottom: 76 } },
          { id: "second-entry", bounds: { left: 2, top: 100, right: 182, bottom: 156 } },
          { id: "below-entry", bounds: { left: 2, top: 300, right: 182, bottom: 356 } },
        ]),
      ),
    );
    await watchTapOn(deviceId, { action: "tap", text: "Text entry", index: 1 }, undefined, {
      timer: timer(),
    });
    expect(actions(client)).toEqual([{ type: "tap", identifier: "second-entry" }]);
    await expect(
      watchTapOn(deviceId, { action: "tap", text: "Text entry", index: 2 }, undefined, {
        timer: timer(),
      }),
    ).rejects.toThrow("No watch element matched");
  });

  test("a tall row that oscillates between reveal directions stops at a repeated position", async () => {
    const tall = { left: 2, top: 10, right: 182, bottom: 230 };
    const client = register(
      new FakeSequencedWatchRunner([
        withRow(tall),
        withRow({ left: 2, top: -80, right: 182, bottom: 140 }),
        withRow(tall),
      ]),
    );
    await watchTapOn(deviceId, { action: "tap", text: "Text entry" }, undefined, {
      timer: timer(),
    });
    expect(actions(client)).toEqual([
      { type: "swipe", direction: "up", distance: WATCH_SCROLL_INTO_VIEW_SWIPE_DISTANCE },
      { type: "swipe", direction: "down", distance: WATCH_SCROLL_INTO_VIEW_SWIPE_DISTANCE },
      { type: "tap", x: 92, y: 117 },
    ]);
  });

  test("sendKeys with a selector reaches a field below the screen edge", async () => {
    const client = register(
      new FakeSequencedWatchRunner([
        withRow({ left: 2, top: 206, right: 182, bottom: 262 }),
        withRow({ left: 2, top: 116, right: 182, bottom: 172 }),
      ]),
    );
    await watchSendKeys(
      deviceId,
      [{ action: "type", text: "hello" }],
      { elementId: "watch-text-entry" },
      { timer: timer() },
    );
    expect(actions(client)).toEqual([
      { type: "swipe", direction: "up", distance: WATCH_SCROLL_INTO_VIEW_SWIPE_DISTANCE },
      { type: "tap", identifier: "watch-text-entry" },
      { type: "type", text: "hello" },
    ]);
  });

  test("swipeOn lookFor counts a partly visible match as found without swiping", async () => {
    const client = register(
      new FakeWatchRunnerClient(withRow({ left: 2, top: 206, right: 182, bottom: 262 })),
    );
    const result = await watchSwipeOn(deviceId, {
      direction: "down",
      lookFor: { elementId: "watch-text-entry" },
    });
    expect(result).toMatchObject({ found: true, scrollIterations: 0 });
    expect(actions(client)).toEqual([]);
  });

  test("swipeOn lookFor keeps swiping past a sliver too thin to tap", async () => {
    register(new FakeWatchRunnerClient(withRow({ left: 2, top: 220, right: 182, bottom: 276 })));
    const result = await watchSwipeOn(deviceId, {
      direction: "up",
      lookFor: { elementId: "watch-text-entry", maxSwipes: 1 },
    });
    expect(result).toMatchObject({ found: false, scrollIterations: 1 });
  });
});
