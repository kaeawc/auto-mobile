import { describe, expect, test } from "bun:test";
import { logCiTuningFlags, type CiTuningFlags } from "../../src/cli/logCiTuningFlags";
import type { Logger } from "../../src/utils/logger";

class FakeLogger implements Logger {
  infos: string[] = [];
  info(message: string): void {
    this.infos.push(message);
  }
  warn(): void {}
  error(): void {}
  debug?(): void {}
}

const allOff: CiTuningFlags = {
  uiPerfMode: true,
  networkMockable: false,
  dismissKeyboardAfterInput: false,
  noA11yIncludeNotImportantViews: false,
  noA11yReportViewIds: false,
};

describe("logCiTuningFlags", () => {
  test("emits nothing when all CI-tuning flags are at default", () => {
    const log = new FakeLogger();
    logCiTuningFlags(allOff, log);
    expect(log.infos).toEqual([]);
  });

  test("logs --no-ui-perf-mode when uiPerfMode is false", () => {
    const log = new FakeLogger();
    logCiTuningFlags({ ...allOff, uiPerfMode: false }, log);
    expect(log.infos).toEqual([
      "UI performance mode disabled (--no-ui-perf-mode): TTI and displayed metrics capture skipped",
    ]);
  });

  test("logs --network-mockable when enabled", () => {
    const log = new FakeLogger();
    logCiTuningFlags({ ...allOff, networkMockable: true }, log);
    expect(log.infos).toEqual(["Network mocking enabled (--network-mockable)"]);
  });

  test("logs --dismiss-keyboard-after-input when enabled", () => {
    const log = new FakeLogger();
    logCiTuningFlags({ ...allOff, dismissKeyboardAfterInput: true }, log);
    expect(log.infos).toEqual([
      "Dismiss keyboard after input enabled (--dismiss-keyboard-after-input)",
    ]);
  });

  test("logs --no-include-not-important-views when set", () => {
    const log = new FakeLogger();
    logCiTuningFlags({ ...allOff, noA11yIncludeNotImportantViews: true }, log);
    expect(log.infos).toEqual([
      "Accessibility flag FLAG_INCLUDE_NOT_IMPORTANT_VIEWS disabled (--no-include-not-important-views)",
    ]);
  });

  test("logs --no-report-view-ids when set", () => {
    const log = new FakeLogger();
    logCiTuningFlags({ ...allOff, noA11yReportViewIds: true }, log);
    expect(log.infos).toEqual([
      "Accessibility flag FLAG_REPORT_VIEW_IDS disabled (--no-report-view-ids)",
    ]);
  });

  test("logs all five flags when all are active", () => {
    const log = new FakeLogger();
    logCiTuningFlags(
      {
        uiPerfMode: false,
        networkMockable: true,
        dismissKeyboardAfterInput: true,
        noA11yIncludeNotImportantViews: true,
        noA11yReportViewIds: true,
      },
      log
    );
    expect(log.infos.length).toBe(5);
  });
});
