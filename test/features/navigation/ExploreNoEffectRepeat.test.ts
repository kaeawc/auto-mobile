import { afterEach, beforeAll, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { readFileSync } from "node:fs";
import type { FocusNavigateOptions } from "../../../src/features/action/FocusNavigate";
import { Explore } from "../../../src/features/navigation/Explore";
import { getSafeExplorationCandidates } from "../../../src/features/navigation/ExploreDryRun";
import {
  ExploreNoEffectElements,
  exploreScreenIdentity,
} from "../../../src/features/navigation/ExploreNoEffectElements";
import { AndroidCtrlProxyClient } from "../../../src/features/observe/android";
import { DefaultElementParser } from "../../../src/features/utility/ElementParser";
import type {
  BootedDevice,
  ObserveResult,
  ViewHierarchyNode,
  ViewHierarchyResult,
} from "../../../src/models";
import { FakeAdbExecutor } from "../../fakes/FakeAdbExecutor";
import { FakeNavigationGraphManager } from "../../fakes/FakeNavigationGraphManager";
import { FakeObserveScreen } from "../../fakes/FakeObserveScreen";
import { FakeTimer } from "../../fakes/FakeTimer";
import { createObserveResultForTest } from "../observe/flatHierarchyBuilders";

/**
 * #17442: on a TV app without the SDK (no navigation-graph screen), explore
 * selected the same element every round although its select changed nothing but
 * open the soft keyboard, and returned with the keyboard still shown. The screen
 * is the real Playground + Gboard capture (API 36) also used for #17377: app
 * window 548 under IME window 550 (see test/fixtures/android-focus/README.md).
 */
const APP = "dev.jasonpearson.automobile.playground";
const IME_WINDOW_ID = 550;
const device: BootedDevice = { deviceId: "emulator-5554", name: "TV", platform: "android" };

const capturedRaw = readFileSync(
  new URL("../../fixtures/android-ime-window/playground-gboard-api36.json", import.meta.url),
  "utf8",
);

function imeCapture(): ViewHierarchyResult {
  return JSON.parse(capturedRaw);
}

/** The same capture once back hid the keyboard: its window and root are gone. */
function appOnlyCapture(): ViewHierarchyResult {
  const capture = imeCapture();
  const roots = capture.hierarchy.node as Array<ViewHierarchyNode & { windowId?: number }>;
  capture.hierarchy.node = roots.find((root) => root.windowId !== IME_WINDOW_ID);
  capture.windows = capture.windows?.filter((window) => window.id !== IME_WINDOW_ID);
  return capture;
}

function observationOf(viewHierarchy: ViewHierarchyResult): ObserveResult {
  return createObserveResultForTest({ viewHierarchy });
}

/**
 * A screen whose every D-pad select opens the keyboard and changes nothing else;
 * a back press (adb `keyevent 4`) hides the keyboard.
 */
class KeyboardOnlyScreen extends FakeObserveScreen {
  keyboardShown = false;
  private handledBacks = 0;

  constructor(private readonly adb: FakeAdbExecutor) {
    super();
    this.setObserveResult(() => {
      this.hideOnBack();
      return observationOf(this.keyboardShown ? imeCapture() : appOnlyCapture());
    });
  }

  hideOnBack(): void {
    const backs = this.adb
      .getExecutedCommands()
      .filter((command) => command.endsWith("keyevent 4")).length;
    if (backs > this.handledBacks) {
      this.handledBacks = backs;
      this.keyboardShown = false;
    }
  }
}

describe("explore over a screen its selects do not change (#17442)", () => {
  let adb: FakeAdbExecutor;
  let selections: FocusNavigateOptions[];
  let screen: KeyboardOnlyScreen;
  let timer: FakeTimer;
  let ctrlProxySpy: ReturnType<typeof spyOn>;

  beforeAll(async () => {
    // One untimed run over both captures warms the parser and explore paths.
    setUp();
    try {
      await explore().execute({ packageName: APP, maxInteractions: 2 });
    } finally {
      ctrlProxySpy.mockRestore();
    }
  });

  beforeEach(setUp);

  function setUp(): void {
    selections = [];
    adb = new FakeAdbExecutor();
    screen = new KeyboardOnlyScreen(adb);
    timer = new FakeTimer();
    timer.enableAutoAdvance();
    ctrlProxySpy = spyOn(AndroidCtrlProxyClient, "getInstance").mockReturnValue({
      requestGlobalAction: async () => ({ success: false, error: "unavailable" }),
    } as never);
  }

  afterEach(() => {
    ctrlProxySpy.mockRestore();
  });

  function explore(): Explore {
    const graph = new FakeNavigationGraphManager();
    graph.setCurrentAppId(APP);
    const instance = new Explore(device, adb, timer, {
      navigationManager: graph,
      inputMode: async () => "dpad",
      focusNavigatorFactory: () => ({
        execute: async (options) => {
          selections.push(options);
          screen.keyboardShown = true;
          return { success: true, status: "focused", steps: 1, path: [], selected: true };
        },
      }),
    });
    instance.observeScreen = screen;
    return instance;
  }

  const selected = () => selections.map((options) => JSON.stringify(options.until));

  test("never re-selects an element whose select left the screen unchanged", async () => {
    await explore().execute({ packageName: APP, maxInteractions: 3 });

    expect(selections).toHaveLength(3);
    expect(new Set(selected()).size).toBe(3);
  });

  test("hides the keyboard its last select opened before returning", async () => {
    await explore().execute({ packageName: APP, maxInteractions: 2 });

    expect(selections).toHaveLength(2);
    screen.hideOnBack();
    expect(screen.keyboardShown).toBe(false);
  });
});

describe("ExploreNoEffectElements", () => {
  const hierarchy = appOnlyCapture();
  const candidates = getSafeExplorationCandidates(
    observationOf(hierarchy),
    new DefaultElementParser(),
  );

  test("the captured screen offers several candidates", () => {
    expect(candidates.length).toBeGreaterThan(2);
  });

  const identity = exploreScreenIdentity(null, candidates, hierarchy);

  test("a changed screen does not mark the element", () => {
    const tracker = new ExploreNoEffectElements();
    tracker.begin(identity, candidates[0]);
    tracker.settle(exploreScreenIdentity(null, candidates.slice(1), hierarchy));

    expect(tracker.withEffect(candidates, identity)).toEqual(candidates);
  });

  test("an unchanged screen excludes the element there and nowhere else", () => {
    const tracker = new ExploreNoEffectElements();
    tracker.begin(identity, candidates[0]);
    tracker.settle(exploreScreenIdentity(null, candidates, hierarchy));

    expect(tracker.withEffect(candidates, identity)).toEqual(candidates.slice(1));
    const settings = exploreScreenIdentity("Settings", candidates, hierarchy);
    expect(tracker.withEffect(candidates, settings)).toEqual(candidates);
  });

  test("an interaction is settled once", () => {
    const tracker = new ExploreNoEffectElements();
    tracker.begin(identity, candidates[0]);
    tracker.settle(exploreScreenIdentity(null, candidates.slice(1), hierarchy));
    tracker.settle(identity);

    expect(tracker.withEffect(candidates, identity)).toEqual(candidates);
  });
});
