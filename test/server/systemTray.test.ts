import { afterEach, describe, expect, test } from "bun:test";
import {
  resetSystemTrayDependencies,
  setSystemTrayDependencies,
  waitForNotificationMatch
} from "../../src/server/interactionTools";
import {
  ensureSystemTrayClosed,
  ensureSystemTrayOpen,
  tapElement,
  swipeElement,
} from "../../src/server/systemTrayHelpers";
import type { SystemTrayIosClient } from "../../src/server/systemTrayHelpers";
import { FakeTimer } from "../fakes/FakeTimer";
import { FakeAdbExecutor } from "../fakes/FakeAdbExecutor";
import { FakeObserveScreen } from "../fakes/FakeObserveScreen";
import type { BootedDevice, Element, ObserveResult, ViewHierarchyResult } from "../../src/models";

const POLL_INTERVAL_MS = 250;
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

  async execute(
    queryOptions?: unknown,
    perf?: unknown,
    skipWaitForFresh?: boolean,
    minTimestamp?: number,
    signal?: AbortSignal
  ): Promise<ObserveResult> {
    this.minTimestamps.push(minTimestamp);
    return super.execute(queryOptions, perf, skipWaitForFresh, minTimestamp, signal);
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
  viewHierarchy
});

const createClosedHierarchy = (text: string = ""): ViewHierarchyResult => ({
  packageName: "com.google.android.apps.nexuslauncher",
  hierarchy: {
    node: {
      $: {
        "resource-id": "launcher_root",
        "class": "Launcher",
        "packageName": "com.google.android.apps.nexuslauncher",
        text,
        "bounds": "[0,0][100,100]"
      }
    }
  }
});

const createTrayHierarchy = (title: string): ViewHierarchyResult => ({
  packageName: SYSTEM_TRAY_PACKAGE,
  hierarchy: {
    node: {
      $: {
        "resource-id": "com.android.systemui:id/notification_stack_scroller",
        "class": "NotificationShade",
        "packageName": SYSTEM_TRAY_PACKAGE,
        "bounds": "[0,0][100,100]"
      },
      node: [{
        $: {
          "resource-id": "com.android.systemui:id/notification_row_1",
          "class": "ExpandableNotificationRow",
          "packageName": SYSTEM_TRAY_PACKAGE,
          "text": title,
          "bounds": "[0,0][100,50]"
        }
      }]
    }
  }
});

const device: BootedDevice = {
  name: "Pixel_6",
  platform: "android",
  deviceId: "device-1",
  source: "local"
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
      createObservation(createTrayHierarchy("Test Notification"))
    ]);

    setSystemTrayDependencies({
      timer: fakeTimer,
      adbFactory: () => fakeAdb,
      observeScreenFactory: () => fakeObserveScreen
    });

    const resultPromise = waitForNotificationMatch(
      device,
      { title: "Test Notification" },
      [],
      500
    );

    await waitForPendingSleep(fakeTimer);
    fakeTimer.advanceTime(POLL_INTERVAL_MS);

    const result = await resultPromise;

    expect(result.match).not.toBeNull();
    expect(result.observation.viewHierarchy?.packageName).toBe(SYSTEM_TRAY_PACKAGE);
    expect(fakeAdb.wasCommandExecuted("cmd statusbar expand-notifications")).toBe(true);
    const minTimestamps = fakeObserveScreen.getMinTimestamps();
    expect(minTimestamps[0]).toBe(1000);
    expect(minTimestamps[1]).toBe(2000);
  });

  test("does not return matches while the tray is closed", async () => {
    const fakeTimer = new FakeTimer();
    const fakeAdb = new SequencedFakeAdbExecutor([1000, 2000]);
    const fakeObserveScreen = new SequencedObserveScreen([
      createObservation(createClosedHierarchy("Test Notification")),
      createObservation(createClosedHierarchy("Test Notification")),
      createObservation(createClosedHierarchy("Test Notification"))
    ]);

    setSystemTrayDependencies({
      timer: fakeTimer,
      adbFactory: () => fakeAdb,
      observeScreenFactory: () => fakeObserveScreen
    });

    const resultPromise = waitForNotificationMatch(
      device,
      { title: "Test Notification" },
      [],
      500
    );

    await advancePendingSleeps(fakeTimer, 3);

    const result = await resultPromise;

    expect(result.match).toBeNull();
    expect(result.observation.viewHierarchy?.packageName).toBe("com.google.android.apps.nexuslauncher");
    expect(fakeAdb.wasCommandExecuted("cmd statusbar expand-notifications")).toBe(true);
    expect(fakeObserveScreen.getExecuteCallCount()).toBeGreaterThan(1);
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
      createObservation(createClosedHierarchy())
    ]);

    setSystemTrayDependencies({
      timer: fakeTimer,
      adbFactory: () => fakeAdb,
      observeScreenFactory: () => fakeObserveScreen
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
    const fakeObserveScreen = new SequencedObserveScreen([createObservation(createClosedHierarchy())]);

    setSystemTrayDependencies({
      timer: fakeTimer,
      adbFactory: () => fakeAdb,
      observeScreenFactory: () => fakeObserveScreen
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
  source: "local"
};

const createIosObservation = (viewHierarchy?: ViewHierarchyResult): ObserveResult => ({
  updatedAt: 0,
  screenSize: { width: 390, height: 844 },
  systemInsets: { top: 0, right: 0, bottom: 0, left: 0 },
  viewHierarchy
});

const createIosAppHierarchy = (): ViewHierarchyResult => ({
  packageName: "com.example.app",
  hierarchy: {
    node: {
      $: {
        className: "UIWindow",
        packageName: "com.example.app",
        bounds: "[0,0][390,844]"
      }
    }
  }
});

const createIosNotificationCenterHierarchy = (title: string, body?: string): ViewHierarchyResult => ({
  packageName: IOS_SPRINGBOARD_PACKAGE,
  hierarchy: {
    node: {
      $: {
        className: "NotificationCenter",
        packageName: IOS_SPRINGBOARD_PACKAGE,
        bounds: "[0,0][390,844]"
      },
      node: [{
        $: {
          "className": "NCNotificationListCell",
          "packageName": IOS_SPRINGBOARD_PACKAGE,
          "text": title,
          "content-desc": body ?? "",
          "bounds": "[10,100][380,200]"
        }
      }]
    }
  }
});

// ============================================================================
// Notification group expansion tests
// ============================================================================

const createTrayWithCollapsedGroup = (appLabel: string): ViewHierarchyResult => ({
  packageName: SYSTEM_TRAY_PACKAGE,
  hierarchy: {
    node: {
      $: {
        "resource-id": "com.android.systemui:id/notification_stack_scroller",
        "class": "NotificationShade",
        "packageName": SYSTEM_TRAY_PACKAGE,
        "bounds": "[0,0][1080,1920]"
      },
      node: [{
        $: {
          "resource-id": "com.android.systemui:id/notification_group",
          "class": "ExpandableNotificationRow",
          "packageName": SYSTEM_TRAY_PACKAGE,
          "text": appLabel,
          "bounds": "[0,100][1080,200]"
        }
      }]
    }
  }
});

const createTrayWithExpandedNotification = (
  appLabel: string,
  title: string
): ViewHierarchyResult => ({
  packageName: SYSTEM_TRAY_PACKAGE,
  hierarchy: {
    node: {
      $: {
        "resource-id": "com.android.systemui:id/notification_stack_scroller",
        "class": "NotificationShade",
        "packageName": SYSTEM_TRAY_PACKAGE,
        "bounds": "[0,0][1080,1920]"
      },
      node: [
        {
          $: {
            "resource-id": "com.android.systemui:id/notification_row_1",
            "class": "ExpandableNotificationRow",
            "packageName": SYSTEM_TRAY_PACKAGE,
            "text": title,
            "bounds": "[0,100][1080,200]"
          }
        },
        {
          $: {
            "resource-id": "com.android.systemui:id/notification_row_2",
            "class": "ExpandableNotificationRow",
            "packageName": SYSTEM_TRAY_PACKAGE,
            "text": appLabel,
            "bounds": "[0,200][1080,300]"
          }
        }
      ]
    }
  }
});

describe("systemTray expandGroup", () => {
  afterEach(() => {
    resetSystemTrayDependencies();
  });

  test("taps collapsed group then finds expanded notification", async () => {
    const fakeTimer = new FakeTimer();
    const fakeAdb = new SequencedFakeAdbExecutor([1000, 2000]);
    const fakeObserveScreen = new SequencedObserveScreen([
      createObservation(createTrayWithCollapsedGroup("FUBStaging")),
      createObservation(createTrayWithCollapsedGroup("FUBStaging")),
      createObservation(createTrayWithExpandedNotification("FUBStaging", "New Lead: John Doe"))
    ]);

    setSystemTrayDependencies({
      timer: fakeTimer,
      adbFactory: () => fakeAdb,
      observeScreenFactory: () => fakeObserveScreen
    });

    const resultPromise = waitForNotificationMatch(
      device,
      { title: "New Lead: John Doe" },
      ["FUBStaging"],
      5000,
      undefined,
      true
    );

    // First sleep: after group expansion tap
    await waitForPendingSleep(fakeTimer);
    fakeTimer.advanceTime(POLL_INTERVAL_MS);

    // Second sleep: regular poll loop (obs[1] still collapsed, no re-expand)
    await waitForPendingSleep(fakeTimer);
    fakeTimer.advanceTime(POLL_INTERVAL_MS);

    const result = await resultPromise;

    expect(result.match).not.toBeNull();
    expect(result.match!.match.matches.title?.text).toBe("New Lead: John Doe");
    expect(fakeAdb.wasCommandExecuted("shell input tap")).toBe(true);
  });

  test("does not expand group when expandGroup is false", async () => {
    const fakeTimer = new FakeTimer();
    const fakeAdb = new SequencedFakeAdbExecutor([1000, 2000]);
    const fakeObserveScreen = new SequencedObserveScreen([
      createObservation(createTrayWithCollapsedGroup("FUBStaging")),
      createObservation(createTrayWithCollapsedGroup("FUBStaging")),
      createObservation(createTrayWithCollapsedGroup("FUBStaging"))
    ]);

    setSystemTrayDependencies({
      timer: fakeTimer,
      adbFactory: () => fakeAdb,
      observeScreenFactory: () => fakeObserveScreen
    });

    const resultPromise = waitForNotificationMatch(
      device,
      { title: "New Lead: John Doe" },
      ["FUBStaging"],
      500,
      undefined,
      false
    );

    await advancePendingSleeps(fakeTimer, 3);

    const result = await resultPromise;

    expect(result.match).toBeNull();
  });

  test("does not expand group when expandGroup is undefined", async () => {
    const fakeTimer = new FakeTimer();
    const fakeAdb = new SequencedFakeAdbExecutor([1000, 2000]);
    const fakeObserveScreen = new SequencedObserveScreen([
      createObservation(createTrayWithCollapsedGroup("FUBStaging")),
      createObservation(createTrayWithCollapsedGroup("FUBStaging")),
      createObservation(createTrayWithCollapsedGroup("FUBStaging"))
    ]);

    setSystemTrayDependencies({
      timer: fakeTimer,
      adbFactory: () => fakeAdb,
      observeScreenFactory: () => fakeObserveScreen
    });

    const resultPromise = waitForNotificationMatch(
      device,
      { title: "New Lead: John Doe" },
      ["FUBStaging"],
      500
    );

    await advancePendingSleeps(fakeTimer, 3);

    const result = await resultPromise;

    expect(result.match).toBeNull();
  });

  test("only attempts group expansion once", async () => {
    const fakeTimer = new FakeTimer();
    const fakeAdb = new SequencedFakeAdbExecutor([1000, 2000]);
    const tapCommands: string[] = [];
    const originalExecuteCommand = fakeAdb.executeCommand.bind(fakeAdb);
    fakeAdb.executeCommand = async (command: string) => {
      if (command.startsWith("shell input tap")) {
        tapCommands.push(command);
      }
      return originalExecuteCommand(command);
    };

    const fakeObserveScreen = new SequencedObserveScreen([
      createObservation(createTrayWithCollapsedGroup("FUBStaging")),
      createObservation(createTrayWithCollapsedGroup("FUBStaging")),
      createObservation(createTrayWithCollapsedGroup("FUBStaging")),
      createObservation(createTrayWithCollapsedGroup("FUBStaging"))
    ]);

    setSystemTrayDependencies({
      timer: fakeTimer,
      adbFactory: () => fakeAdb,
      observeScreenFactory: () => fakeObserveScreen
    });

    const resultPromise = waitForNotificationMatch(
      device,
      { title: "New Lead: John Doe" },
      ["FUBStaging"],
      1000,
      undefined,
      true
    );

    await advancePendingSleeps(fakeTimer, 5);

    const result = await resultPromise;

    expect(result.match).toBeNull();
    const tapCount = tapCommands.filter(c => c.startsWith("shell input tap")).length;
    expect(tapCount).toBe(1);
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
      createIosObservation(createIosNotificationCenterHierarchy("Test"))
    ]);

    setSystemTrayDependencies({
      timer: fakeTimer,
      iosClientFactory: () => fakeIosClient,
      observeScreenFactory: () => fakeObserveScreen
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
      createIosObservation(createIosNotificationCenterHierarchy("Existing"))
    ]);

    setSystemTrayDependencies({
      timer: fakeTimer,
      iosClientFactory: () => fakeIosClient,
      observeScreenFactory: () => fakeObserveScreen
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
      createIosObservation(createIosAppHierarchy())
    ]);

    setSystemTrayDependencies({
      timer: fakeTimer,
      iosClientFactory: () => fakeIosClient,
      observeScreenFactory: () => fakeObserveScreen
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
    const fakeObserveScreen = new SequencedObserveScreen([createIosObservation(createIosAppHierarchy())]);

    setSystemTrayDependencies({
      timer: fakeTimer,
      iosClientFactory: () => fakeIosClient,
      observeScreenFactory: () => fakeObserveScreen
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
      createIosObservation(createIosNotificationCenterHierarchy("Test Notification"))
    ]);

    setSystemTrayDependencies({
      timer: fakeTimer,
      iosClientFactory: () => fakeIosClient,
      observeScreenFactory: () => fakeObserveScreen
    });

    const resultPromise = waitForNotificationMatch(
      iosDevice,
      { title: "Test Notification" },
      [],
      2000
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
      createIosObservation(createIosAppHierarchy())
    ]);

    setSystemTrayDependencies({
      timer: fakeTimer,
      iosClientFactory: () => fakeIosClient,
      observeScreenFactory: () => fakeObserveScreen
    });

    const resultPromise = waitForNotificationMatch(
      iosDevice,
      { title: "Test Notification" },
      [],
      500
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
      bounds: { left: 10, top: 100, right: 380, bottom: 200 }
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
      bounds: { left: 10, top: 100, right: 380, bottom: 200 }
    };

    await swipeElement(iosDevice, element);

    expect(fakeIosClient.swipeCalls.length).toBe(1);
    const swipe = fakeIosClient.swipeCalls[0];
    // Swipe left: startX > endX
    expect(swipe.x1).toBeGreaterThan(swipe.x2);
    expect(swipe.duration).toBe(300);
  });
});
