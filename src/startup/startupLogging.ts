import { EVENT_ALL_MARKERS_FLAG } from "../utils/eventAllMarkers";
import type { ServerModules } from "./serverModules";
import type { ParsedArgs } from "./startupContext";

/**
 * Log-only echoes for daemon CLI flags whose side effects are applied downstream via
 * startDaemon(). Surfacing them at startup makes CI logs grep-verifiable so a missing flag is
 * visible without re-running.
 */
export function logActiveDaemonFlags(args: ParsedArgs, logger: ServerModules["logger"]): void {
  const silentDaemonFlags: Array<[boolean, string]> = [
    [
      !args.uiPerfMode,
      "UI perf mode disabled (--no-ui-perf-mode): skipping selection-state visual capture on taps and UI perf auditing",
    ],
    [args.embeddedSdk, "Embedded SDK tools enabled (--embedded-sdk)"],
    [
      args.dismissKeyboardAfterInput,
      "Dismiss keyboard after internal text input enabled (--dismiss-keyboard-after-input)",
    ],
    [
      args.noA11yIncludeNotImportantViews,
      "Accessibility includeNotImportantViews disabled (--no-include-not-important-views)",
    ],
    [args.noA11yReportViewIds, "Accessibility reportViewIds disabled (--no-report-view-ids)"],
    [
      args.noA11yRetrieveInteractiveWindows,
      "Accessibility retrieveInteractiveWindows disabled (--no-retrieve-interactive-windows)",
    ],
    [args.noOcclusion, "Observe occlusion pass disabled (--no-occlusion)"],
  ];
  for (const [active, message] of silentDaemonFlags) {
    if (active) {
      logger.info(message);
    }
  }
  logEventAllMarkers(args.eventAllMarkers, logger);
}

function logEventAllMarkers(eventAllMarkers: readonly string[], logger: ServerModules["logger"]) {
  if (eventAllMarkers.length > 0) {
    logger.info(
      `Internal text-input eventAll auto-promotion markers configured (--event-all-markers): ${JSON.stringify(eventAllMarkers)}`,
    );
    return;
  }
  const flagProvided = process.argv
    .slice(2)
    .some((a) => a === EVENT_ALL_MARKERS_FLAG || a.startsWith(`${EVENT_ALL_MARKERS_FLAG}=`));
  if (flagProvided) {
    logger.warn(
      `${EVENT_ALL_MARKERS_FLAG} was provided but resolved to no markers; internal text-input eventAll auto-promotion stays disabled`,
    );
  }
}
