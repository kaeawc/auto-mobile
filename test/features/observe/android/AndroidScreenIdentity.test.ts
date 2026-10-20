import { describe, expect, test } from "bun:test";
import { deriveAndroidScreenIdentity } from "../../../../src/features/observe/android/AndroidScreenIdentity";
import { deriveSdkNavigationScreenIdentity } from "../../../../src/features/observe/sdkScreenIdentity";
import type { ObserveResult, ViewHierarchyNode, ViewHierarchyResult } from "../../../../src/models";
import { isViewHierarchyResult } from "../../../../src/models/ViewHierarchyResult";
import { observeResultFromFixture } from "../../../helpers/observeFixture";
import playgroundCapture from "../../../fixtures/android-enabled/playground-disabled-control-api36.json";
import prototypeCapture from "../../../fixtures/android-overlay-window/app-layer-overlay-over-playground.raw.json";
import imeCapture from "../../../fixtures/android-ime-window/playground-gboard-api36.json";

const PLAYGROUND = "dev.jasonpearson.automobile.playground";

/** A fresh copy of a captured observation, so a test can annotate it without leaking. */
function capture(source: unknown): ObserveResult {
  return observeResultFromFixture(structuredClone(source), "android-screen-identity");
}

/** A fresh copy of a captured bare hierarchy (no observation envelope), validated at the boundary. */
function captureHierarchy(source: unknown): ViewHierarchyResult {
  const hierarchy = structuredClone(source);
  if (!isViewHierarchyResult(hierarchy)) {
    throw new Error("fixture is not a captured ViewHierarchyResult");
  }
  return hierarchy;
}

/** The captured root of window `windowId`. */
function windowRoot(
  observation: Pick<ObserveResult, "viewHierarchy">,
  windowId: number,
): ViewHierarchyNode {
  const roots = observation.viewHierarchy!.hierarchy.node as ViewHierarchyNode[];
  return roots.find(
    (root) => Object.getOwnPropertyDescriptor(root, "windowId")?.value === windowId,
  )!;
}

/** The first child of the captured window root: where Compose would attach `paneTitle` semantics. */
function firstChild(root: ViewHierarchyNode): ViewHierarchyNode {
  const children = root.node!;
  return Array.isArray(children) ? children[0]! : children;
}

// Shape of Navigation3Adapter.TrackNavigation for the Playground's HomeDestination entry.
const homeDemosIdentity = deriveSdkNavigationScreenIdentity("android", PLAYGROUND, {
  destination: "HomeDestination",
  arguments: { tab: "Demos" },
  metadata: {},
});

describe("deriveAndroidScreenIdentity", () => {
  test("a captured Playground screen without SDK route or app pane title reports nothing", () => {
    // The capture's only pane title is the SystemUI status bar's "Status bar" (window type 3).
    const observation = capture(playgroundCapture);
    expect(JSON.stringify(observation.viewHierarchy)).toContain('"pane-title":"Status bar"');
    expect(deriveAndroidScreenIdentity(observation.viewHierarchy)).toBeUndefined();
  });

  test("the SDK route of the captured app is the identity", () => {
    const observation = capture(playgroundCapture);
    expect(deriveAndroidScreenIdentity(observation.viewHierarchy, homeDemosIdentity)).toEqual({
      platform: "android",
      source: "sdk",
      confidence: "high",
      key: JSON.stringify([
        ["bundle", PLAYGROUND],
        ["route", "HomeDestination"],
        ["tab", "Demos"],
      ]),
      components: {
        bundleId: PLAYGROUND,
        navigationRoute: "HomeDestination",
        selectedTab: "Demos",
      },
    });
  });

  test("another app's SDK route never names the captured app's screen", () => {
    const observation = capture(playgroundCapture);
    const other = deriveSdkNavigationScreenIdentity("android", "com.example.other", {
      destination: "HomeDestination",
    });
    expect(deriveAndroidScreenIdentity(observation.viewHierarchy, other)).toBeUndefined();
  });

  test("a pane title in the foreground app window names the screen", () => {
    const observation = capture(playgroundCapture);
    firstChild(windowRoot(observation, 710))["pane-title"] = "Design system";
    expect(deriveAndroidScreenIdentity(observation.viewHierarchy)).toEqual({
      platform: "android",
      source: "heuristic",
      confidence: "medium",
      key: JSON.stringify([
        ["package", PLAYGROUND],
        ["paneTitle", "Design system"],
      ]),
      components: { bundleId: PLAYGROUND, navigationTitle: "Design system" },
    });
  });

  test("an SDK route outranks the pane title", () => {
    const observation = capture(playgroundCapture);
    firstChild(windowRoot(observation, 710))["pane-title"] = "Design system";
    expect(deriveAndroidScreenIdentity(observation.viewHierarchy, homeDemosIdentity)?.source).toBe(
      "sdk",
    );
  });

  test("pane titles in AutoMobile's prototype window or the IME window are ignored", () => {
    const prototype = capture(prototypeCapture);
    firstChild(windowRoot(prototype, 174))["pane-title"] = "Prototype";
    expect(deriveAndroidScreenIdentity(prototype.viewHierarchy)).toBeUndefined();

    const ime = { viewHierarchy: captureHierarchy(imeCapture) };
    firstChild(windowRoot(ime, 550))["pane-title"] = "Keyboard";
    expect(deriveAndroidScreenIdentity(ime.viewHierarchy)).toBeUndefined();
  });

  test("a capture without window metadata reports nothing", () => {
    const observation = capture(playgroundCapture);
    firstChild(windowRoot(observation, 710))["pane-title"] = "Design system";
    observation.viewHierarchy!.windows = undefined;
    expect(deriveAndroidScreenIdentity(observation.viewHierarchy)).toBeUndefined();
  });
});
