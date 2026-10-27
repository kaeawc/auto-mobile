import type { ViewHierarchyResult } from "../../models";

/**
 * How many animations CtrlProxy's prototype window reports as still settling (#15114).
 *
 * The device publishes `prototypeMotion: {active, loops}` on its own prototype window
 * (`prototype_window_metadata_v1`). `active` counts fades, slides, style animations and page
 * scrolls that will finish; `loops` counts intentional infinite animations such as a shimmer and is
 * ignored here, because waiting for a loop would only ever time out. An older APK, a capture
 * without windows and a malformed count all read as settled, as for `prototypeOpaque`.
 */
export function prototypeMotionActive(
  viewHierarchy: Pick<ViewHierarchyResult, "windows"> | null | undefined,
): number {
  let active = 0;
  for (const window of viewHierarchy?.windows ?? []) {
    const count = window.prototypeMotion?.active;
    if (typeof count === "number" && Number.isFinite(count) && count > 0) {
      active += count;
    }
  }
  return active;
}
