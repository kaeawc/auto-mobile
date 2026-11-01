import { prototypeHiddenWarning, type PrototypeHiddenReason } from "./prototypeHidden";
import type { PrototypeSpec } from "./prototypeSpec";
import type { ViewHierarchyResult } from "../../models";
import { requestedPrototypeWindowOptions } from "./prototypeWindowOptions";
import type { HierarchyCapture } from "../observe/HierarchyCapture";
import { hasOwnPrototype } from "../observe/hierarchyLayer";
import { defaultTimer, type Timer } from "../../utils/SystemTimer";
import { logger } from "../../utils/logger";

const APP_LAYER_VISIBILITY_CAPTURES = 3;
const APP_LAYER_VISIBILITY_RETRY_MS = 250;
const APP_LAYER_VISIBILITY_CAPTURE_TIMEOUT_MS = 1000;

interface AppLayerNotVisible {
  visible: false;
  notVisibleReason: "no_prototype_window_on_screen" | PrototypeHiddenReason;
  warning: string;
}

/** Best-effort confirmation after dispatch; cancellation keeps the successful, dispatched show. */
export async function confirmPrototypeAppLayerVisibility(
  capture: HierarchyCapture,
  timer: Timer,
  displayId: number | undefined,
  { signal, hiddenReason }: { signal?: AbortSignal; hiddenReason?: PrototypeHiddenReason } = {},
): Promise<AppLayerNotVisible | undefined> {
  try {
    for (let attempt = 0; attempt < APP_LAYER_VISIBILITY_CAPTURES; attempt++) {
      signal?.throwIfAborted();
      const snapshot = await capture.capture({
        freshness: "fresh",
        displayId,
        timeoutMs: APP_LAYER_VISIBILITY_CAPTURE_TIMEOUT_MS,
        signal,
      });
      signal?.throwIfAborted();
      if (hasOwnPrototype(snapshot.hierarchy)) {
        return undefined;
      }
      if (attempt < APP_LAYER_VISIBILITY_CAPTURES - 1) {
        await timer.sleep(APP_LAYER_VISIBILITY_RETRY_MS);
        continue;
      }
      return decideAppLayerVisibility(snapshot.hierarchy, hiddenReason);
    }
  } catch (error) {
    if (signal?.aborted) {
      // Post-dispatch cancellation keeps device success; absence was not confirmed.
      logger.debug("App-layer visibility confirmation cancelled; the dispatched show is retained");
      return undefined;
    }
    logger.warn("Could not confirm Android app-layer prototype visibility", error);
    return undefined;
  }
  return undefined;
}

function decideAppLayerVisibility(
  hierarchy: ViewHierarchyResult,
  hiddenReason?: PrototypeHiddenReason,
): AppLayerNotVisible | undefined {
  if (!hierarchy.prototypeHiddenReason && hasNoAppLayerVisibilityEvidence(hierarchy)) {
    return undefined;
  }
  const reason = hierarchy.prototypeHiddenReason ?? hiddenReason;
  if (reason) {
    return {
      visible: false,
      notVisibleReason: reason,
      warning: prototypeHiddenWarning(reason, hierarchy.packageName),
    };
  }
  return appLayerNotVisible(hierarchy);
}

function hasNoAppLayerVisibilityEvidence(hierarchy: ViewHierarchyResult): boolean {
  return (
    hierarchy.prototypeSuspended === true ||
    !hierarchy.windows?.length ||
    hierarchy.ctrlProxyIncomplete === true ||
    hierarchy.hierarchy.error !== undefined
  );
}

function appLayerNotVisible(hierarchy: ViewHierarchyResult): AppLayerNotVisible {
  const pkg = hierarchy.packageName ? ` (${hierarchy.packageName})` : "";
  return {
    visible: false,
    notVisibleReason: "no_prototype_window_on_screen",
    warning: `The prototype was shown with window.layer "app" but no prototype window is on screen. The app in front${pkg} most likely hides app-layer windows drawn over it (system apps such as Settings do); a locked device hides it too. Until it is visible, layer "prototype" calls will report that no prototype is showing. Show it again without window.layer (the default layer draws over every app) or over a different app, or dismiss it.`,
  };
}

/** Surface device blocking for any Android show; confirm app-layer visibility after dispatch. */
export async function prototypeAppLayerVisibilityOutput(request: {
  android: boolean;
  hiddenReason?: PrototypeHiddenReason;
  action: string;
  success: boolean;
  spec: PrototypeSpec;
  superseded: () => boolean;
  capture: () => HierarchyCapture;
  timer?: Timer;
  displayId?: number;
  signal?: AbortSignal;
}): Promise<Partial<AppLayerNotVisible>> {
  if (!request.android || request.action !== "show" || !request.success || request.superseded()) {
    return {};
  }
  if (request.hiddenReason === "device_blocked") {
    return {
      visible: false,
      notVisibleReason: "device_blocked",
      warning: prototypeHiddenWarning("device_blocked"),
    };
  }
  if (!requestedPrototypeWindowOptions(request.spec).appLayer) {
    return {};
  }
  const visibility = await confirmPrototypeAppLayerVisibility(
    request.capture(),
    request.timer ?? defaultTimer,
    request.displayId,
    { signal: request.signal, hiddenReason: request.hiddenReason },
  );
  return request.superseded() ? {} : (visibility ?? {});
}
