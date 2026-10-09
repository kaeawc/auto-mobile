import { describe, expect, test } from "bun:test";
import { assessSwipeNavigation } from "../../../../src/features/action/swipeon/swipeNavigation";
import { SearchableHierarchy } from "../../../../src/features/utility/SearchableNode";
import type { ObserveResult } from "../../../../src/models";
import demosEnvelope from "../../../fixtures/ios/ios-demos-observe-full-sdk-nodes-not-injected.json";
import formsCapture from "../../../fixtures/observe-output/ios-keyboard-states/ios-keyboard-visible.raw.json";
import nestedBeforeFocus from "../../../fixtures/ios/nested-selection/cart-a-item-42-before-focus-tap.json";
import nestedFocused from "../../../fixtures/ios/nested-selection/cart-a-item-42-focused-keyboard-shift.json";
import nestedScrolled from "../../../fixtures/ios/nested-selection/scroll-cart-duplicate-container-id.json";
import androidScrollBefore from "../../../fixtures/observe/diff/scroll-before.json";
import androidScrollAfter from "../../../fixtures/observe/diff/scroll-after.json";
import launcherHome from "../../../fixtures/android-launcher/launcher-home-emulator-5602.json";
import playgroundMain from "../../../fixtures/android-enabled/playground-disabled-control-api36.json";
import playgroundTapScreen from "../../../fixtures/android-overlay-window/app-layer-overlay-over-playground.raw.json";
import { deriveSdkNavigationScreenIdentity } from "../../../../src/features/observe/sdkScreenIdentity";

// Captured on an iPhone 17 sim: the Playground Demos list (SDK identity route "demos").
const demosList = JSON.parse(demosEnvelope.content[0].text) as ObserveResult;
// Captured on the same sim after opening the "Forms & Input" row (navigation title "Forms").
const formsScreen = formsCapture as unknown as ObserveResult;

const demosRows = new SearchableHierarchy().project(demosList.viewHierarchy!);

/** Center of the captured Demos row whose label starts with `title`. */
function rowCenter(title: string): { x: number; y: number } {
  const bounds = demosRows.find((row) => row.label?.startsWith(`${title}, `))!.bounds!;
  return { x: (bounds.left + bounds.right) / 2, y: (bounds.top + bounds.bottom) / 2 };
}
const formsRowCenter = rowCenter("Forms & Input");
const alertsRowCenter = rowCenter("Alerts & Sheets");

const PLAYGROUND = "dev.jasonpearson.automobile.playground";

/**
 * A captured Playground observation as ObserveScreen reports it when the app's SDK last sent
 * `destination` (the shape of Navigation3Adapter.TrackNavigation).
 */
function withSdkRoute(
  source: unknown,
  destination: string,
  arguments_: Record<string, string> = {},
): ObserveResult {
  return {
    ...(structuredClone(source) as ObserveResult),
    screenIdentity: deriveSdkNavigationScreenIdentity("android", PLAYGROUND, {
      destination,
      arguments: arguments_,
      metadata: {},
    }),
  };
}

/** A captured Playground observation whose app window carries Compose `paneTitle` semantics. */
function withPaneTitle(source: unknown, windowId: number, paneTitle: string): ObserveResult {
  const observation = structuredClone(source) as ObserveResult;
  const roots = observation.viewHierarchy!.hierarchy.node as Array<Record<string, unknown>>;
  const root = roots.find((node) => node.windowId === windowId)!;
  const children = root.node as Array<Record<string, unknown>> | Record<string, unknown>;
  (Array.isArray(children) ? children[0]! : children)["pane-title"] = paneTitle;
  return observation;
}

describe("assessSwipeNavigation", () => {
  test("iOS swipe that opened the row under its start point warns it acted as a tap", () => {
    const assessment = assessSwipeNavigation(demosList, formsScreen, formsRowCenter, "ios");
    expect(assessment?.navigated).toBe(true);
    expect(assessment?.warning).toContain('Swipe navigated from "Demos" to "Forms"');
    expect(assessment?.warning).toContain(
      'under the start point ("Forms & Input, Text fields, pickers, and toggles")',
    );
    expect(assessment?.warning).toContain("likely registered as a tap");
  });

  test("iOS navigation away from a start point on another row keeps the generic warning", () => {
    const assessment = assessSwipeNavigation(demosList, formsScreen, alertsRowCenter, "ios");
    expect(assessment?.navigated).toBe(true);
    expect(assessment?.warning).toBe(
      'Swipe navigated from "Demos" to "Forms" instead of scrolling. If you expected a scroll, observe before retrying.',
    );
  });

  test("iOS scroll within the same screen is not navigation", () => {
    expect(
      assessSwipeNavigation(
        nestedBeforeFocus as unknown as ObserveResult,
        nestedScrolled as unknown as ObserveResult,
        { x: 200, y: 400 },
        "ios",
      ),
    ).toEqual({ navigated: false });
  });

  test("iOS focus and keyboard changes alone are not navigation", () => {
    expect(
      assessSwipeNavigation(
        nestedFocused as unknown as ObserveResult,
        nestedBeforeFocus as unknown as ObserveResult,
        { x: 200, y: 400 },
        "ios",
      ),
    ).toEqual({ navigated: false });
  });

  test("Android scroll within one activity and no screen identity reports nothing", () => {
    // A single-activity Compose app keeps its activity across screens, so the activity alone
    // cannot show the swipe stayed put.
    expect(
      assessSwipeNavigation(
        androidScrollBefore as unknown as ObserveResult,
        androidScrollAfter as unknown as ObserveResult,
        { x: 540, y: 1200 },
        "android",
      ),
    ).toBeUndefined();
  });

  test("Android Compose navigation within MainActivity without a screen signal reports nothing", () => {
    // Captured Playground Tap demo and design-system screens: both MainActivity, no pane title.
    expect(
      assessSwipeNavigation(
        playgroundTapScreen as unknown as ObserveResult,
        playgroundMain as unknown as ObserveResult,
        { x: 540, y: 1200 },
        "android",
      ),
    ).toBeUndefined();
  });

  test("Android Compose navigation within MainActivity is detected from the SDK route", () => {
    const assessment = assessSwipeNavigation(
      withSdkRoute(playgroundTapScreen, "HomeDestination", { tab: "Demos" }),
      withSdkRoute(playgroundMain, "DemoContrastDestination"),
      { x: 540, y: 1200 },
      "android",
    );
    expect(assessment?.navigated).toBe(true);
    expect(assessment?.warning).toBe(
      'Swipe navigated from "HomeDestination" to "DemoContrastDestination" instead of scrolling. If you expected a scroll, observe before retrying.',
    );
  });

  test("Android swipe that kept the SDK route is not navigation, even across tabs", () => {
    expect(
      assessSwipeNavigation(
        withSdkRoute(playgroundTapScreen, "HomeDestination", { tab: "Demos" }),
        withSdkRoute(playgroundMain, "HomeDestination", { tab: "Discover" }),
        { x: 540, y: 1200 },
        "android",
      ),
    ).toEqual({ navigated: false });
  });

  test("Android Compose navigation is detected from the app window's pane title", () => {
    const assessment = assessSwipeNavigation(
      withPaneTitle(playgroundTapScreen, 150, "Tap"),
      withPaneTitle(playgroundMain, 710, "Design system"),
      { x: 540, y: 1200 },
      "android",
    );
    expect(assessment?.navigated).toBe(true);
    expect(assessment?.warning).toContain('from "Tap" to "Design system"');
  });

  test("Android swipe that changed the foreground activity reports navigation", () => {
    const assessment = assessSwipeNavigation(
      launcherHome as unknown as ObserveResult,
      playgroundMain as unknown as ObserveResult,
      { x: 1038, y: 1076 },
      "android",
    );
    expect(assessment?.navigated).toBe(true);
    expect(assessment?.warning).toContain(
      'from "com.google.android.apps.nexuslauncher.NexusLauncherActivity" to "dev.jasonpearson.automobile.playground.MainActivity"',
    );
  });

  test("no comparable screen identity reports nothing", () => {
    const bare = { ...demosList, viewHierarchy: undefined, screenIdentity: undefined };
    expect(assessSwipeNavigation(bare, formsScreen, { x: 0, y: 0 }, "ios")).toBeUndefined();
    expect(assessSwipeNavigation(null, formsScreen, { x: 0, y: 0 }, "ios")).toBeUndefined();
    expect(assessSwipeNavigation(demosList, undefined, { x: 0, y: 0 }, "ios")).toBeUndefined();
  });
});
