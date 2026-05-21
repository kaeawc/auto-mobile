import type { Logger } from "../utils/logger";

export interface CiTuningFlags {
  uiPerfMode: boolean;
  networkMockable: boolean;
  dismissKeyboardAfterInput: boolean;
  noA11yIncludeNotImportantViews: boolean;
  noA11yReportViewIds: boolean;
}

export function logCiTuningFlags(flags: CiTuningFlags, log: Logger): void {
  if (!flags.uiPerfMode) {
    log.info("UI performance mode disabled (--no-ui-perf-mode): TTI and displayed metrics capture skipped");
  }
  if (flags.networkMockable) {
    log.info("Network mocking enabled (--network-mockable)");
  }
  if (flags.dismissKeyboardAfterInput) {
    log.info("Dismiss keyboard after input enabled (--dismiss-keyboard-after-input)");
  }
  if (flags.noA11yIncludeNotImportantViews) {
    log.info("Accessibility flag FLAG_INCLUDE_NOT_IMPORTANT_VIEWS disabled (--no-include-not-important-views)");
  }
  if (flags.noA11yReportViewIds) {
    log.info("Accessibility flag FLAG_REPORT_VIEW_IDS disabled (--no-report-view-ids)");
  }
}
