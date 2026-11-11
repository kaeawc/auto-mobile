import { resolveViewHierarchyForSearch } from "../utility/viewHierarchySearch";
import type { ElementParser } from "../../utils/interfaces/ElementParser";
import { xrForegroundApp } from "../xr/xrForegroundApp";
import type { ObserveResult, ViewHierarchyResult } from "../../models";
import type { SearchableEntry } from "../utility/SearchableNode";

/** Output-only visibility: retain raw nodes for action resolution, including home-space chrome. */
export function xrVisibleElements(
  entries: readonly SearchableEntry[],
  capture: ViewHierarchyResult,
  parser: ElementParser,
  {
    platform,
    androidXr,
    foreground,
  }: {
    platform: "android" | "ios";
    androidXr?: boolean;
    foreground?: Pick<ObserveResult, "activeWindow" | "backStack">;
  },
): readonly SearchableEntry[] {
  if (platform !== "android" || !androidXr) {
    return entries;
  }
  const hierarchy = resolveViewHierarchyForSearch(capture) ?? capture;
  const packageName = foreground ? xrForegroundApp(foreground) : undefined;
  if (
    !packageName ||
    packageName.startsWith("com.android.systemui") ||
    !hierarchy.windows?.some((window) => window.type === 1 && window.packageName === packageName)
  ) {
    return entries;
  }
  const systemWindows = new Set(
    hierarchy.windows
      .filter((window) => window.packageName?.startsWith("com.android.systemui"))
      .map((window) => window.id),
  );
  const systemRoots = new Set(
    hierarchy.windows
      .filter((window) => window.packageName?.startsWith("com.android.systemui"))
      .flatMap((window) =>
        parser.extractWindowRootGroups({ hierarchy: {}, windows: [window] }).flat(),
      ),
  );
  const owners = new Map<number, boolean>();
  return entries.filter((entry) => {
    const owner =
      systemRoots.has(entry.source) ||
      (typeof entry.properties.windowId === "number" &&
        systemWindows.has(entry.properties.windowId)) ||
      entry.nativeId?.startsWith("com.android.systemui") === true ||
      (entry.parentIndex !== undefined && owners.get(entry.parentIndex) === true);
    owners.set(entry.index, owner);
    return !(entry.properties["visible-to-user"] === false && owner);
  });
}
