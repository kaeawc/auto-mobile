import type { Element, ElementBounds, ViewHierarchyResult } from "../../models";
import type { SearchableEntry } from "../utility/SearchableNode";
import { IOS_WINDOW_PACKAGE_EXTRA } from "../observe/ios/iosWindowLayer";
import { subtractCover } from "../observe/ApplicationWindowCover";
import { boundsArea } from "../../utils/bounds";
import { TapTargetUnavailableError } from "./tapTargetSupport";

/**
 * Points kept between tapOn's point in a background iPad window and the focused window. iPadOS
 * gives a touch within about 5 pt of the focused window to that window (#19091), and the runner
 * does not treat a tap within 8 pt of it as focusing a background window
 * (`ElementLocator.focusedWindowTouchMargin`), so the point stays well clear of both.
 */
export const IOS_FOCUSED_WINDOW_TOUCH_MARGIN = 24;

/** A tap target in another app's window that the focused iPad window partly covers. */
export interface IosBackgroundWindowCover {
  readonly owner: string;
  readonly focusedPackage: string;
  /** The focused window's frame grown by {@link IOS_FOCUSED_WINDOW_TOUCH_MARGIN}. */
  readonly cover: ElementBounds;
}

function windowPackage(entry: SearchableEntry): string | undefined {
  const extras = (entry.source as { extras?: unknown }).extras;
  if (!extras || typeof extras !== "object" || Array.isArray(extras)) {
    return undefined;
  }
  const value = (extras as Record<string, unknown>)[IOS_WINDOW_PACKAGE_EXTRA];
  return typeof value === "string" ? value : undefined;
}

/** The owner stamped on the merged background window root holding `target`, if any. */
function backgroundWindowOwner(
  nodes: readonly SearchableEntry[],
  target: SearchableEntry,
): string | undefined {
  for (
    let entry: SearchableEntry | undefined = target;
    entry;
    entry = entry.parentIndex === undefined ? undefined : nodes[entry.parentIndex]
  ) {
    const owner = windowPackage(entry);
    if (owner !== undefined) {
      return owner;
    }
  }
  return undefined;
}

/**
 * The focused window's touch area when `target` sits in another app's iPad window merged into the
 * capture (#18830), or undefined for a target in the focused app.
 */
export function iosBackgroundWindowCover(
  hierarchy: ViewHierarchyResult,
  nodes: readonly SearchableEntry[],
  target: SearchableEntry | undefined,
): IosBackgroundWindowCover | undefined {
  const owner = target && backgroundWindowOwner(nodes, target);
  const focusedPackage = hierarchy.packageName;
  if (!owner || !focusedPackage || owner === focusedPackage) {
    return undefined;
  }
  const focused = hierarchy.windows?.find((window) => window.isFocused && window.bounds)?.bounds;
  if (!focused) {
    return undefined;
  }
  const margin = IOS_FOCUSED_WINDOW_TOUCH_MARGIN;
  return {
    owner,
    focusedPackage,
    cover: {
      left: focused.left - margin,
      top: focused.top - margin,
      right: focused.right + margin,
      bottom: focused.bottom + margin,
    },
  };
}

/** The largest part of `bounds` outside the focused window's touch area, or null when none is. */
function uncoveredBackgroundTapBounds(
  bounds: ElementBounds,
  { cover }: IosBackgroundWindowCover,
): ElementBounds | null {
  return (
    subtractCover(bounds, cover).sort((left, right) => boundsArea(right) - boundsArea(left))[0] ??
    null
  );
}

function iosBackgroundWindowCoveredMessage(
  target: Element,
  { owner, focusedPackage }: IosBackgroundWindowCover,
): string {
  const label =
    [target.text, target["content-desc"], target["resource-id"]].find(Boolean) ?? "target";
  return (
    `Target ${JSON.stringify(label)} is in the ${owner} window, which the focused ${focusedPackage} window covers at the target; ` +
    "tap a visible part of that window with tapAt to focus it, or choose another target, then retry tapOn."
  );
}

/**
 * `bounds` narrowed to the part a tap reaches when the target is in another app's iPad window
 * that the focused window partly covers (#19091); unchanged for a focused-app target. Throws
 * when no part of the target is clear of the focused window.
 */
export function clearOfFocusedIosWindow({
  hierarchy,
  nodes,
  targetNode,
  target,
  bounds,
}: {
  hierarchy: ViewHierarchyResult;
  nodes: readonly SearchableEntry[];
  targetNode: SearchableEntry | undefined;
  target: Element;
  bounds: ElementBounds;
}): ElementBounds {
  const cover = iosBackgroundWindowCover(hierarchy, nodes, targetNode);
  if (!cover) {
    return bounds;
  }
  const clear = uncoveredBackgroundTapBounds(bounds, cover);
  if (!clear) {
    throw new TapTargetUnavailableError(
      iosBackgroundWindowCoveredMessage(target, cover),
      "no-visible-tap-area",
    );
  }
  return clear;
}
