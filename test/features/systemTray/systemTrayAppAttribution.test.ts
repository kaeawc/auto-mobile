import { afterEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type {
  BootedDevice,
  ObserveResult,
  ViewHierarchyNode,
  ViewHierarchyResult,
} from "../../../src/models";
import { findBestNotificationMatch } from "../../../src/features/systemTray/helpers/matching";
import {
  collectNotificationAttributions,
  getDirectChildNodes,
  nodeIsNotificationRowRoot,
} from "../../../src/features/systemTray/helpers/hierarchy";
import { getHierarchyRoots } from "../../../src/features/systemTray/notificationHints";
import { parseDumpsysNotificationRecords } from "../../../src/features/systemTray/notificationDumpsys";
import { waitForNotificationMatch } from "../../../src/features/systemTray/helpers/runtime";
import { clearMatchingSystemTrayNotifications } from "../../../src/features/systemTray/helpers/dismissal";
import {
  resetSystemTrayDependencies,
  setSystemTrayDependencies,
} from "../../../src/features/systemTray/helpers/dependencies";
import { FakeAdbExecutor } from "../../fakes/FakeAdbExecutor";
import { FakeTimer } from "../../fakes/FakeTimer";
import { FakeObserveScreen } from "../../fakes/FakeObserveScreen";
import { createExecResult } from "../../../src/utils/execResult";
import type { ExecResult } from "../../../src/models";
import type { AdbExecuteOptions } from "../../../src/utils/android-cmdline-tools/interfaces/AdbExecutor";
import { DUMPSYS_MAX_BUFFER } from "../../../src/utils/android-cmdline-tools/dumpsysLimits";
import { buildObserveResult, observeResultFromJsonText } from "../../helpers/observeFixture";

// App-name elements or posting-package records attribute a row; another app's
// name in its title or body never does (#17401).

const fixturesDir = join(import.meta.dir, "../../fixtures");

// Real CtrlProxy shade: a collapsed "Shell" group (Delta, Gamma) above a
// headerless "Set a screen lock" row that carries no app-name element.
const androidShadeJson = JSON.stringify(
  (
    JSON.parse(
      readFileSync(
        join(fixturesDir, "observe/ctrlproxy-headerless-two-notification-group-collapsed.json"),
        "utf8",
      ),
    ) as { viewHierarchy: ViewHierarchyResult }
  ).viewHierarchy,
);
const androidShade = (replace: [string, string][] = []): ViewHierarchyResult =>
  JSON.parse(
    replace.reduce((json, [from, to]) => json.replaceAll(from, to), androidShadeJson),
  ) as ViewHierarchyResult;

// iOS 26.5 notification center whose only row reads "MESSAGES, Grouped, now,
// mt0091c, hello tray"; the leading "MESSAGES" is the row's app attribution.
const iosCaptureText = (
  JSON.parse(
    readFileSync(
      join(fixturesDir, "systemTray/ios-26.5/full-tray-open-messages-grouped.json"),
      "utf8",
    ),
  ) as { content: [{ text: string }] }
).content[0].text;
const iosTray = (replace: [string, string][] = []): ViewHierarchyResult => {
  const text = replace.reduce((json, [from, to]) => json.replaceAll(from, to), iosCaptureText);
  return observeResultFromJsonText(text, "full-tray-open-messages-grouped.json").viewHierarchy!;
};

const SETTINGS_ANDROID = ["Settings", "com.android.settings"];
const SHELL = ["Shell", "com.android.shell"];
const SETTINGS_IOS = ["Settings", "com.apple.Preferences"];
const MESSAGES_IOS = ["Messages", "com.apple.MobileSMS"];

describe("systemTray app filter on Android shade rows", () => {
  test("does not attribute a group child to an app named in its body", () => {
    const shade = androidShade([["delta body", "open Settings to reply"]]);
    expect(
      findBestNotificationMatch(
        shade,
        { title: "Delta", appId: "com.android.settings" },
        SETTINGS_ANDROID,
      ),
    ).toBeNull();
  });

  test("does not attribute a group child to an app named in its title", () => {
    const shade = androidShade([["Delta", "Settings changed"]]);
    expect(
      findBestNotificationMatch(
        shade,
        { body: "delta body", appId: "com.android.settings" },
        SETTINGS_ANDROID,
      ),
    ).toBeNull();
  });

  test("still attributes a group child by its group header's app label", () => {
    const shade = androidShade([["delta body", "open Settings to reply"]]);
    const match = findBestNotificationMatch(
      shade,
      { title: "Delta", appId: "com.android.shell" },
      SHELL,
    );
    expect(match?.match.matches.app).toEqual({ text: "Shell", matchType: "exact" });
  });

  test("does not attribute a headerless row by its body text", () => {
    expect(
      findBestNotificationMatch(
        androidShade(),
        { title: "Set a screen lock", appId: "com.android.settings" },
        ["security"],
      ),
    ).toBeNull();
  });
});

describe("systemTray app filter on iOS notification-center rows", () => {
  const settingsInBody = iosTray([["hello tray", "open Settings"]]);

  test("does not attribute a row to an app named in its body", () => {
    expect(
      findBestNotificationMatch(
        settingsInBody,
        { title: "mt0091c", appId: "com.apple.Preferences" },
        SETTINGS_IOS,
      ),
    ).toBeNull();
  });

  test("does not attribute a row to an app named in its title for an appId-only query", () => {
    const settingsInTitle = iosTray([["mt0091c", "Settings"]]);
    expect(
      findBestNotificationMatch(settingsInTitle, { appId: "com.apple.Preferences" }, SETTINGS_IOS),
    ).toBeNull();
  });

  test("attributes the row by its header app name", () => {
    const match = findBestNotificationMatch(
      settingsInBody,
      { title: "mt0091c", appId: "com.apple.MobileSMS" },
      MESSAGES_IOS,
    );
    expect(match?.match.matches.app).toEqual({ text: "Messages", matchType: "exact" });
  });

  test("attributes an appId-only query by the header app name", () => {
    const match = findBestNotificationMatch(
      settingsInBody,
      { appId: "com.apple.MobileSMS" },
      MESSAGES_IOS,
    );
    expect(match?.match.matches.app).toEqual({ text: "Messages", matchType: "exact" });
  });
});

const silentShade = (
  JSON.parse(
    readFileSync(
      join(fixturesDir, "systemTray/android-35/silent-headerless-row-observe.json"),
      "utf8",
    ),
  ) as { viewHierarchy: ViewHierarchyResult }
).viewHierarchy;
const silentDump = readFileSync(
  join(fixturesDir, "systemTray/android-35/silent-headerless-row-dumpsys-noredact.txt"),
  "utf8",
);
const silentRecords = parseDumpsysNotificationRecords(silentDump);
const POSTER = ["Silent Poster", "dev.l17401.poster"];
const GMAIL = ["Gmail", "com.google.android.gm"];
const dumpCommand = "shell dumpsys notification --noredact";

describe("systemTray headerless Silent rows", () => {
  test("rejects an app named only in the body, with or without a title filter", () => {
    for (const title of [undefined, "Silent Poster"]) {
      expect(
        findBestNotificationMatch(
          silentShade,
          {
            title,
            appId: GMAIL[1],
            dumpsysRecords: () => silentRecords,
          },
          GMAIL,
        ),
      ).toBeNull();
    }
  });

  test("attributes the Silent row to its posting package", () => {
    const match = findBestNotificationMatch(
      silentShade,
      {
        appId: POSTER[1],
        dumpsysRecords: () => silentRecords,
      },
      POSTER,
    );
    expect(match?.match.matches.app).toEqual({ text: POSTER[0], matchType: "exact" });
    expect(match?.match.matched).toBe(true);
  });

  test("fails closed without usable or unambiguous records, preserving content-only matching", () => {
    for (const records of [
      undefined,
      parseDumpsysNotificationRecords("unparseable"),
      [
        ...silentRecords,
        ...silentRecords
          .filter((record) => record.pkg === POSTER[1])
          .map((record) => ({ ...record, pkg: GMAIL[1] })),
      ],
    ]) {
      expect(
        findBestNotificationMatch(
          silentShade,
          {
            title: POSTER[0],
            appId: POSTER[1],
            dumpsysRecords: () => records,
          },
          POSTER,
        ),
      ).toBeNull();
    }
    expect(
      findBestNotificationMatch(
        silentShade,
        {
          title: POSTER[0],
          body: "open Gmail to read mail",
        },
        [],
      )?.match.matched,
    ).toBe(true);
  });

  test("preserves the alerting row's app-name attribution", () => {
    expect(
      findBestNotificationMatch(silentShade, { appId: SHELL[1] }, SHELL)?.match.matches.app,
    ).toEqual({ text: "Shell", matchType: "exact" });
  });
});

describe("systemTray polling dumpsys attribution", () => {
  afterEach(() => resetSystemTrayDependencies());
  const device: BootedDevice = {
    name: "fake",
    deviceId: "fake",
    platform: "android",
    source: "local",
  };
  const setup = (hierarchy: ViewHierarchyResult = silentShade) => {
    const timer = new FakeTimer();
    timer.enableAutoAdvance();
    const adb = new FakeAdbExecutor();
    adb.setDeviceTimestampMs(0);
    adb.setCommandResponse(dumpCommand, createExecResult(silentDump, ""));
    const observer = new FakeObserveScreen();
    const observation: ObserveResult = buildObserveResult({
      viewHierarchy: hierarchy,
      screenSize: { width: 1080, height: 2400 },
      updatedAt: 0,
      systemInsets: { top: 0, right: 0, bottom: 0, left: 0 },
    });
    observer.setObserveResult(observation);
    setSystemTrayDependencies({
      timer,
      adbFactory: () => adb,
      observeScreenFactory: () => observer,
    });
    return { timer, adb, observer };
  };

  test("reads notification-manager records once for a matching observation", async () => {
    const { adb, timer } = setup();
    const controller = new AbortController();
    const result = await waitForNotificationMatch(device, { appId: POSTER[1] }, POSTER, {
      awaitTimeoutMs: 250,
      signal: controller.signal,
    });
    expect(result.match?.match.matches.app).toEqual({ text: POSTER[0], matchType: "exact" });
    expect(adb.getCommandCalls().filter((call) => call.command === dumpCommand)).toEqual([
      {
        command: dumpCommand,
        maxBuffer: DUMPSYS_MAX_BUFFER,
        noRetry: true,
        signal: controller.signal,
      },
    ]);
    expect(timer.getSleepHistory()).toEqual([]);
  });

  test("rejects body app names and refreshes records on every polling observation", async () => {
    const { adb, timer, observer } = setup();
    const result = await waitForNotificationMatch(device, { appId: GMAIL[1] }, GMAIL, {
      awaitTimeoutMs: 250,
    });
    expect(result.match).toBeNull();
    expect(adb.getExecutedCommands().filter((command) => command === dumpCommand).length).toBe(
      observer.getExecuteCallCount(),
    );
    expect(timer.getSleepHistory()).toEqual([250]);
  });

  test("does not read dumpsys without an appId", async () => {
    const { adb } = setup();
    const result = await waitForNotificationMatch(device, { title: POSTER[0] }, [], {
      awaitTimeoutMs: 250,
    });
    expect(result.match).not.toBeNull();
    expect(adb.getExecutedCommands()).not.toContain(dumpCommand);
  });

  test("does not read dumpsys on iOS", async () => {
    const { adb } = setup(iosTray());
    const result = await waitForNotificationMatch(
      { ...device, platform: "ios" },
      { appId: MESSAGES_IOS[1] },
      MESSAGES_IOS,
      { awaitTimeoutMs: 250 },
    );
    expect(result.match).not.toBeNull();
    expect(adb.getExecutedCommands()).not.toContain(dumpCommand);
  });

  test("refreshes unavailable evidence when the next observation arrives", async () => {
    const { adb, timer } = setup();
    adb.setCommandResponseSequence(dumpCommand, [
      createExecResult("unparseable", ""),
      createExecResult(silentDump, ""),
    ]);
    const result = await waitForNotificationMatch(device, { appId: POSTER[1] }, POSTER, {
      awaitTimeoutMs: 500,
    });
    expect(result.match?.match.matches.app).toEqual({ text: POSTER[0], matchType: "exact" });
    expect(adb.getExecutedCommands().filter((command) => command === dumpCommand)).toHaveLength(2);
    expect(timer.getSleepHistory()).toEqual([250]);
  });

  test("read failures leave a headerless row unresolved", async () => {
    const { adb } = setup();
    adb.setCommandError(dumpCommand, new Error("fake read failure"));
    const result = await waitForNotificationMatch(device, { appId: POSTER[1] }, POSTER, {
      awaitTimeoutMs: 250,
    });
    expect(result.match).toBeNull();
  });

  test("does not read dumpsys for rows attributed by their group header", async () => {
    const shade = androidShade();
    const pruneHeaderless = (node: ViewHierarchyNode): void => {
      node.node = getDirectChildNodes(node).filter(
        (child) =>
          !nodeIsNotificationRowRoot(child) || collectNotificationAttributions(child).length > 0,
      );
      for (const child of getDirectChildNodes(node)) {
        pruneHeaderless(child);
      }
    };
    for (const root of getHierarchyRoots(shade)) {
      pruneHeaderless(root);
    }
    const { adb } = setup(shade);
    expect(
      (await waitForNotificationMatch(device, { appId: SHELL[1] }, SHELL, { awaitTimeoutMs: 250 }))
        .match,
    ).not.toBeNull();
    expect(adb.getExecutedCommands()).not.toContain(dumpCommand);
  });
});

// A Shell group whose header renders no app name: each child row is attributed
// only by the notification-manager record that posted it.
const headerlessGroupShade = (): ViewHierarchyResult =>
  androidShade([['"text":"Shell"', '"text":""']]);
const groupChildRecords = (deltaPkg: string) => [
  { pkg: deltaPkg, titles: ["Delta"], bodies: ["delta body"], hasCustomLayout: false },
  { pkg: SHELL[1], titles: ["Gamma"], bodies: ["gamma body"], hasCustomLayout: false },
];

describe("systemTray header-less group children", () => {
  test("the shade fixture's group header carries no app attribution", () => {
    const shade = headerlessGroupShade();
    expect(getHierarchyRoots(shade).flatMap(collectNotificationAttributions)).toEqual([]);
  });

  test("attributes each child to its own posting package", () => {
    const match = findBestNotificationMatch(
      headerlessGroupShade(),
      { title: "Delta", appId: GMAIL[1], dumpsysRecords: () => groupChildRecords(GMAIL[1]) },
      GMAIL,
    );
    expect(match?.match.matches).toEqual({
      title: { text: "Delta", matchType: "exact" },
      app: { text: GMAIL[0], matchType: "exact" },
    });
    expect(
      findBestNotificationMatch(
        headerlessGroupShade(),
        { body: "gamma body", appId: SHELL[1], dumpsysRecords: () => groupChildRecords(GMAIL[1]) },
        SHELL,
      )?.match.matches.app,
    ).toEqual({ text: SHELL[0], matchType: "exact" });
  });

  test("never takes a sibling child's or the group's package", () => {
    for (const [title, records] of [
      ["Delta", groupChildRecords(GMAIL[1])],
      ["Delta", groupChildRecords(GMAIL[1]).slice(1)],
      ["Delta", []],
    ] as const) {
      expect(
        findBestNotificationMatch(
          headerlessGroupShade(),
          { title, appId: SHELL[1], dumpsysRecords: () => records },
          SHELL,
        ),
      ).toBeNull();
    }
  });
});

class HangingDumpsysAdb extends FakeAdbExecutor {
  readonly hungSignals: (AbortSignal | undefined)[] = [];
  private dumpsysReads = 0;

  constructor(private readonly answeredReads: number) {
    super();
  }

  override executeCommand(command: string, options: AdbExecuteOptions = {}): Promise<ExecResult> {
    if (command !== dumpCommand || this.dumpsysReads++ < this.answeredReads) {
      return super.executeCommand(command, options);
    }
    this.hungSignals.push(options.signal);
    return new Promise((_resolve, reject) =>
      options.signal?.addEventListener("abort", () => reject(new Error("dumpsys aborted")), {
        once: true,
      }),
    );
  }
}

describe("systemTray clearAll notification-record reads", () => {
  afterEach(() => resetSystemTrayDependencies());
  const device: BootedDevice = {
    name: "fake",
    deviceId: "fake",
    platform: "android",
    source: "local",
  };
  const setup = (answeredReads: number) => {
    const timer = new FakeTimer();
    timer.enableAutoAdvance();
    const adb = new HangingDumpsysAdb(answeredReads);
    adb.setDeviceTimestampMs(0);
    adb.setCommandResponse(dumpCommand, createExecResult(silentDump, ""));
    const observer = new FakeObserveScreen();
    observer.setObserveResult(
      buildObserveResult({
        viewHierarchy: silentShade,
        screenSize: { width: 1080, height: 2400 },
        updatedAt: 0,
        systemInsets: { top: 0, right: 0, bottom: 0, left: 0 },
      }),
    );
    setSystemTrayDependencies({
      timer,
      adbFactory: () => adb,
      observeScreenFactory: () => observer,
    });
    return { timer, adb };
  };

  test("a hung readiness read times out within each attempt's budget", async () => {
    const { adb, timer } = setup(0);
    await expect(
      clearMatchingSystemTrayNotifications(device, { appId: POSTER[1] }, POSTER, {
        awaitTimeoutMs: 500,
      }),
    ).rejects.toThrow("read timed out");
    expect(adb.hungSignals.length).toBeGreaterThan(0);
    expect(adb.hungSignals.every((signal) => signal?.aborted)).toBe(true);
    expect(timer.now()).toBe(3 * 500 + 250 + 500);
  });

  test("a hung post-swipe read returns partial counts at the verification deadline", async () => {
    const { adb, timer } = setup(1);
    const result = await clearMatchingSystemTrayNotifications(
      device,
      { appId: POSTER[1] },
      POSTER,
      {
        awaitTimeoutMs: 500,
      },
    );
    expect(result).toMatchObject({ swipeCount: 1, dismissedCount: 0, stalled: true });
    expect(adb.hungSignals).toHaveLength(1);
    expect(adb.hungSignals[0]?.aborted).toBe(true);
    expect(timer.now()).toBeLessThanOrEqual(1000);
  });
});
