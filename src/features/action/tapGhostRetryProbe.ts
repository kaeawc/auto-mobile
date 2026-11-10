import type { ObserveResult, ViewHierarchyResult } from "../../models";
import { logger } from "../../utils/logger";
import type { Timer } from "../../utils/SystemTimer";
import {
  checkAndroidTapHierarchyChange,
  POST_TAP_REFRESH_TIMEOUT_MS,
} from "./androidGhostTapRetry";
import type { TapTargetResolver } from "./TapTargetResolver";
import type { TapVerificationOptions } from "./tapVerificationOptions";

/** What the tapOn ghost-tap probe needs from its host. */
export interface GhostTapProbeHost {
  readonly isAndroidXr: (signal?: AbortSignal) => Promise<boolean>;
  readonly timer: () => Timer;
  tapVerificationRefresh: TapTargetResolver["tapVerificationRefresh"];
  hashViewHierarchy: TapTargetResolver["hashViewHierarchy"];
}

/** The post-tap hierarchy when it is unchanged and a retry may run; null when the retry is skipped. */
export async function unchangedHierarchyAfterTap(
  host: GhostTapProbeHost,
  preTapHash: string | null,
  {
    options,
    screenSize,
    signal,
  }: {
    options: TapVerificationOptions;
    screenSize: ObserveResult["screenSize"];
    signal?: AbortSignal;
  },
): Promise<ViewHierarchyResult | null> {
  if (await host.isAndroidXr(signal)) {
    // XR taps are accessibility node clicks. An unchanged hierarchy does not prove the click
    // missed, and a second click would toggle a switch back (#17811).
    logger.info("[TapOnElement][retryIfNoChange] XR node click; skipping ghost-tap retry");
    return null;
  }
  const probe = await checkAndroidTapHierarchyChange(
    host.timer(),
    host.tapVerificationRefresh({
      refresh: options.verification?.refresh,
      screenSize,
      signal,
    }),
    (hierarchy) => host.hashViewHierarchy(hierarchy),
    { preTapHash, signal },
  );

  if (probe.status === "unavailable") {
    // Hierarchy unreadable — we can't tell whether the tap registered. A retry
    // here is more likely to land on a transitioning screen and bounce us
    // off-path than to recover a real ghost tap. Bail and let the next
    // step's waitFor/observe surface a real failure.
    logger.warn(
      `[TapOnElement][retryIfNoChange] Tap hierarchy unreadable or could not be fingerprinted ` +
        `(post-tap refresh budget ${POST_TAP_REFRESH_TIMEOUT_MS}ms) — skipping retry`,
    );
    return null;
  }

  if (probe.status === "changed") {
    logger.info(`[TapOnElement][retryIfNoChange] Hierarchy changed after tap — tap registered`);
    return null;
  }

  return probe.hierarchy;
}
