import type { ObserveResult, ScreenIdentity } from "../../../models";
import { SearchableHierarchy } from "../../utility/SearchableNode";
import { hitEntries, uniqueBySource } from "../../observe/ApplicationWindowCover";
import { deriveIosScreenIdentity } from "../../observe/ios/IosScreenIdentity";
import { deriveAndroidScreenIdentity } from "../../observe/android/AndroidScreenIdentity";

/** What a completed swipe did to the foreground screen, judged from its pre/post observations. */
export interface SwipeNavigationAssessment {
  /** The swipe left the screen it started on instead of only moving content within it. */
  navigated: boolean;
  /** Set only when `navigated`: why the result should not be read as a plain scroll. */
  warning?: string;
}

interface ScreenSignature {
  /** Comparable identity; two signatures of different kinds never compare. */
  kind: string;
  key: string;
  /** Human-readable name for the warning. */
  name: string;
  /** The destination's title, when the platform reports one. */
  title?: string;
}

/**
 * The screen identity minus the parts a scroll can change on its own: focus moves and the keyboard
 * hides while scrolling (`scrollDismissesKeyboard`), and a paged tab view switches `selectedTab`
 * under a horizontal swipe without leaving the screen. What remains (app, route, navigation title,
 * presented sheet or modal) changes only when the app shows a different screen.
 */
function identitySignature(
  identity: ScreenIdentity | undefined,
  origin: string,
): ScreenSignature | undefined {
  if (!identity) {
    return undefined;
  }
  const { bundleId, navigationRoute, navigationTitle, presentation, modalClass } =
    identity.components;
  if (!navigationRoute && !navigationTitle && !presentation && !modalClass) {
    return undefined;
  }
  return {
    kind: `${origin}:${identity.platform}:${identity.source}`,
    key: JSON.stringify([bundleId, navigationRoute, navigationTitle, presentation, modalClass]),
    name: navigationTitle ?? navigationRoute ?? modalClass ?? presentation ?? "",
    title: navigationTitle,
  };
}

function windowSignature(observation: ObserveResult): ScreenSignature | undefined {
  const window = observation.activeWindow;
  if (!window?.appId || !window.activityName) {
    return undefined;
  }
  return {
    kind: "window",
    key: JSON.stringify([window.appId, window.activityName]),
    name: window.activityName,
  };
}

/**
 * iOS: the identity derived from the captured hierarchy, whatever the observation reports. The SDK
 * identity keeps one route for a whole tab's navigation stack (the Playground reports `demos` on
 * both the Demos list and a pushed demo), so only the navigation bar title tells a push apart.
 */
function iosHierarchySignature(observation: ObserveResult): ScreenSignature | undefined {
  return identitySignature(
    deriveIosScreenIdentity(observation.viewHierarchy, observation.screenSize),
    "hierarchy",
  );
}

/**
 * Android: the foreground app window's pane title, derived from the captured hierarchy, for
 * observations that do not report an identity themselves (a cached or replayed capture).
 */
function androidHierarchySignature(observation: ObserveResult): ScreenSignature | undefined {
  return identitySignature(deriveAndroidScreenIdentity(observation.viewHierarchy), "hierarchy");
}

function reportedSignature(observation: ObserveResult): ScreenSignature | undefined {
  return identitySignature(observation.screenIdentity, "reported");
}

function comparableSignatures(
  previous: ObserveResult,
  current: ObserveResult,
  platform: "android" | "ios",
): [ScreenSignature, ScreenSignature] | undefined {
  const signatures =
    platform === "ios"
      ? [iosHierarchySignature, reportedSignature, windowSignature]
      : [reportedSignature, androidHierarchySignature, windowSignature];
  for (const signature of signatures) {
    const before = signature(previous);
    const after = signature(current);
    if (before && after && before.kind === after.kind) {
      return [before, after];
    }
  }
  return undefined;
}

function normalize(text: string): string {
  return text.trim().replace(/\s+/g, " ").toLowerCase();
}

/**
 * A label names the destination when it IS the title, or starts with it at a word boundary: an
 * iOS list row's accessibility label is "Title, subtitle", and a row's text often extends the
 * screen's shorter title ("Forms & Input" opens "Forms").
 */
function labelNamesTitle(label: string, title: string): boolean {
  const normalizedLabel = normalize(label);
  const normalizedTitle = normalize(title);
  if (!normalizedTitle) {
    return false;
  }
  return (
    normalizedLabel === normalizedTitle ||
    (normalizedLabel.startsWith(normalizedTitle) &&
      !/[\p{L}\p{N}]/u.test(normalizedLabel.charAt(normalizedTitle.length)))
  );
}

/** The label of an element under the start point that names the destination screen, if any. */
function startPointLabelNaming(
  previous: ObserveResult,
  start: { x: number; y: number },
  title: string,
): string | undefined {
  if (!previous.viewHierarchy) {
    return undefined;
  }
  const entries = uniqueBySource(new SearchableHierarchy().project(previous.viewHierarchy));
  for (const entry of hitEntries(entries, start)) {
    const label = [entry.displayedLabel, entry.label, ...entry.textFields].find(
      (candidate): candidate is string =>
        typeof candidate === "string" && labelNamesTitle(candidate, title),
    );
    if (label) {
      return label;
    }
  }
  return undefined;
}

/**
 * Judge whether a swipe navigated instead of scrolling (a too-short or mis-mapped swipe lands as a
 * tap and opens the row under it, yet still "changes the screen"). Returns undefined when the two
 * observations carry no comparable screen identity, so callers report nothing rather than guess.
 */
export function assessSwipeNavigation(
  previous: ObserveResult | null | undefined,
  current: ObserveResult | undefined,
  start: { x: number; y: number },
  platform: "android" | "ios",
): SwipeNavigationAssessment | undefined {
  if (!previous || !current) {
    return undefined;
  }
  const signatures = comparableSignatures(previous, current, platform);
  if (!signatures) {
    return undefined;
  }
  const [before, after] = signatures;
  if (before.key === after.key) {
    // One activity hosts every screen of a single-activity (Compose) app, so an unchanged activity
    // does not show the swipe stayed on its screen; only a screen-level identity does.
    return before.kind === "window" ? undefined : { navigated: false };
  }
  const transition = `"${before.name}" to "${after.name}"`;
  const startLabel = after.title ? startPointLabelNaming(previous, start, after.title) : undefined;
  const warning = startLabel
    ? `Swipe navigated from ${transition} instead of scrolling; the new screen is titled like the element under the start point ("${startLabel}"), so the gesture likely registered as a tap. Observe and go back before retrying.`
    : `Swipe navigated from ${transition} instead of scrolling. If you expected a scroll, observe before retrying.`;
  return { navigated: true, warning };
}
