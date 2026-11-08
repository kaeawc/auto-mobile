import type { ObserveResult } from "../../../models";
import type { CarAppHostRenderedUi } from "../../../models/CarAppTemplates";
import { childrenOf, type ViewHierarchyNode } from "../../../models/ViewHierarchyResult";

export type { CarAppHostRenderedUi };

/** The AndroidX activity a Car App Library app declares; the car host draws its templates into it. */
export const CAR_APP_ACTIVITY = "androidx.car.app.activity.CarAppActivity";

/** The AAOS templates host that renders Car App Library templates (#16744). */
export const CAR_APP_TEMPLATES_HOST_PACKAGE = "com.google.android.apps.automotive.templates.host";

const HOST_RESOURCE_ID_PREFIX = `${CAR_APP_TEMPLATES_HOST_PACKAGE}:id/`;

type HostRenderedUiInput = Pick<ObserveResult, "activeWindow" | "viewHierarchy">;

function nodeResourceId(node: ViewHierarchyNode): unknown {
  return node["resource-id"] ?? node.$?.["resource-id"];
}

function hasHostResourceId(root: ViewHierarchyNode | undefined): boolean {
  const pending: ViewHierarchyNode[] = root ? [root] : [];
  for (let node = pending.pop(); node; node = pending.pop()) {
    const id = nodeResourceId(node);
    if (typeof id === "string" && id.startsWith(HOST_RESOURCE_ID_PREFIX)) {
      return true;
    }
    pending.push(...childrenOf(node));
  }
  return false;
}

/** The host-rendered marker for an observation, or `undefined` when neither signal matches. */
export function detectCarAppHostRenderedUi(
  result: HostRenderedUiInput,
): CarAppHostRenderedUi | undefined {
  if (hasHostResourceId(result.viewHierarchy?.hierarchy?.node)) {
    return { kind: "carAppLibrary", hostPackage: CAR_APP_TEMPLATES_HOST_PACKAGE };
  }
  return result.activeWindow?.activityName === CAR_APP_ACTIVITY
    ? { kind: "carAppLibrary" }
    : undefined;
}

/** Whether `observe` marked the foreground UI as Car App Library templates drawn by the host. */
export function isCarAppHostRendered(result: Pick<ObserveResult, "automotive">): boolean {
  return result.automotive?.hostRenderedUi?.kind === "carAppLibrary";
}

/**
 * Set or clear `automotive.hostRenderedUi` from the current active window and hierarchy. A no-op
 * without an `automotive` block, so non-automotive observations stay byte for byte unchanged.
 */
export function applyCarAppHostRenderedUi(result: ObserveResult): void {
  const automotive = result.automotive;
  if (!automotive) {
    return;
  }
  const hostRenderedUi = detectCarAppHostRenderedUi(result);
  if (hostRenderedUi) {
    automotive.hostRenderedUi = hostRenderedUi;
  } else {
    delete automotive.hostRenderedUi;
  }
}
