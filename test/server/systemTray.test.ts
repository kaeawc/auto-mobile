import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import {
  registerInteractionTools,
  resetSystemTrayDependencies,
  setSystemTrayDependencies,
  waitForNotificationMatch,
} from "../../src/server/interactionTools";
import { ToolRegistry } from "../../src/server/toolRegistry";
import {
  ensureSystemTrayClosed,
  ensureSystemTrayOpen,
  tapElement,
  swipeElement,
  isMatchInCollapsedGroup,
  expandNotificationGroup,
  EXPAND_GROUP_SETTLE_MS,
} from "../../src/server/systemTrayHelpers";
import type { SystemTrayIosClient } from "../../src/server/systemTrayHelpers";
import { FakeTimer } from "../fakes/FakeTimer";
import { FakeAdbExecutor } from "../fakes/FakeAdbExecutor";
import { FakeObserveScreen } from "../fakes/FakeObserveScreen";
import { logger, LogLevel } from "../../src/utils/logger";
import { serverConfig } from "../../src/utils/ServerConfig";
import type { BootedDevice, Element, ObserveResult, ViewHierarchyResult } from "../../src/models";

const POLL_INTERVAL_MS = 250;
// Mirrors the private SYSTEM_TRAY_REEXPAND_INTERVAL_MS in systemTrayHelpers.ts.
const REEXPAND_INTERVAL_MS = 1000;
const SYSTEM_TRAY_PACKAGE = "com.android.systemui";

class SequencedFakeAdbExecutor extends FakeAdbExecutor {
  private timestamps: number[];

  constructor(timestamps: number[]) {
    super();
    this.timestamps = [...timestamps];
  }

  setTimestamps(timestamps: number[]): void {
    this.timestamps = [...timestamps];
  }

  async getDeviceTimestampMs(): Promise<number> {
    if (this.timestamps.length > 0) {
      return this.timestamps.shift() as number;
    }
    return super.getDeviceTimestampMs();
  }
}

class SequencedObserveScreen extends FakeObserveScreen {
  private results: ObserveResult[];
  private index = 0;
  private minTimestamps: Array<number | undefined> = [];

  constructor(results: ObserveResult[]) {
    super();
    this.results = results;
    this.setObserveResult(() => this.nextResult());
  }

  async execute(options?: {
    skipWaitForFresh?: boolean;
    minTimestamp?: number;
    signal?: AbortSignal;
  }): Promise<ObserveResult> {
    this.minTimestamps.push(options?.minTimestamp);
    return super.execute(options);
  }

  getMinTimestamps(): Array<number | undefined> {
    return [...this.minTimestamps];
  }

  private nextResult(): ObserveResult {
    const result = this.results[Math.min(this.index, this.results.length - 1)];
    this.index += 1;
    return result;
  }
}

const createObservation = (viewHierarchy?: ViewHierarchyResult): ObserveResult => ({
  updatedAt: 0,
  screenSize: { width: 1080, height: 1920 },
  systemInsets: { top: 0, right: 0, bottom: 0, left: 0 },
  viewHierarchy,
});

const createClosedHierarchy = (text: string = ""): ViewHierarchyResult => ({
  packageName: "com.google.android.apps.nexuslauncher",
  hierarchy: {
    node: {
      $: {
        "resource-id": "launcher_root",
        class: "Launcher",
        packageName: "com.google.android.apps.nexuslauncher",
        text,
        bounds: { left: 0, top: 0, right: 100, bottom: 100 },
      },
    },
  },
});

const createTrayHierarchy = (title: string): ViewHierarchyResult => ({
  packageName: SYSTEM_TRAY_PACKAGE,
  hierarchy: {
    node: {
      $: {
        "resource-id": "com.android.systemui:id/notification_stack_scroller",
        class: "NotificationShade",
        packageName: SYSTEM_TRAY_PACKAGE,
        bounds: { left: 0, top: 0, right: 100, bottom: 100 },
      },
      node: [
        {
          $: {
            "resource-id": "com.android.systemui:id/notification_row_1",
            class: "ExpandableNotificationRow",
            packageName: SYSTEM_TRAY_PACKAGE,
            text: title,
            bounds: { left: 0, top: 0, right: 100, bottom: 50 },
          },
        },
      ],
    },
  },
});

const device: BootedDevice = {
  name: "Pixel_6",
  platform: "android",
  deviceId: "device-1",
  source: "local",
};

const waitForPendingSleep = async (timer: FakeTimer): Promise<void> => {
  for (let i = 0; i < 50 && timer.getPendingSleepCount() === 0; i += 1) {
    await Promise.resolve();
  }
  expect(timer.getPendingSleepCount()).toBeGreaterThan(0);
};

const advancePendingSleeps = async (timer: FakeTimer, steps: number): Promise<void> => {
  for (let step = 0; step < steps; step += 1) {
    for (let i = 0; i < 50 && timer.getPendingSleepCount() === 0; i += 1) {
      await Promise.resolve();
    }
    if (timer.getPendingSleepCount() > 0) {
      timer.advanceTime(POLL_INTERVAL_MS);
    }
  }
};

describe("systemTray find", () => {
  afterEach(() => {
    resetSystemTrayDependencies();
  });

  test("waits for the tray to open before matching", async () => {
    const fakeTimer = new FakeTimer();
    const fakeAdb = new SequencedFakeAdbExecutor([1000, 2000]);
    const fakeObserveScreen = new SequencedObserveScreen([
      createObservation(createClosedHierarchy()),
      createObservation(createClosedHierarchy()),
      createObservation(createTrayHierarchy("Test Notification")),
    ]);

    setSystemTrayDependencies({
      timer: fakeTimer,
      adbFactory: () => fakeAdb,
      observeScreenFactory: () => fakeObserveScreen,
    });

    const resultPromise = waitForNotificationMatch(device, { title: "Test Notification" }, [], 500);

    await waitForPendingSleep(fakeTimer);
    fakeTimer.advanceTime(POLL_INTERVAL_MS);

    const result = await resultPromise;

    expect(result.match).not.toBeNull();
    expect(result.observation.viewHierarchy?.packageName).toBe(SYSTEM_TRAY_PACKAGE);
    expect(fakeAdb.wasCommandExecuted("cmd statusbar expand-notifications")).toBe(true);
    const minTimestamps = fakeObserveScreen.getMinTimestamps();
    expect(minTimestamps[0]).toBe(1000);
    expect(minTimestamps[1]).toBe(2000);
    expect(fakeObserveScreen.getExecuteOptions().every((options) => options.skipScreenshot)).toBe(
      true,
    );
    expect(
      fakeObserveScreen.getExecuteOptions().every((options) => options.skipAccessibilityAudit),
    ).toBe(true);
  });

  test("does not return matches while the tray is closed", async () => {
    const fakeTimer = new FakeTimer();
    const fakeAdb = new SequencedFakeAdbExecutor([1000, 2000]);
    const fakeObserveScreen = new SequencedObserveScreen([
      createObservation(createClosedHierarchy("Test Notification")),
      createObservation(createClosedHierarchy("Test Notification")),
      createObservation(createClosedHierarchy("Test Notification")),
    ]);

    setSystemTrayDependencies({
      timer: fakeTimer,
      adbFactory: () => fakeAdb,
      observeScreenFactory: () => fakeObserveScreen,
    });

    const resultPromise = waitForNotificationMatch(device, { title: "Test Notification" }, [], 500);

    await advancePendingSleeps(fakeTimer, 3);

    const result = await resultPromise;

    expect(result.match).toBeNull();
    expect(result.observation.viewHierarchy?.packageName).toBe(
      "com.google.android.apps.nexuslauncher",
    );
    expect(fakeAdb.wasCommandExecuted("cmd statusbar expand-notifications")).toBe(true);
    expect(fakeObserveScreen.getExecuteCallCount()).toBeGreaterThan(1);
  });

  test("uses minimum timeout when awaitTimeoutMs is zero", async () => {
    const fakeTimer = new FakeTimer();
    const fakeAdb = new SequencedFakeAdbExecutor([1000, 2000]);
    const fakeObserveScreen = new SequencedObserveScreen([
      createObservation(createClosedHierarchy()),
      createObservation(createTrayHierarchy("Test Notification")),
    ]);

    setSystemTrayDependencies({
      timer: fakeTimer,
      adbFactory: () => fakeAdb,
      observeScreenFactory: () => fakeObserveScreen,
    });

    // With awaitTimeoutMs=0, the function should enforce a minimum timeout
    // and still find the notification after the tray opens
    const result = await waitForNotificationMatch(device, { title: "Test Notification" }, [], 0);

    expect(result.match).not.toBeNull();
    expect(result.observation.viewHierarchy?.packageName).toBe(SYSTEM_TRAY_PACKAGE);
    expect(fakeObserveScreen.getExecuteCallCount()).toBeGreaterThanOrEqual(1);
  });

  test("uses minimum timeout when awaitTimeoutMs is negative", async () => {
    const fakeTimer = new FakeTimer();
    const fakeAdb = new SequencedFakeAdbExecutor([1000, 2000]);
    const fakeObserveScreen = new SequencedObserveScreen([
      createObservation(createClosedHierarchy()),
      createObservation(createTrayHierarchy("Test Notification")),
    ]);

    setSystemTrayDependencies({
      timer: fakeTimer,
      adbFactory: () => fakeAdb,
      observeScreenFactory: () => fakeObserveScreen,
    });

    // With negative awaitTimeoutMs, the function should enforce a minimum timeout
    // and still find the notification after the tray opens
    const result = await waitForNotificationMatch(device, { title: "Test Notification" }, [], -100);

    expect(result.match).not.toBeNull();
    expect(result.observation.viewHierarchy?.packageName).toBe(SYSTEM_TRAY_PACKAGE);
    expect(fakeObserveScreen.getExecuteCallCount()).toBeGreaterThanOrEqual(1);
  });

  test("zero timeout still polls when first observation has no match", async () => {
    const fakeTimer = new FakeTimer();
    const fakeAdb = new SequencedFakeAdbExecutor([1000, 2000]);
    // Tray is already open with wrong notification on first check.
    // ensureSystemTrayOpen sees tray open (skips expand), then the while loop
    // finds no match on index 0, sleeps, and re-observes getting index 1 with the target.
    const fakeObserveScreen = new SequencedObserveScreen([
      createObservation(createTrayHierarchy("Other Notification")),
      createObservation(createTrayHierarchy("Target Notification")),
    ]);

    setSystemTrayDependencies({
      timer: fakeTimer,
      adbFactory: () => fakeAdb,
      observeScreenFactory: () => fakeObserveScreen,
    });

    // Without the fix, awaitTimeoutMs=0 would return null immediately after
    // the first observation check. With the fix, it uses minimum timeout and polls.
    const resultPromise = waitForNotificationMatch(device, { title: "Target Notification" }, [], 0);

    await waitForPendingSleep(fakeTimer);
    fakeTimer.advanceTime(POLL_INTERVAL_MS);

    const result = await resultPromise;

    expect(result.match).not.toBeNull();
    expect(result.match!.match.matches.title?.text).toBe("Target Notification");
    expect(fakeObserveScreen.getExecuteCallCount()).toBeGreaterThanOrEqual(2);
  });
});

// Issue #4614: a re-posting high-importance notification (e.g. a persistent
// connection push) can collapse the shade mid-wait. waitForNotificationMatch
// must re-issue the expand while polling, throttled to at most once per
// REEXPAND_INTERVAL_MS, rather than sitting on a closed shade until timeout.
describe("systemTray re-expand on closed shade during wait", () => {
  afterEach(() => {
    resetSystemTrayDependencies();
  });

  test("re-expands once the shade has been closed for a full throttle interval, then matches", async () => {
    const fakeTimer = new FakeTimer();
    const fakeAdb = new SequencedFakeAdbExecutor([1000, 2000]);
    // Starts already open (ensureSystemTrayOpen takes the skip branch, so the
    // only expand-notifications call possible here is our in-loop re-expand).
    const fakeObserveScreen = new SequencedObserveScreen([
      createObservation(createTrayHierarchy("Other Notification")),
      createObservation(createClosedHierarchy()),
      createObservation(createClosedHierarchy()),
      createObservation(createClosedHierarchy()),
      createObservation(createClosedHierarchy()),
      createObservation(createTrayHierarchy("Target Notification")),
    ]);

    setSystemTrayDependencies({
      timer: fakeTimer,
      adbFactory: () => fakeAdb,
      observeScreenFactory: () => fakeObserveScreen,
    });

    const resultPromise = waitForNotificationMatch(
      device,
      { title: "Target Notification" },
      [],
      REEXPAND_INTERVAL_MS * 5,
    );

    // 5 poll ticks: shade stays closed through t=250..1000, crossing the
    // throttle interval on the 4th closed observation (t=1000), then reopens.
    await advancePendingSleeps(fakeTimer, 5);

    const result = await resultPromise;

    expect(result.match).not.toBeNull();
    expect(result.match!.match.matches.title?.text).toBe("Target Notification");
    expect(
      fakeAdb.getExecutedCommands().filter((cmd) => cmd.includes("expand-notifications")).length,
    ).toBe(1);
  });

  test("re-expands again after a second throttle interval while the shade remains closed", async () => {
    const fakeTimer = new FakeTimer();
    const fakeAdb = new SequencedFakeAdbExecutor([1000, 2000]);
    const fakeObserveScreen = new SequencedObserveScreen([
      createObservation(createTrayHierarchy("Other Notification")),
      createObservation(createClosedHierarchy()),
      createObservation(createClosedHierarchy()),
      createObservation(createClosedHierarchy()),
      createObservation(createClosedHierarchy()),
      createObservation(createClosedHierarchy()),
      createObservation(createClosedHierarchy()),
      createObservation(createClosedHierarchy()),
      createObservation(createClosedHierarchy()),
      createObservation(createTrayHierarchy("Target Notification")),
    ]);

    setSystemTrayDependencies({
      timer: fakeTimer,
      adbFactory: () => fakeAdb,
      observeScreenFactory: () => fakeObserveScreen,
    });

    const resultPromise = waitForNotificationMatch(
      device,
      { title: "Target Notification" },
      [],
      REEXPAND_INTERVAL_MS * 5,
    );

    // At t=1000 and t=2000, the closed shade crosses the re-expand throttle
    // interval. The target appears after the second best-effort retry.
    await advancePendingSleeps(fakeTimer, 9);

    const result = await resultPromise;

    expect(result.match).not.toBeNull();
    expect(result.match!.match.matches.title?.text).toBe("Target Notification");
    expect(
      fakeAdb.getExecutedCommands().filter((cmd) => cmd.includes("expand-notifications")).length,
    ).toBe(2);
  });

  test("does not re-expand before a full throttle interval has elapsed", async () => {
    const fakeTimer = new FakeTimer();
    const fakeAdb = new SequencedFakeAdbExecutor([1000, 2000]);
    const fakeObserveScreen = new SequencedObserveScreen([
      createObservation(createTrayHierarchy("Other Notification")),
      createObservation(createClosedHierarchy()),
      createObservation(createClosedHierarchy()),
      createObservation(createClosedHierarchy()),
    ]);

    setSystemTrayDependencies({
      timer: fakeTimer,
      adbFactory: () => fakeAdb,
      observeScreenFactory: () => fakeObserveScreen,
    });

    // Deadline elapses strictly before the shade has been closed for a full
    // REEXPAND_INTERVAL_MS, so the loop should time out without ever
    // re-issuing the expand.
    const resultPromise = waitForNotificationMatch(
      device,
      { title: "Target Notification" },
      [],
      REEXPAND_INTERVAL_MS - 300,
    );

    await advancePendingSleeps(fakeTimer, 3);

    const result = await resultPromise;

    expect(result.match).toBeNull();
    expect(
      fakeAdb.getExecutedCommands().filter((cmd) => cmd.includes("expand-notifications")).length,
    ).toBe(0);
  });

  test("swallows a failed re-expand attempt and keeps polling until it matches", async () => {
    const fakeTimer = new FakeTimer();
    const fakeAdb = new SequencedFakeAdbExecutor([1000, 2000]);
    fakeAdb.setCommandError("expand-notifications", new Error("boom"));
    const fakeObserveScreen = new SequencedObserveScreen([
      createObservation(createTrayHierarchy("Other Notification")),
      createObservation(createClosedHierarchy()),
      createObservation(createClosedHierarchy()),
      createObservation(createClosedHierarchy()),
      createObservation(createClosedHierarchy()),
      createObservation(createTrayHierarchy("Target Notification")),
    ]);

    setSystemTrayDependencies({
      timer: fakeTimer,
      adbFactory: () => fakeAdb,
      observeScreenFactory: () => fakeObserveScreen,
    });

    const debugSpy = spyOn(logger, "debug").mockImplementation(() => {});
    try {
      const resultPromise = waitForNotificationMatch(
        device,
        { title: "Target Notification" },
        [],
        5000,
      );

      await advancePendingSleeps(fakeTimer, 5);

      const result = await resultPromise;

      expect(result.match).not.toBeNull();
      expect(result.match!.match.matches.title?.text).toBe("Target Notification");
      const swallowedLogs = debugSpy.mock.calls.filter((call) =>
        String(call[0]).includes("re-expand while waiting for notification failed"),
      );
      expect(swallowedLogs.length).toBe(1);
    } finally {
      debugSpy.mockRestore();
    }
  });
});

// Diagnostic logging added alongside the #4614 fix: when a wait fails to
// match, the logs should reveal whether the shade was open-but-unmatched or
// never detected as open, deduped so a long poll doesn't spam identical lines.
describe("systemTray unmatched-notification diagnostics", () => {
  afterEach(() => {
    resetSystemTrayDependencies();
  });

  test("keeps payload-bearing diagnostics out of the INFO sink and emits them at DEBUG", async () => {
    const notificationPreview = "Alice: Project secret";
    const criteria = {
      title: "Alice private target",
      body: "Confidential body",
      tapActionLabel: "Open Alice private target",
    };
    const appMatchTexts = ["Alice work profile"];
    const payloads = [
      notificationPreview,
      criteria.title,
      criteria.body,
      criteria.tapActionLabel,
      appMatchTexts[0],
    ];
    const waitForTarget = async (): Promise<void> => {
      const fakeTimer = new FakeTimer();
      const fakeAdb = new SequencedFakeAdbExecutor([1000, 2000]);
      const fakeObserveScreen = new SequencedObserveScreen([
        createObservation(createTrayHierarchy(notificationPreview)),
        createObservation(createTrayHierarchy(notificationPreview)),
        createObservation(createTrayHierarchy(notificationPreview)),
        createObservation(
          createTrayHierarchy(`${criteria.title} ${criteria.body} ${criteria.tapActionLabel}`),
        ),
      ]);

      setSystemTrayDependencies({
        timer: fakeTimer,
        adbFactory: () => fakeAdb,
        observeScreenFactory: () => fakeObserveScreen,
      });

      const resultPromise = waitForNotificationMatch(device, criteria, appMatchTexts, 5000);

      await advancePendingSleeps(fakeTimer, 3);

      const result = await resultPromise;

      expect(result.match).not.toBeNull();
      expect(result.match!.match.matches.title?.text).toBe(criteria.title);
    };

    const previousLevel = logger.getLogLevel();
    const stdoutSpy = spyOn(process.stdout, "write").mockImplementation(() => true);
    logger.enableStdoutLogging();
    try {
      // The singleton logger may still have writes queued by earlier tests.
      // Drain them before this test begins counting its own sink output.
      await logger.flush();
      stdoutSpy.mockClear();
      logger.setLogLevel(LogLevel.INFO);
      await waitForTarget();

      // Prove the asynchronous sink is live at INFO so the absence checks cannot
      // pass merely because logger output was never flushed.
      const infoSentinel = "__system_tray_info_sink_4614__";
      logger.info(infoSentinel);
      await logger.flush();
      expect(
        stdoutSpy.mock.calls.some((call) => String(call[0] ?? "").includes(infoSentinel)),
      ).toBe(true);

      const infoDiagnostics = stdoutSpy.mock.calls
        .map((call) => String(call[0] ?? ""))
        .filter((line) =>
          line.includes("[INFO] [systemTray][diag] shade open but no notification matched"),
        );
      expect(infoDiagnostics).toHaveLength(1);
      expect(infoDiagnostics[0]).toContain("candidateCount=1");
      for (const payload of payloads) {
        expect(infoDiagnostics[0]).not.toContain(payload);
      }

      stdoutSpy.mockClear();
      logger.setLogLevel(LogLevel.DEBUG);
      await waitForTarget();
      await logger.flush();

      const debugDiagnostics = stdoutSpy.mock.calls
        .map((call) => String(call[0] ?? ""))
        .filter((line) =>
          line.includes("[DEBUG] [systemTray][diag] shade open but no notification matched"),
        );
      expect(debugDiagnostics).toHaveLength(1);
      for (const payload of payloads) {
        expect(debugDiagnostics[0]).toContain(payload);
      }
    } finally {
      logger.setLogLevel(previousLevel);
      logger.disableStdoutLogging();
      stdoutSpy.mockRestore();
    }
  });

  test("logs the shade-not-open diagnostic once, deduped across identical closed polls", async () => {
    const fakeTimer = new FakeTimer();
    const fakeAdb = new SequencedFakeAdbExecutor([1000, 2000]);
    const fakeObserveScreen = new SequencedObserveScreen([
      createObservation(createTrayHierarchy("Other Notification")),
      createObservation(createClosedHierarchy()),
      createObservation(createClosedHierarchy()),
      createObservation(createTrayHierarchy("Target Notification")),
    ]);

    setSystemTrayDependencies({
      timer: fakeTimer,
      adbFactory: () => fakeAdb,
      observeScreenFactory: () => fakeObserveScreen,
    });

    const infoSpy = spyOn(logger, "info").mockImplementation(() => {});
    try {
      const resultPromise = waitForNotificationMatch(
        device,
        { title: "Target Notification" },
        [],
        5000,
      );

      await advancePendingSleeps(fakeTimer, 3);

      const result = await resultPromise;

      expect(result.match).not.toBeNull();
      const diagLogs = infoSpy.mock.calls.filter((call) =>
        String(call[0]).includes("shade NOT detected open during notification wait"),
      );
      expect(diagLogs.length).toBe(1);
    } finally {
      infoSpy.mockRestore();
    }
  });
});

describe("Android systemTray close", () => {
  afterEach(() => {
    resetSystemTrayDependencies();
  });

  test("collapses shade when tray is open", async () => {
    const fakeTimer = new FakeTimer();
    const fakeAdb = new SequencedFakeAdbExecutor([1000, 2000]);
    const fakeObserveScreen = new SequencedObserveScreen([
      createObservation(createTrayHierarchy("Note")),
      createObservation(createTrayHierarchy("Note")),
      createObservation(createClosedHierarchy()),
    ]);

    setSystemTrayDependencies({
      timer: fakeTimer,
      adbFactory: () => fakeAdb,
      observeScreenFactory: () => fakeObserveScreen,
    });

    const resultPromise = ensureSystemTrayClosed(device, 500);

    await waitForPendingSleep(fakeTimer);
    fakeTimer.advanceTime(POLL_INTERVAL_MS);

    const result = await resultPromise;

    expect(result.closed).toBe(true);
    expect(result.skipped).toBe(false);
    expect(fakeAdb.wasCommandExecuted("cmd statusbar collapse")).toBe(true);
  });

  test("skips collapse when tray is already closed", async () => {
    const fakeTimer = new FakeTimer();
    const fakeAdb = new SequencedFakeAdbExecutor([1000]);
    const fakeObserveScreen = new SequencedObserveScreen([
      createObservation(createClosedHierarchy()),
    ]);

    setSystemTrayDependencies({
      timer: fakeTimer,
      adbFactory: () => fakeAdb,
      observeScreenFactory: () => fakeObserveScreen,
    });

    const result = await ensureSystemTrayClosed(device, 500);

    expect(result.closed).toBe(false);
    expect(result.skipped).toBe(true);
    expect(fakeAdb.wasCommandExecuted("cmd statusbar collapse")).toBe(false);
  });
});

// ============================================================================
// iOS tests
// ============================================================================

const IOS_SPRINGBOARD_PACKAGE = "com.apple.springboard";

class FakeIosClient implements SystemTrayIosClient {
  swipeCalls: Array<{ x1: number; y1: number; x2: number; y2: number; duration?: number }> = [];
  tapCalls: Array<{ x: number; y: number }> = [];

  async requestSwipe(x1: number, y1: number, x2: number, y2: number, duration?: number) {
    this.swipeCalls.push({ x1, y1, x2, y2, duration });
    return { success: true };
  }

  async requestTapCoordinates(x: number, y: number) {
    this.tapCalls.push({ x, y });
    return { success: true };
  }
}

const iosDevice: BootedDevice = {
  name: "iPhone_15",
  platform: "ios",
  deviceId: "ios-device-1",
  source: "local",
};

const createIosObservation = (viewHierarchy?: ViewHierarchyResult): ObserveResult => ({
  updatedAt: 0,
  screenSize: { width: 390, height: 844 },
  systemInsets: { top: 0, right: 0, bottom: 0, left: 0 },
  viewHierarchy,
});

const createIosAppHierarchy = (): ViewHierarchyResult => ({
  packageName: "com.example.app",
  hierarchy: {
    node: {
      $: {
        className: "UIWindow",
        packageName: "com.example.app",
        bounds: { left: 0, top: 0, right: 390, bottom: 844 },
      },
    },
  },
});

const createIosNotificationCenterHierarchy = (
  title: string,
  body?: string,
): ViewHierarchyResult => ({
  packageName: IOS_SPRINGBOARD_PACKAGE,
  hierarchy: {
    node: {
      $: {
        className: "NotificationCenter",
        packageName: IOS_SPRINGBOARD_PACKAGE,
        bounds: { left: 0, top: 0, right: 390, bottom: 844 },
      },
      node: [
        {
          $: {
            className: "NCNotificationListCell",
            packageName: IOS_SPRINGBOARD_PACKAGE,
            text: title,
            "content-desc": body ?? "",
            bounds: { left: 10, top: 100, right: 380, bottom: 200 },
          },
        },
      ],
    },
  },
});

// ============================================================================
// Notification group matching tests
// ============================================================================

const createTrayWithGroupedNotifications = (
  appLabel: string,
  titles: string[],
): ViewHierarchyResult =>
  ({
    packageName: SYSTEM_TRAY_PACKAGE,
    hierarchy: {
      node: {
        $: {
          "resource-id": "com.android.systemui:id/notification_stack_scroller",
          packageName: SYSTEM_TRAY_PACKAGE,
          bounds: { left: 0, top: 0, right: 1080, bottom: 1920 },
        },
        node: [
          {
            $: {
              "resource-id": "com.android.systemui:id/expandableNotificationRow",
              bounds: { left: 48, top: 663, right: 1296, bottom: 993 },
            },
            node: {
              $: {
                "resource-id": "com.android.systemui:id/notification_children_container",
                className: "android.view.ViewGroup",
                bounds: { left: 48, top: 663, right: 1296, bottom: 993 },
              },
              node: [
                {
                  $: {
                    "resource-id": "android:id/notification_header",
                    className: "android.widget.RelativeLayout",
                    bounds: { left: 48, top: 663, right: 1296, bottom: 731 },
                  },
                  node: [
                    {
                      $: {
                        text: appLabel,
                        "resource-id": "android:id/app_name_text",
                        bounds: { left: 204, top: 672, right: 391, bottom: 721 },
                      },
                    },
                    {
                      $: {
                        "content-desc": "Expand",
                        "resource-id": "android:id/expand_button",
                        className: "android.widget.Button",
                        clickable: "true",
                        bounds: { left: 1084, top: 663, right: 1296, bottom: 731 },
                      },
                    },
                  ],
                },
                ...titles.map((title, i) => ({
                  $: {
                    "resource-id": "com.android.systemui:id/expandableNotificationRow",
                    className: "android.widget.FrameLayout",
                    bounds: `[48,${731 + i * 80}][1296,${811 + i * 80}]`,
                  },
                  node: {
                    $: {
                      "resource-id": "android:id/notification_content",
                      bounds: `[48,${731 + i * 80}][1296,${811 + i * 80}]`,
                    },
                    node: {
                      $: {
                        text: title,
                        "resource-id": "android:id/title",
                        bounds: `[96,${741 + i * 80}][900,${801 + i * 80}]`,
                      },
                    },
                  },
                })),
              ],
            },
          },
        ],
      },
    },
  }) as unknown as ViewHierarchyResult;

const createTrayWithGroupedNotificationsNoExpandButton = (
  appLabel: string,
  titles: string[],
): ViewHierarchyResult =>
  ({
    packageName: SYSTEM_TRAY_PACKAGE,
    hierarchy: {
      node: {
        $: {
          "resource-id": "com.android.systemui:id/notification_stack_scroller",
          packageName: SYSTEM_TRAY_PACKAGE,
          bounds: { left: 0, top: 0, right: 1080, bottom: 1920 },
        },
        node: [
          {
            $: {
              "resource-id": "com.android.systemui:id/expandableNotificationRow",
              bounds: { left: 48, top: 663, right: 1296, bottom: 993 },
            },
            node: {
              $: {
                "resource-id": "com.android.systemui:id/notification_children_container",
                className: "android.view.ViewGroup",
                bounds: { left: 48, top: 663, right: 1296, bottom: 993 },
              },
              node: [
                {
                  $: {
                    "resource-id": "android:id/notification_header",
                    className: "android.widget.RelativeLayout",
                    bounds: { left: 48, top: 663, right: 1296, bottom: 731 },
                  },
                  node: {
                    $: {
                      text: appLabel,
                      "resource-id": "android:id/app_name_text",
                      bounds: { left: 204, top: 672, right: 391, bottom: 721 },
                    },
                  },
                },
                ...titles.map((title, i) => ({
                  $: {
                    "resource-id": "com.android.systemui:id/expandableNotificationRow",
                    className: "android.widget.FrameLayout",
                    bounds: `[48,${731 + i * 80}][1296,${811 + i * 80}]`,
                  },
                  node: {
                    $: {
                      "resource-id": "android:id/notification_content",
                      bounds: `[48,${731 + i * 80}][1296,${811 + i * 80}]`,
                    },
                    node: {
                      $: {
                        text: title,
                        "resource-id": "android:id/title",
                        bounds: `[96,${741 + i * 80}][900,${801 + i * 80}]`,
                      },
                    },
                  },
                })),
              ],
            },
          },
        ],
      },
    },
  }) as unknown as ViewHierarchyResult;

const createTrayWithExpandedNotifications = (titles: string[]): ViewHierarchyResult =>
  ({
    packageName: SYSTEM_TRAY_PACKAGE,
    hierarchy: {
      node: {
        $: {
          "resource-id": "com.android.systemui:id/notification_stack_scroller",
          packageName: SYSTEM_TRAY_PACKAGE,
          bounds: { left: 0, top: 0, right: 1080, bottom: 1920 },
        },
        node: titles.map((title, i) => ({
          $: {
            "resource-id": "com.android.systemui:id/expandableNotificationRow",
            className: "android.widget.FrameLayout",
            clickable: "true",
            bounds: `[48,${400 + i * 200}][1296,${600 + i * 200}]`,
          },
          node: {
            $: {
              "resource-id": "android:id/notification_content",
              bounds: `[48,${400 + i * 200}][1296,${600 + i * 200}]`,
            },
            node: {
              $: {
                text: title,
                "resource-id": "android:id/title",
                bounds: `[96,${410 + i * 200}][900,${590 + i * 200}]`,
              },
            },
          },
        })),
      },
    },
  }) as unknown as ViewHierarchyResult;

describe("systemTray grouped notifications", () => {
  afterEach(() => {
    resetSystemTrayDependencies();
  });

  test("matches individual notification inside a collapsed group", async () => {
    const fakeTimer = new FakeTimer();
    const fakeAdb = new SequencedFakeAdbExecutor([1000]);
    const fakeObserveScreen = new SequencedObserveScreen([
      createObservation(
        createTrayWithGroupedNotifications("FUBStaging", [
          "Zillow Real-Time Tour request",
          "New Lead: Jane Smith",
        ]),
      ),
    ]);

    setSystemTrayDependencies({
      timer: fakeTimer,
      adbFactory: () => fakeAdb,
      observeScreenFactory: () => fakeObserveScreen,
    });

    const result = await waitForNotificationMatch(
      device,
      { title: "Zillow Real-Time Tour request" },
      [],
      500,
    );

    expect(result.match).not.toBeNull();
    expect(result.match!.match.matches.title?.text).toBe("Zillow Real-Time Tour request");
  });

  test("prefers topmost notification when multiple match", async () => {
    const fakeTimer = new FakeTimer();
    const fakeAdb = new SequencedFakeAdbExecutor([1000]);
    const fakeObserveScreen = new SequencedObserveScreen([
      createObservation(
        createTrayWithGroupedNotifications("FUBStaging", [
          "Zillow Real-Time Tour request",
          "Zillow Real-Time Tour request",
        ]),
      ),
    ]);

    setSystemTrayDependencies({
      timer: fakeTimer,
      adbFactory: () => fakeAdb,
      observeScreenFactory: () => fakeObserveScreen,
    });

    const result = await waitForNotificationMatch(
      device,
      { title: "Zillow Real-Time Tour request" },
      [],
      500,
    );

    expect(result.match).not.toBeNull();
    expect(result.match!.match.matches.title?.text).toBe("Zillow Real-Time Tour request");
    // First notification row starts at y=731, second at y=811
    expect(result.match!.candidate.element?.bounds?.top).toBe(731);
  });

  test("does not match notification_container_parent or shared_notification_container", async () => {
    const fakeTimer = new FakeTimer();
    const fakeAdb = new SequencedFakeAdbExecutor([1000]);

    const hierarchy: any = {
      packageName: SYSTEM_TRAY_PACKAGE,
      hierarchy: {
        node: {
          $: {
            "resource-id": "com.android.systemui:id/notification_panel",
            packageName: SYSTEM_TRAY_PACKAGE,
            bounds: { left: 0, top: 0, right: 1344, bottom: 2992 },
          },
          node: {
            $: {
              "resource-id": "com.android.systemui:id/shared_notification_container",
              bounds: { left: 0, top: 0, right: 1344, bottom: 2992 },
            },
            node: {
              $: {
                "resource-id": "com.android.systemui:id/notification_container_parent",
                bounds: { left: 0, top: 0, right: 1344, bottom: 2992 },
              },
              node: {
                $: {
                  "resource-id": "com.android.systemui:id/notification_stack_scroller",
                  bounds: { left: 0, top: 0, right: 1344, bottom: 2896 },
                },
                node: {
                  $: {
                    "resource-id": "com.android.systemui:id/expandableNotificationRow",
                    clickable: "true",
                    bounds: { left: 48, top: 663, right: 1296, bottom: 1073 },
                  },
                  node: {
                    $: {
                      text: "Zillow Real-Time Tour request",
                      "resource-id": "android:id/title",
                      bounds: { left: 204, top: 813, right: 1248, bottom: 878 },
                    },
                  },
                },
              },
            },
          },
        },
      },
    };

    const fakeObserveScreen = new SequencedObserveScreen([createObservation(hierarchy)]);

    setSystemTrayDependencies({
      timer: fakeTimer,
      adbFactory: () => fakeAdb,
      observeScreenFactory: () => fakeObserveScreen,
    });

    const result = await waitForNotificationMatch(
      device,
      { title: "Zillow Real-Time Tour request" },
      [],
      500,
    );

    expect(result.match).not.toBeNull();
    expect(result.match!.candidate.element?.bounds?.top).toBe(663);
    expect(result.match!.candidate.element?.bounds?.bottom).toBe(1073);
    expect(result.match!.candidate.node?.$?.["resource-id"]).toBe(
      "com.android.systemui:id/expandableNotificationRow",
    );
  });

  test("does not match unrelated titles in grouped notifications", async () => {
    const fakeTimer = new FakeTimer();
    const fakeAdb = new SequencedFakeAdbExecutor([1000]);
    const fakeObserveScreen = new SequencedObserveScreen([
      createObservation(
        createTrayWithGroupedNotifications("FUBStaging", [
          "New Lead: Jane Smith",
          "New Lead: Bob Wilson",
        ]),
      ),
      createObservation(
        createTrayWithGroupedNotifications("FUBStaging", [
          "New Lead: Jane Smith",
          "New Lead: Bob Wilson",
        ]),
      ),
    ]);

    setSystemTrayDependencies({
      timer: fakeTimer,
      adbFactory: () => fakeAdb,
      observeScreenFactory: () => fakeObserveScreen,
    });

    const resultPromise = waitForNotificationMatch(
      device,
      { title: "Zillow Real-Time Tour request" },
      [],
      500,
    );

    await advancePendingSleeps(fakeTimer, 3);

    const result = await resultPromise;

    expect(result.match).toBeNull();
  });
});

describe("systemTray group expansion", () => {
  afterEach(() => {
    resetSystemTrayDependencies();
    ToolRegistry.clearTools();
  });

  test("detects match in collapsed group via groupNode", async () => {
    const fakeTimer = new FakeTimer();
    const fakeAdb = new SequencedFakeAdbExecutor([1000]);
    const fakeObserveScreen = new SequencedObserveScreen([
      createObservation(
        createTrayWithGroupedNotifications("FUBStaging", ["Zillow Real-Time Tour request"]),
      ),
    ]);

    setSystemTrayDependencies({
      timer: fakeTimer,
      adbFactory: () => fakeAdb,
      observeScreenFactory: () => fakeObserveScreen,
    });

    const result = await waitForNotificationMatch(
      device,
      { title: "Zillow Real-Time Tour request" },
      [],
      500,
    );

    expect(result.match).not.toBeNull();
    expect(isMatchInCollapsedGroup(result.match!)).toBe(true);
  });

  test("standalone notification is not in collapsed group", async () => {
    const fakeTimer = new FakeTimer();
    const fakeAdb = new SequencedFakeAdbExecutor([1000]);
    const hierarchy: any = {
      packageName: SYSTEM_TRAY_PACKAGE,
      hierarchy: {
        node: {
          $: {
            "resource-id": "com.android.systemui:id/notification_stack_scroller",
            packageName: SYSTEM_TRAY_PACKAGE,
            bounds: { left: 0, top: 0, right: 1080, bottom: 1920 },
          },
          node: {
            $: {
              "resource-id": "com.android.systemui:id/expandableNotificationRow",
              clickable: "true",
              bounds: { left: 48, top: 663, right: 1296, bottom: 1073 },
            },
            node: {
              $: {
                text: "Zillow Real-Time Tour request",
                "resource-id": "android:id/title",
                bounds: { left: 204, top: 813, right: 1248, bottom: 878 },
              },
            },
          },
        },
      },
    };
    const fakeObserveScreen = new SequencedObserveScreen([createObservation(hierarchy)]);

    setSystemTrayDependencies({
      timer: fakeTimer,
      adbFactory: () => fakeAdb,
      observeScreenFactory: () => fakeObserveScreen,
    });

    const result = await waitForNotificationMatch(
      device,
      { title: "Zillow Real-Time Tour request" },
      [],
      500,
    );

    expect(result.match).not.toBeNull();
    expect(isMatchInCollapsedGroup(result.match!)).toBe(false);
  });

  test("expandNotificationGroup taps expand button in group", async () => {
    const fakeTimer = new FakeTimer();
    const fakeAdb = new SequencedFakeAdbExecutor([1000]);
    const fakeObserveScreen = new SequencedObserveScreen([
      createObservation(
        createTrayWithGroupedNotifications("FUBStaging", ["Zillow Real-Time Tour request"]),
      ),
    ]);

    setSystemTrayDependencies({
      timer: fakeTimer,
      adbFactory: () => fakeAdb,
      observeScreenFactory: () => fakeObserveScreen,
    });

    const result = await waitForNotificationMatch(
      device,
      { title: "Zillow Real-Time Tour request" },
      [],
      500,
    );

    expect(result.match).not.toBeNull();
    expect(isMatchInCollapsedGroup(result.match!)).toBe(true);

    const expanded = await expandNotificationGroup(device, result.match!);
    expect(expanded).toBe(true);

    const tapCommands = fakeAdb.getExecutedCommands().filter((cmd) => cmd.includes("input tap"));
    expect(tapCommands.length).toBe(1);

    const tapCmd = tapCommands[0];
    // Pin the expand-button CENTRE (1190,697) — centre of bounds [1084,663]
    // [1296,731]. A corner-tap regression taps 1084 663 and opens the app
    // generically instead of expanding the group (#4183 R1).
    expect(tapCmd).toContain("input tap 1190 697");
  });

  test("expandNotificationGroup throws when no expand button exists", async () => {
    const fakeTimer = new FakeTimer();
    const fakeAdb = new SequencedFakeAdbExecutor([1000]);
    const fakeObserveScreen = new SequencedObserveScreen([
      createObservation(
        createTrayWithGroupedNotificationsNoExpandButton("FUBStaging", [
          "Zillow Real-Time Tour request",
        ]),
      ),
    ]);

    setSystemTrayDependencies({
      timer: fakeTimer,
      adbFactory: () => fakeAdb,
      observeScreenFactory: () => fakeObserveScreen,
    });

    const result = await waitForNotificationMatch(
      device,
      { title: "Zillow Real-Time Tour request" },
      [],
      500,
    );

    expect(result.match).not.toBeNull();
    expect(isMatchInCollapsedGroup(result.match!)).toBe(true);

    await expect(expandNotificationGroup(device, result.match!)).rejects.toThrow(
      "Collapsed notification group detected but no expand button found",
    );

    const tapCommands = fakeAdb.getExecutedCommands().filter((cmd) => cmd.includes("input tap"));
    expect(tapCommands.length).toBe(0);
  });

  test("tap action expands collapsed group then re-matches", async () => {
    const fakeTimer = new FakeTimer();
    const fakeAdb = new SequencedFakeAdbExecutor([1000, 1000]);

    const collapsedHierarchy = createTrayWithGroupedNotifications("FUBStaging", [
      "Zillow Real-Time Tour request",
      "Test message",
    ]);
    const expandedHierarchy = createTrayWithExpandedNotifications([
      "Zillow Real-Time Tour request",
      "Test message",
    ]);

    const fakeObserveScreen = new SequencedObserveScreen([
      createObservation(collapsedHierarchy),
      createObservation(expandedHierarchy),
      createObservation(expandedHierarchy),
      createObservation(expandedHierarchy),
    ]);

    setSystemTrayDependencies({
      timer: fakeTimer,
      adbFactory: () => fakeAdb,
      observeScreenFactory: () => fakeObserveScreen,
    });

    ToolRegistry.clearTools();
    registerInteractionTools();
    const handler = ToolRegistry.getTool("systemTray")?.deviceAwareHandler;
    expect(handler).toBeDefined();

    const tap = handler!(device, {
      action: "tap",
      notification: { title: "Zillow Real-Time Tour request" },
      awaitTimeout: 5000,
      platform: "android",
    });
    await waitForPendingSleep(fakeTimer);
    fakeTimer.advanceTime(EXPAND_GROUP_SETTLE_MS);
    await tap;

    const tapCommands = fakeAdb.getExecutedCommands().filter((cmd) => cmd.includes("input tap"));
    expect(tapCommands).toHaveLength(2);
    expect(tapCommands[0]).toContain("input tap 1190 697");
    expect(tapCommands[1]).not.toContain("input tap 1190 697");
  });

  test("re-match returns null when notification disappears after expand", async () => {
    const fakeTimer = new FakeTimer();
    const fakeAdb = new SequencedFakeAdbExecutor([1000, 1000]);

    const collapsedHierarchy = createTrayWithGroupedNotifications("FUBStaging", [
      "Zillow Real-Time Tour request",
    ]);
    const postExpandHierarchy = createTrayWithExpandedNotifications([
      "Completely different notification",
    ]);

    const fakeObserveScreen = new SequencedObserveScreen([
      createObservation(collapsedHierarchy),
      createObservation(postExpandHierarchy),
      createObservation(postExpandHierarchy),
      createObservation(postExpandHierarchy),
    ]);

    setSystemTrayDependencies({
      timer: fakeTimer,
      adbFactory: () => fakeAdb,
      observeScreenFactory: () => fakeObserveScreen,
    });

    const { match } = await waitForNotificationMatch(
      device,
      { title: "Zillow Real-Time Tour request" },
      [],
      5000,
    );

    expect(match).not.toBeNull();
    expect(isMatchInCollapsedGroup(match!)).toBe(true);

    const expanded = await expandNotificationGroup(device, match!);
    expect(expanded).toBe(true);

    const reMatchPromise = waitForNotificationMatch(
      device,
      { title: "Zillow Real-Time Tour request" },
      [],
      500,
    );

    await advancePendingSleeps(fakeTimer, 5);

    const reResult = await reMatchPromise;
    expect(reResult.match).toBeNull();
  });
});

describe("systemTray automatic terminal evidence", () => {
  let originalActionScreenshotPolicy: string | undefined;

  beforeEach(() => {
    originalActionScreenshotPolicy = process.env.AUTOMOBILE_ACTION_OBSERVATION_SKIP_SCREENSHOT;
  });

  afterEach(() => {
    if (originalActionScreenshotPolicy === undefined) {
      delete process.env.AUTOMOBILE_ACTION_OBSERVATION_SKIP_SCREENSHOT;
    } else {
      process.env.AUTOMOBILE_ACTION_OBSERVATION_SKIP_SCREENSHOT = originalActionScreenshotPolicy;
    }
    serverConfig.setAccessibilityAuditConfig(null);
    resetSystemTrayDependencies();
    ToolRegistry.clearTools();
  });

  test("captures only the final find observation when action screenshots are enabled", async () => {
    process.env.AUTOMOBILE_ACTION_OBSERVATION_SKIP_SCREENSHOT = "false";
    const fakeObserveScreen = new SequencedObserveScreen([
      createObservation(createTrayHierarchy("Test Notification")),
    ]);

    setSystemTrayDependencies({
      timer: new FakeTimer(),
      adbFactory: () => new SequencedFakeAdbExecutor([1000]),
      observeScreenFactory: () => fakeObserveScreen,
    });
    registerInteractionTools();
    const handler = ToolRegistry.getTool("systemTray")?.deviceAwareHandler;

    await handler!(device, {
      action: "find",
      notification: { title: "Test Notification" },
      platform: "android",
    });

    expect(fakeObserveScreen.getExecuteOptions().every((options) => options.skipScreenshot)).toBe(
      true,
    );
    expect(
      fakeObserveScreen.getExecuteOptions().every((options) => options.skipAccessibilityAudit),
    ).toBe(true);
    expect(fakeObserveScreen.getCaptureScreenshotCallCount()).toBe(1);
    expect(fakeObserveScreen.getAccessibilityAuditCallCount()).toBe(0);
  });

  test("keeps the terminal accessibility audit when automatic screenshots are skipped", async () => {
    delete process.env.AUTOMOBILE_ACTION_OBSERVATION_SKIP_SCREENSHOT;
    const fakeObserveScreen = new SequencedObserveScreen([
      createObservation(createTrayHierarchy("Test Notification")),
    ]);

    setSystemTrayDependencies({
      timer: new FakeTimer(),
      adbFactory: () => new SequencedFakeAdbExecutor([1000]),
      observeScreenFactory: () => fakeObserveScreen,
    });
    registerInteractionTools();
    const handler = ToolRegistry.getTool("systemTray")?.deviceAwareHandler;

    await handler!(device, {
      action: "find",
      notification: { title: "Test Notification" },
      platform: "android",
    });

    expect(fakeObserveScreen.getCaptureScreenshotCallCount()).toBe(0);
    expect(fakeObserveScreen.getAccessibilityAuditCallCount()).toBe(1);
  });

  test("an enabled accessibility audit captures one fresh terminal screenshot", async () => {
    delete process.env.AUTOMOBILE_ACTION_OBSERVATION_SKIP_SCREENSHOT;
    serverConfig.setAccessibilityAuditConfig({
      level: "AA",
      failureMode: "report",
      useBaseline: false,
    });
    const fakeObserveScreen = new SequencedObserveScreen([
      createObservation(createTrayHierarchy("Test Notification")),
    ]);

    setSystemTrayDependencies({
      timer: new FakeTimer(),
      adbFactory: () => new SequencedFakeAdbExecutor([1000]),
      observeScreenFactory: () => fakeObserveScreen,
    });
    registerInteractionTools();
    const handler = ToolRegistry.getTool("systemTray")?.deviceAwareHandler;

    await handler!(device, {
      action: "find",
      notification: { title: "Test Notification" },
      platform: "android",
    });

    expect(fakeObserveScreen.getExecuteOptions().every((options) => options.skipScreenshot)).toBe(
      true,
    );
    expect(fakeObserveScreen.getCaptureScreenshotCallCount()).toBe(1);
  });
});

describe("iOS systemTray open", () => {
  afterEach(() => {
    resetSystemTrayDependencies();
  });

  test("opens notification center via swipe down", async () => {
    const fakeTimer = new FakeTimer();
    const fakeIosClient = new FakeIosClient();
    const fakeObserveScreen = new SequencedObserveScreen([
      createIosObservation(createIosAppHierarchy()),
      createIosObservation(createIosAppHierarchy()),
      createIosObservation(createIosNotificationCenterHierarchy("Test")),
    ]);

    setSystemTrayDependencies({
      timer: fakeTimer,
      iosClientFactory: () => fakeIosClient,
      observeScreenFactory: () => fakeObserveScreen,
    });

    const resultPromise = ensureSystemTrayOpen(iosDevice, 2000);

    await waitForPendingSleep(fakeTimer);
    fakeTimer.advanceTime(POLL_INTERVAL_MS);

    const result = await resultPromise;

    expect(result.opened).toBe(true);
    expect(result.skipped).toBe(false);
    expect(fakeIosClient.swipeCalls.length).toBe(1);
    expect(fakeIosClient.swipeCalls[0].y1).toBe(5);
    expect(fakeIosClient.swipeCalls[0].y2).toBeGreaterThan(500);
  });

  test("skips swipe if notification center is already open", async () => {
    const fakeTimer = new FakeTimer();
    const fakeIosClient = new FakeIosClient();
    const fakeObserveScreen = new SequencedObserveScreen([
      createIosObservation(createIosNotificationCenterHierarchy("Existing")),
    ]);

    setSystemTrayDependencies({
      timer: fakeTimer,
      iosClientFactory: () => fakeIosClient,
      observeScreenFactory: () => fakeObserveScreen,
    });

    const result = await ensureSystemTrayOpen(iosDevice, 2000);

    expect(result.opened).toBe(false);
    expect(result.skipped).toBe(true);
    expect(fakeIosClient.swipeCalls.length).toBe(0);
  });
});

describe("iOS systemTray close", () => {
  afterEach(() => {
    resetSystemTrayDependencies();
  });

  test("swipes up to close notification center when open", async () => {
    const fakeTimer = new FakeTimer();
    const fakeIosClient = new FakeIosClient();
    const fakeObserveScreen = new SequencedObserveScreen([
      createIosObservation(createIosNotificationCenterHierarchy("Test")),
      createIosObservation(createIosNotificationCenterHierarchy("Test")),
      createIosObservation(createIosAppHierarchy()),
    ]);

    setSystemTrayDependencies({
      timer: fakeTimer,
      iosClientFactory: () => fakeIosClient,
      observeScreenFactory: () => fakeObserveScreen,
    });

    const resultPromise = ensureSystemTrayClosed(iosDevice, 2000);

    await waitForPendingSleep(fakeTimer);
    fakeTimer.advanceTime(POLL_INTERVAL_MS);

    const result = await resultPromise;

    expect(result.closed).toBe(true);
    expect(result.skipped).toBe(false);
    expect(fakeIosClient.swipeCalls.length).toBe(1);
    expect(fakeIosClient.swipeCalls[0].y1).toBeGreaterThan(fakeIosClient.swipeCalls[0].y2);
  });

  test("skips swipe when notification center is already closed", async () => {
    const fakeTimer = new FakeTimer();
    const fakeIosClient = new FakeIosClient();
    const fakeObserveScreen = new SequencedObserveScreen([
      createIosObservation(createIosAppHierarchy()),
    ]);

    setSystemTrayDependencies({
      timer: fakeTimer,
      iosClientFactory: () => fakeIosClient,
      observeScreenFactory: () => fakeObserveScreen,
    });

    const result = await ensureSystemTrayClosed(iosDevice, 2000);

    expect(result.closed).toBe(false);
    expect(result.skipped).toBe(true);
    expect(fakeIosClient.swipeCalls.length).toBe(0);
  });
});

describe("iOS systemTray find", () => {
  afterEach(() => {
    resetSystemTrayDependencies();
  });

  test("finds notification by title in notification center", async () => {
    const fakeTimer = new FakeTimer();
    const fakeIosClient = new FakeIosClient();
    const fakeObserveScreen = new SequencedObserveScreen([
      createIosObservation(createIosAppHierarchy()),
      createIosObservation(createIosAppHierarchy()),
      createIosObservation(createIosNotificationCenterHierarchy("Test Notification")),
      createIosObservation(createIosNotificationCenterHierarchy("Test Notification")),
    ]);

    setSystemTrayDependencies({
      timer: fakeTimer,
      iosClientFactory: () => fakeIosClient,
      observeScreenFactory: () => fakeObserveScreen,
    });

    const resultPromise = waitForNotificationMatch(
      iosDevice,
      { title: "Test Notification" },
      [],
      2000,
    );

    // First sleep: waitForSystemTrayOpen polling (NC not yet open after swipe)
    await waitForPendingSleep(fakeTimer);
    fakeTimer.advanceTime(POLL_INTERVAL_MS);

    const result = await resultPromise;

    expect(result.match).not.toBeNull();
    expect(result.match!.match.matches.title?.text).toBe("Test Notification");
    expect(fakeIosClient.swipeCalls.length).toBe(1);
  });

  test("does not match when notification center is closed", async () => {
    const fakeTimer = new FakeTimer();
    const fakeIosClient = new FakeIosClient();
    const fakeObserveScreen = new SequencedObserveScreen([
      createIosObservation(createIosAppHierarchy()),
      createIosObservation(createIosAppHierarchy()),
      createIosObservation(createIosAppHierarchy()),
    ]);

    setSystemTrayDependencies({
      timer: fakeTimer,
      iosClientFactory: () => fakeIosClient,
      observeScreenFactory: () => fakeObserveScreen,
    });

    const resultPromise = waitForNotificationMatch(
      iosDevice,
      { title: "Test Notification" },
      [],
      500,
    );

    await advancePendingSleeps(fakeTimer, 3);

    const result = await resultPromise;

    expect(result.match).toBeNull();
    expect(fakeIosClient.swipeCalls.length).toBe(1);
  });
});

describe("iOS systemTray tap and dismiss", () => {
  afterEach(() => {
    resetSystemTrayDependencies();
  });

  test("tapElement routes through CtrlProxy", async () => {
    const fakeIosClient = new FakeIosClient();

    setSystemTrayDependencies({
      timer: new FakeTimer(),
      iosClientFactory: () => fakeIosClient,
    });

    const element: Element = {
      bounds: { left: 10, top: 100, right: 380, bottom: 200 },
    };

    await tapElement(iosDevice, element);

    expect(fakeIosClient.tapCalls.length).toBe(1);
    expect(fakeIosClient.tapCalls[0].x).toBe(195);
    expect(fakeIosClient.tapCalls[0].y).toBe(150);
  });

  test("swipeElement routes through CtrlProxy swipe left", async () => {
    const fakeIosClient = new FakeIosClient();

    setSystemTrayDependencies({
      timer: new FakeTimer(),
      iosClientFactory: () => fakeIosClient,
    });

    const element: Element = {
      bounds: { left: 10, top: 100, right: 380, bottom: 200 },
    };

    await swipeElement(iosDevice, element);

    expect(fakeIosClient.swipeCalls.length).toBe(1);
    const swipe = fakeIosClient.swipeCalls[0];
    // Swipe left: startX > endX
    expect(swipe.x1).toBeGreaterThan(swipe.x2);
    expect(swipe.duration).toBe(300);
  });
});
