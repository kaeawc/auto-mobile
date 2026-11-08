import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { readFileSync } from "node:fs";
import type { FocusNavigateOptions } from "../../../src/features/action/FocusNavigate";
import { Explore } from "../../../src/features/navigation/Explore";
import { getSafeExplorationCandidates } from "../../../src/features/navigation/ExploreDryRun";
import type { ExploreResult } from "../../../src/features/navigation/ExploreTypes";
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
 * #17377: a search field took focus, the soft keyboard opened over the app, and
 * explore spent the run selecting the keyboard's `key_pos_*` keys. The capture is
 * the real Playground + Gboard read (API 36): app window 548 under IME window 550
 * (`type: 2`), whose roots carry `windowId` (see test/fixtures/android-focus/README.md).
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

/** Root nodes of a capture whose `hierarchy.node` is the list of window roots. */
function windowRoots(
  capture: ViewHierarchyResult,
): Array<ViewHierarchyNode & { windowId?: number }> {
  const roots = capture.hierarchy.node;
  if (!Array.isArray(roots)) {
    throw new Error("expected the capture's window roots under hierarchy.node");
  }
  return roots;
}

/** The same capture after back hid the keyboard: its window and root are gone. */
function appOnlyCapture(): ViewHierarchyResult {
  const capture = imeCapture();
  capture.hierarchy.node = windowRoots(capture).find((root) => root.windowId !== IME_WINDOW_ID);
  capture.windows = capture.windows?.filter((window) => window.id !== IME_WINDOW_ID);
  return capture;
}

/** Every resource-id inside the IME window of the capture. */
function imeWindowResourceIds(): Set<string> {
  const ids = new Set<string>();
  const imeRoot = windowRoots(imeCapture()).find((root) => root.windowId === IME_WINDOW_ID);
  new DefaultElementParser().traverseNode(imeRoot, (node: ViewHierarchyNode) => {
    if (typeof node["resource-id"] === "string") {
      ids.add(node["resource-id"]);
    }
  });
  return ids;
}

const imeIds = imeWindowResourceIds();

function observationOf(viewHierarchy: ViewHierarchyResult): ObserveResult {
  return createObserveResultForTest({ viewHierarchy });
}

describe("explore with the soft keyboard open (#17377)", () => {
  test("the captured IME window carries keyboard keys to exclude", () => {
    expect(imeIds.has("com.google.android.inputmethod.latin:id/key_pos_0_0")).toBe(true);
  });

  test("never offers an IME-window element as a candidate", () => {
    const candidates = getSafeExplorationCandidates(
      observationOf(imeCapture()),
      new DefaultElementParser(),
    );
    const ids = candidates.map((element) => element["resource-id"]).filter(Boolean);
    expect(ids.filter((id) => imeIds.has(id as string))).toEqual([]);
    const labels = candidates.map((element) => element.text ?? element["content-desc"]);
    expect(labels).toContain("Basic Text Field");
    expect(labels).not.toContain("Clipboard");
  });

  let adb: FakeAdbExecutor;
  let selections: FocusNavigateOptions[];
  let graph: FakeNavigationGraphManager;
  let timer: FakeTimer;
  let ctrlProxySpy: ReturnType<typeof spyOn>;

  beforeEach(() => {
    adb = new FakeAdbExecutor();
    selections = [];
    graph = new FakeNavigationGraphManager();
    // The graph's current app is the one explored before: the IME's host, Settings.
    graph.setCurrentAppId("com.android.settings");
    timer = new FakeTimer();
    timer.enableAutoAdvance();
    ctrlProxySpy = spyOn(AndroidCtrlProxyClient, "getInstance").mockReturnValue({
      requestGlobalAction: async () => ({ success: false, error: "unavailable" }),
    } as never);
  });

  afterEach(() => {
    ctrlProxySpy.mockRestore();
  });

  const backPresses = () =>
    adb.getExecutedCommands().filter((command) => command.endsWith("keyevent 4")).length;

  function exploreOver(screen: FakeObserveScreen): Explore {
    const explore = new Explore(device, adb, timer, {
      navigationManager: graph,
      inputMode: async () => "dpad",
      focusNavigatorFactory: () => ({
        execute: async (options) => {
          selections.push(options);
          return { success: true, status: "focused", steps: 1, path: [], selected: true };
        },
      }),
    });
    explore.observeScreen = screen;
    return explore;
  }

  test("presses back to hide the keyboard, then explores the app beneath it", async () => {
    const screen = new FakeObserveScreen();
    screen.setObserveResult(() =>
      observationOf(backPresses() > 0 ? appOnlyCapture() : imeCapture()),
    );

    const result = (await exploreOver(screen).execute({
      packageName: APP,
      maxInteractions: 1,
    })) as ExploreResult;

    expect(backPresses()).toBe(1);
    expect(selections).toHaveLength(1);
    expect(imeIds.has(selections[0].until.resourceId ?? "")).toBe(false);
    expect(result.navigationGraph.appId).toBe(APP);
  });

  test("a keyboard back does not hide is pressed once, and its keys are still skipped", async () => {
    const screen = new FakeObserveScreen();
    screen.setObserveResult(() => observationOf(imeCapture()));

    await exploreOver(screen).execute({ packageName: APP, maxInteractions: 1 });

    expect(backPresses()).toBe(1);
    expect(selections).toHaveLength(1);
    expect(imeIds.has(selections[0].until.resourceId ?? "")).toBe(false);
  });
});
