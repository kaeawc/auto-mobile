import { readFileSync } from "node:fs";
import { describe, expect, test } from "bun:test";
import { ActionableError } from "../../../src/models/ActionableError";
import {
  addWatchSmartStackWidget,
  CLOCKFACE_RELAUNCH_SETTLE_MS,
  GALLERY_SCROLL_SETTLE_MS,
  hasGalleryAppRow,
  findUnnamedAddedWidget,
  hasNamelessSmartStackWidget,
  hasSmartStackWidget,
  isSmartStackWidgetPresent,
  verifySmartStackWidget,
} from "../../../src/features/watch/WatchSmartStackWidget";
import { readSmartStackEditTap } from "../../../src/features/watch/WatchSmartStack";
import type {
  WatchCommand,
  WatchRunnerClient,
} from "../../../src/features/watch/WatchRunnerClient";
import { FakeTimer } from "../../fakes/FakeTimer";

const captures = [
  "fixture-face-dump-smartstack.txt",
  "fixture-face-smartstack-after-reload.txt",
].map((name) => readFileSync(new URL(`../../fixtures/watch/${name}`, import.meta.url), "utf8"));
const options = { appName: "ProbeApp", widgetName: "ProbeWidgetXYZ" };
const withEdit = readFileSync(
  new URL("../../fixtures/watch/fixture-face-smartstack-with-edit.txt", import.meta.url),
  "utf8",
);
const noEdit = readFileSync(
  new URL("../../fixtures/watch/fixture-face-smartstack-no-edit.txt", import.meta.url),
  "utf8",
);
// #17793: both cells were added but their identifiers carry empty app and widget names.
const emptyNames = readFileSync(
  new URL("../../fixtures/watch/fixture-face-smartstack-empty-names.txt", import.meta.url),
  "utf8",
);
const galleryWithApp = readFileSync(
  new URL("../../fixtures/watch/fixture-face-gallery-with-app-row.txt", import.meta.url),
  "utf8",
);
const galleryMissingApp = readFileSync(
  new URL("../../fixtures/watch/fixture-face-gallery-missing-app-row.txt", import.meta.url),
  "utf8",
);
const [longTop, longApostrophe, longApostropheNudged, longMiddle, longEnd, longEndSettled] = [
  "top",
  "apostrophe-row",
  "apostrophe-row-nudged",
  "middle",
  "end",
  "end-settled",
].map((suffix) =>
  readFileSync(
    new URL(`../../fixtures/watch/fixture-face-gallery-long-${suffix}.txt`, import.meta.url),
    "utf8",
  ),
);
// An unchanged row set ends the later search; a captured stack dump has no gallery rows.
const missingGalleryDumps = [galleryMissingApp, galleryMissingApp, withEdit];
const TOP_CELL = "6FFE7596-8496-4E83-91C4-563745BD75F9";
const LOWER_CELL = "2FB3A58A-0DA1-4EA7-8D32-C9B36220B980";

/** The dump without the cell whose identifier holds `cellId` and that cell's subtree. */
function withoutCell(dump: string, cellId: string): string {
  const lines = dump.split("\n");
  const start = lines.findIndex((line) => line.includes(`-- ${cellId} --`));
  const depth = (line: string) => line.length - line.trimStart().length;
  const end = lines.findIndex((line, index) => index > start && depth(line) <= depth(lines[start]));
  return [...lines.slice(0, start), ...lines.slice(end)].join("\n");
}
const oneEmptyCell = withoutCell(emptyNames, LOWER_CELL);
const noWidgetCells = withoutCell(oneEmptyCell, TOP_CELL);
const identity = { hostBundleId: "dev.probe.app", widgetKind: "probe" };

/** The dump with the Edit button from the with-edit capture, so it can open the stack. */
function withEditButton(dump: string): string {
  const lines = dump.split("\n");
  const editLines = withEdit.split("\n");
  const editStart = editLines.findIndex((line) => line.includes("{{46.4, 195.8}, {94.2, 20.2}}"));
  const header = lines.findIndex((line) => line.includes("identifier: 'Smart Stack Header'"));
  const end = lines.findIndex((line, index) => index > header && /^ {18}\S/.test(line));
  return [
    ...lines.slice(0, end),
    ...editLines.slice(editStart, editStart + 4),
    ...lines.slice(end),
  ].join("\n");
}

class FakeClient implements Pick<WatchRunnerClient, "request"> {
  readonly commands: WatchCommand[] = [];
  readonly signals: (AbortSignal | undefined)[] = [];
  failure?: Error;
  invalidDump = false;
  onRequest?: () => void;
  constructor(private readonly dumps: string[] = []) {}
  async request(command: WatchCommand, signal?: AbortSignal): Promise<unknown> {
    if (this.failure) {
      throw this.failure;
    }
    this.commands.push(command);
    if (this.invalidDump) {
      return {};
    }
    this.signals.push(signal);
    this.onRequest?.();
    return command.type === "face" && command.op === "dump"
      ? (this.dumps.shift() ?? "container")
      : undefined;
  }
}
function arrange(dumps: string[]) {
  const client = new FakeClient(dumps);
  const timer = new FakeTimer();
  timer.enableAutoAdvance();
  return { client, timer };
}

function openingRound(dumps: number, extraSwipes = 0): WatchCommand[] {
  const commands: WatchCommand[] = [
    { type: "home" },
    { type: "face", op: "swipe", direction: "up" },
    ...Array.from({ length: dumps }, (): WatchCommand => ({ type: "face", op: "dump" })),
  ];
  for (let swipe = 0; swipe < extraSwipes; swipe++) {
    commands.push(
      { type: "face", op: "swipe", direction: "up" },
      { type: "face", op: "dump" },
      { type: "face", op: "dump" },
    );
  }
  return commands;
}
const galleryCommands: WatchCommand[] = [
  { type: "face", op: "tap", x: 0.5, y: (195.8 + 20.2 / 2) / 223 },
  { type: "face", op: "tap", x: 0.5, y: 0.44 },
  { type: "face", op: "swipe", direction: "up" },
  { type: "face", op: "dump" },
  { type: "face", op: "drag", fromX: 0.5, fromY: 0.5, toX: 0.5, toY: 0.6 },
  { type: "face", op: "tap", x: 0.5, y: 0.65 },
  { type: "face", op: "tap", x: 0.5, y: 0.5 },
  { type: "face", op: "tap", x: 0.16, y: 0.14 },
];
function widgetAttemptSleeps(verificationDumps: number): number[] {
  return [250, 250, 250, 250, 1500, 1500, ...Array(verificationDumps + 2).fill(250)];
}
function widgetAttempt(verificationDumps: number): WatchCommand[] {
  return [
    ...openingRound(1),
    ...galleryCommands,
    ...Array.from({ length: verificationDumps }, (): WatchCommand => ({
      type: "face",
      op: "dump",
    })),
  ];
}

function gallerySearchCommands(later: number, earlier = 0): WatchCommand[] {
  return [
    ...Array.from(
      { length: later },
      () =>
        [
          { type: "face", op: "drag", fromX: 0.5, fromY: 0.6, toX: 0.5, toY: 0.4 },
          { type: "face", op: "dump" },
        ] satisfies WatchCommand[],
    ).flat(),
    ...Array.from(
      { length: earlier },
      () =>
        [
          { type: "face", op: "drag", fromX: 0.5, fromY: 0.5, toX: 0.5, toY: 0.6 },
          { type: "face", op: "dump" },
        ] satisfies WatchCommand[],
    ).flat(),
  ];
}
const galleryOpening = [...openingRound(1), ...galleryCommands.slice(0, 4)];
const galleryOpeningSleeps = [250, 250, 250, 250, GALLERY_SCROLL_SETTLE_MS];
const missingRowAttempt = [...galleryOpening, ...gallerySearchCommands(1, 1)];
const missingRowSleeps = [...galleryOpeningSleeps, 1500, 1500];

describe("Smart Stack gallery rows", () => {
  test.each([
    ["top", longTop, "Gecko", "Zebra Probe"],
    ["apostrophe", longApostrophe, "Jason's Probe", "Zebra Probe"],
    ["middle", longMiddle, "News", "Jason's Probe"],
    ["end", longEnd, "Zebra Probe", "Jason's Probe"],
    ["end settled", longEndSettled, "Zebra Probe", "Gecko"],
  ])("reads captured long-gallery rows (%s)", (_fixture, dump, present, absent) => {
    expect(hasGalleryAppRow(dump, present)).toBe(true);
    expect(hasGalleryAppRow(dump, absent)).toBe(false);
    expect(hasGalleryAppRow(dump, "ProbeApp")).toBe(false);
  });
  test("matches apostrophes exactly without accepting prefixes or suffixes", () => {
    expect(hasGalleryAppRow(longApostrophe, "Jason's Probe")).toBe(true);
    for (const name of ["Jason", "Jason's", "Jason's Probe2"]) {
      expect(hasGalleryAppRow(longApostrophe, name)).toBe(false);
    }
  });
  test.each([
    [
      "Zebra Probe",
      { dumps: [longApostrophe, longMiddle, longEnd], later: 3, earlier: 0, y: 168 / 223 },
    ],
    [
      "Jason's Probe",
      { dumps: [longApostrophe, longApostropheNudged], later: 1, earlier: 1, y: 71.25 / 223 },
    ],
  ] as const)(
    "scrolls to %s and taps its visible row centre",
    async (appName, { dumps, later, earlier, y }) => {
      const { client, timer } = arrange([withEdit, longTop, ...dumps, emptyNames]);
      let relaunches = 0;
      const result = await addWatchSmartStackWidget(
        client,
        { ...options, ...identity, appName },
        {
          timer,
          relaunchClockface: async () => {
            relaunches++;
          },
        },
      );
      expect(result).toMatchObject({ success: true, attempts: 1, galleryRowMisses: 0 });
      expect(relaunches).toBe(0);
      expect(client.commands).toEqual([
        ...galleryOpening,
        ...gallerySearchCommands(later, earlier),
        { type: "face", op: "tap", x: 0.5, y },
        ...galleryCommands.slice(-2),
        { type: "face", op: "dump" },
      ]);
      expect(timer.getSleepHistory()).toEqual([
        ...galleryOpeningSleeps,
        ...Array(dumps.length).fill(GALLERY_SCROLL_SETTLE_MS),
        250,
        250,
        250,
      ]);
    },
  );
  test.each([
    ["fully visible", "Zebra Probe", longEnd, 168 / 223],
    [
      "24 points visible at the bottom",
      "Zebra Probe",
      longEnd.replace("{{2.0, 144.0}, {183.0, 48.0}}", "{{2.0, 199.0}, {183.0, 48.0}}"),
      211 / 223,
    ],
    [
      "no navigation bar",
      "Jason's Probe",
      longApostrophe.replaceAll("NavigationBar,", "Other,"),
      45.5 / 223,
    ],
  ] as const)("uses the visible-range midpoint: %s", async (_case, appName, dump, y) => {
    const { client, timer } = arrange([withEdit, longTop, dump, emptyNames]);
    const result = await addWatchSmartStackWidget(
      client,
      { ...options, ...identity, appName },
      { timer },
    );
    expect(result).toMatchObject({ success: true, galleryRowMisses: 0 });
    expect(client.commands).toEqual([
      ...galleryOpening,
      ...gallerySearchCommands(1),
      { type: "face", op: "tap", x: 0.5, y },
      ...galleryCommands.slice(-2),
      { type: "face", op: "dump" },
    ]);
    expect(timer.getSleepHistory()).toEqual([
      ...galleryOpeningSleeps,
      GALLERY_SCROLL_SETTLE_MS,
      250,
      250,
      250,
    ]);
  });
  test("never taps a top-covered row after three unsuccessful corrective drags", async () => {
    const { client, timer } = arrange([withEdit, longTop, ...Array(4).fill(longApostrophe)]);
    const result = await addWatchSmartStackWidget(
      client,
      { ...options, appName: "Jason's Probe" },
      { timer },
    );
    expect(result).toMatchObject({ success: false, galleryRowMisses: 1, verificationAttempts: 0 });
    expect(client.commands).toEqual([...galleryOpening, ...gallerySearchCommands(1, 3)]);
    expect(timer.getSleepHistory()).toEqual([
      ...galleryOpeningSleeps,
      ...Array(4).fill(GALLERY_SCROLL_SETTLE_MS),
    ]);
  });
  test("counts corrective drags toward the direction's eight-step cap", async () => {
    const changing = Array.from({ length: 6 }, (_, index) =>
      index % 2 === 0 ? longMiddle : longTop,
    );
    const { client, timer } = arrange([
      withEdit,
      longTop,
      ...changing,
      longApostrophe,
      longMiddle,
      ...Array(3).fill(longApostrophe),
    ]);
    const result = await addWatchSmartStackWidget(
      client,
      { ...options, appName: "Jason's Probe" },
      { timer },
    );
    expect(result).toMatchObject({ success: false, galleryRowMisses: 1, verificationAttempts: 0 });
    expect(client.commands).toEqual([...galleryOpening, ...gallerySearchCommands(7, 4)]);
    expect(timer.getSleepHistory()).toEqual([
      ...galleryOpeningSleeps,
      ...Array(11).fill(GALLERY_SCROLL_SETTLE_MS),
    ]);
  });
  test("searches earlier after the later boundary and taps the row found there", async () => {
    const { client, timer } = arrange([
      withEdit,
      longMiddle,
      longEnd,
      longEndSettled,
      longTop,
      longTop.replace("{{2.0, 30.5}, {183.0, 48.0}}", "{{2.0, 38.5}, {183.0, 48.0}}"),
      emptyNames,
    ]);
    const result = await addWatchSmartStackWidget(
      client,
      { ...options, ...identity, appName: "Gecko" },
      { timer },
    );
    expect(result).toMatchObject({ success: true, galleryRowMisses: 0 });
    expect(client.commands).toEqual([
      ...galleryOpening,
      ...gallerySearchCommands(2, 2),
      { type: "face", op: "tap", x: 0.5, y: 71.25 / 223 },
      ...galleryCommands.slice(-2),
      { type: "face", op: "dump" },
    ]);
    expect(timer.getSleepHistory()).toEqual([
      ...galleryOpeningSleeps,
      1500,
      1500,
      1500,
      1500,
      250,
      250,
      250,
    ]);
  });
  test("stops at repeated row sets and an empty earlier dump before relaunching once", async () => {
    const { client, timer } = arrange([
      withEdit,
      longTop,
      longApostrophe,
      longMiddle,
      longEnd,
      longEndSettled,
      longTop,
      withEdit,
      withEdit,
      galleryWithApp,
      captures[1],
    ]);
    const commandsAtRelaunch: number[] = [];
    const result = await addWatchSmartStackWidget(client, options, {
      timer,
      relaunchClockface: async () => {
        commandsAtRelaunch.push(client.commands.length);
      },
    });
    const search = [...galleryOpening, ...gallerySearchCommands(4, 2)];
    expect(result).toMatchObject({ success: true, attempts: 2, galleryRowMisses: 1 });
    expect(commandsAtRelaunch).toEqual([search.length]);
    expect(client.commands).toEqual([...search, ...widgetAttempt(1)]);
    expect(timer.getSleepHistory()).toEqual([
      ...galleryOpeningSleeps,
      ...Array(6).fill(GALLERY_SCROLL_SETTLE_MS),
      CLOCKFACE_RELAUNCH_SETTLE_MS,
      ...widgetAttemptSleeps(1),
    ]);
  });
  test.each([
    ["keeps scrolling when the same rows moved", [longApostropheNudged, longApostropheNudged], 2],
    ["stops when rows and frames are unchanged", [longApostrophe], 1],
  ] as const)("detects the later boundary by row frames: %s", async (_case, later, drags) => {
    const { client, timer } = arrange([withEdit, longApostrophe, ...later, withEdit]);
    const result = await addWatchSmartStackWidget(client, options, { timer });
    expect(result).toMatchObject({ success: false, attempts: 1, galleryRowMisses: 1 });
    expect(client.commands).toEqual([...galleryOpening, ...gallerySearchCommands(drags, 1)]);
    expect(timer.getSleepHistory()).toEqual([
      ...galleryOpeningSleeps,
      ...Array(drags + 1).fill(GALLERY_SCROLL_SETTLE_MS),
    ]);
  });
  test("bounds changing row sets at eight scrolls in each direction", async () => {
    const changing = Array.from({ length: 16 }, (_, index) =>
      index % 2 === 0 ? longMiddle : longTop,
    );
    const { client, timer } = arrange([withEdit, longTop, ...changing]);
    const result = await addWatchSmartStackWidget(client, options, { timer });
    expect(result).toMatchObject({ success: false, attempts: 1, galleryRowMisses: 1 });
    expect(result.reason).toContain("Smart Stack gallery has no row for ProbeApp");
    expect(client.commands).toEqual([...galleryOpening, ...gallerySearchCommands(8, 8)]);
    expect(timer.getSleepHistory()).toEqual([
      ...galleryOpeningSleeps,
      ...Array(16).fill(GALLERY_SCROLL_SETTLE_MS),
    ]);
  });
  test("continues later when a bottom-clipped row has less than 24 points visible", async () => {
    const clipped = longEnd.replace(
      "{{2.0, 144.0}, {183.0, 48.0}}",
      "{{2.0, 200.0}, {183.0, 48.0}}",
    );
    const { client, timer } = arrange([withEdit, longTop, clipped, clipped, withEdit, withEdit]);
    const result = await addWatchSmartStackWidget(
      client,
      { ...options, appName: "Zebra Probe" },
      { timer },
    );
    expect(result).toMatchObject({ success: false, galleryRowMisses: 1, verificationAttempts: 0 });
    expect(client.commands).toEqual([...galleryOpening, ...gallerySearchCommands(3, 1)]);
    expect(timer.getSleepHistory()).toEqual([
      ...galleryOpeningSleeps,
      ...Array(4).fill(GALLERY_SCROLL_SETTLE_MS),
    ]);
  });
  test("keeps the calibrated flow when the app row is already visible", async () => {
    const { client, timer } = arrange([withEdit, galleryWithApp, captures[1]]);
    const result = await addWatchSmartStackWidget(client, options, { timer });
    expect(result).toMatchObject({ success: true, galleryRowMisses: 0 });
    expect(client.commands).toEqual(widgetAttempt(1));
    expect(timer.getSleepHistory()).toEqual(widgetAttemptSleeps(1));
  });
  test("skips recovery when only the third and final attempt misses the row", async () => {
    const unverified = [withEdit, galleryWithApp, ...Array(10).fill(withEdit)];
    const { client, timer } = arrange([
      ...unverified,
      ...unverified,
      withEdit,
      ...missingGalleryDumps,
    ]);
    let relaunches = 0;
    const result = await addWatchSmartStackWidget(client, options, {
      timer,
      relaunchClockface: async () => {
        relaunches++;
      },
    });
    expect(result).toMatchObject({ success: false, attempts: 3, galleryRowMisses: 1 });
    expect(result.reason).toContain("never appeared during 1 of 3 attempts");
    expect(result.reason).toContain("xcrun simctl terminate <udid> com.apple.clockface");
    expect(relaunches).toBe(0);
    expect(client.commands).toEqual([
      ...widgetAttempt(10),
      ...widgetAttempt(10),
      ...missingRowAttempt,
    ]);
    expect(timer.getSleepHistory()).toEqual([
      ...widgetAttemptSleeps(10),
      20000,
      ...widgetAttemptSleeps(10),
      20000,
      ...missingRowSleeps,
    ]);
    expect(timer.getSleepHistory()).not.toContain(CLOCKFACE_RELAUNCH_SETTLE_MS);
  });
  test("distinguishes present, missing and unknown gallery rows in real dumps", () => {
    expect(hasGalleryAppRow(galleryWithApp, "ProbeApp")).toBe(true);
    expect(hasGalleryAppRow(galleryMissingApp, "ProbeApp")).toBe(false);
    expect(hasGalleryAppRow(galleryMissingApp, "Now Playing")).toBe(true);
    for (const dump of ["", "container", withEdit]) {
      expect(hasGalleryAppRow(dump, "ProbeApp")).toBeUndefined();
    }
  });
  test("matches only the complete gallery cell identifier, not labels or substrings", () => {
    expect(hasGalleryAppRow(galleryWithApp, "Probe")).toBe(false);
    expect(hasGalleryAppRow(galleryWithApp, "ProbeApp2")).toBe(false);
    expect(
      hasGalleryAppRow(
        galleryWithApp.replace("AppGroupCell -- ProbeApp'", "AppGroupCell -- ProbeApp2'"),
        "ProbeApp",
      ),
    ).toBe(false);
    expect(
      hasGalleryAppRow(galleryWithApp.replaceAll("Cell,", "Other,"), "ProbeApp"),
    ).toBeUndefined();
    expect(
      hasGalleryAppRow("Cell, identifier: 'AppGroupCell -- ProbeApp", "ProbeApp"),
    ).toBeUndefined();
    expect(hasGalleryAppRow("Cell, label: 'AppGroupCell -- ProbeApp'", "ProbeApp")).toBeUndefined();
    expect(hasGalleryAppRow("Cell, identifier: 'AppGroupCell -- App.*'", "App.*")).toBe(true);
    expect(hasGalleryAppRow("Cell, identifier: 'AppGroupCell -- AppXYZ'", "App.*")).toBe(false);
  });
  test.each(["", "container"])(
    "preserves calibrated gestures for unknown dump %j",
    async (dump) => {
      const { client, timer } = arrange([withEdit, dump, captures[1]]);
      const result = await addWatchSmartStackWidget(client, options, { timer });
      expect(result).toMatchObject({ success: true, galleryRowMisses: 0, verificationAttempts: 1 });
      expect(client.commands).toEqual(widgetAttempt(1));
      expect(timer.getSleepHistory()).toEqual(widgetAttemptSleeps(1));
    },
  );
  test("relaunches once after a miss and succeeds on the next attempt without retry delay", async () => {
    const { client, timer } = arrange([
      withEdit,
      ...missingGalleryDumps,
      withEdit,
      galleryWithApp,
      captures[1],
    ]);
    const commandsAtRelaunch: number[] = [];
    const result = await addWatchSmartStackWidget(client, options, {
      timer,
      relaunchClockface: async () => {
        commandsAtRelaunch.push(client.commands.length);
      },
    });
    expect(result).toMatchObject({
      success: true,
      attempts: 2,
      galleryRowMisses: 1,
      verificationAttempts: 1,
    });
    expect(commandsAtRelaunch).toEqual([missingRowAttempt.length]);
    expect(client.commands).toEqual([...missingRowAttempt, ...widgetAttempt(1)]);
    expect(timer.getSleepHistory()).toEqual([
      ...missingRowSleeps,
      CLOCKFACE_RELAUNCH_SETTLE_MS,
      ...widgetAttemptSleeps(1),
    ]);
  });
  test("stops on a missing row without a relaunch dependency before any blind gestures", async () => {
    const { client, timer } = arrange([withEdit, ...missingGalleryDumps]);
    const result = await addWatchSmartStackWidget(client, options, { timer });
    expect(result).toMatchObject({
      success: false,
      attempts: 1,
      galleryRowMisses: 1,
      verificationAttempts: 0,
    });
    expect(result.reason).toBe(
      "Smart Stack gallery has no row for ProbeApp. Relaunch com.apple.clockface (xcrun simctl terminate <udid> com.apple.clockface) and retry.",
    );
    expect(client.commands).toEqual(missingRowAttempt);
    expect(timer.getSleepHistory()).toEqual(missingRowSleeps);
  });
  test("keeps a missed attempt's header for the next already-present check", async () => {
    const { client, timer } = arrange([
      withEditButton(noWidgetCells),
      ...missingGalleryDumps,
      withEditButton(oneEmptyCell),
    ]);
    let relaunches = 0;
    const result = await addWatchSmartStackWidget(client, options, {
      timer,
      relaunchClockface: async () => {
        relaunches++;
      },
    });
    expect(result).toMatchObject({
      success: true,
      alreadyPresent: true,
      attempts: 2,
      galleryRowMisses: 1,
      verificationAttempts: 0,
    });
    expect(relaunches).toBe(1);
    expect(client.commands).toEqual([...missingRowAttempt, ...openingRound(1)]);
    expect(timer.getSleepHistory()).toEqual([
      ...missingRowSleeps,
      CLOCKFACE_RELAUNCH_SETTLE_MS,
      250,
      250,
    ]);
  });
  test("surfaces relaunch rejection through the existing failure path", async () => {
    const { client, timer } = arrange([withEdit, ...missingGalleryDumps]);
    const result = await addWatchSmartStackWidget(client, options, {
      timer,
      relaunchClockface: async () => {
        throw new ActionableError("Clockface termination failed");
      },
    });
    expect(result).toMatchObject({
      success: false,
      attempts: 1,
      galleryRowMisses: 1,
      verificationAttempts: 0,
    });
    expect(result.reason).toContain("Clockface termination failed");
    expect(client.commands).toEqual(missingRowAttempt);
    expect(timer.getSleepHistory()).toEqual(missingRowSleeps);
  });
  test.each([true, false])(
    "requires widget readback after mixed gallery and verification failures (miss first: %s)",
    async (missFirst) => {
      const missing = [withEdit, ...missingGalleryDumps];
      const unverified = [withEdit, galleryWithApp, ...Array(10).fill("container")];
      const { client, timer } = arrange(
        missFirst ? [...missing, ...unverified] : [...unverified, ...missing],
      );
      const result = await addWatchSmartStackWidget(
        client,
        { ...options, maxAttempts: 2 },
        {
          timer,
          relaunchClockface: async () => {},
        },
      );
      expect(result).toMatchObject({
        success: false,
        attempts: 2,
        galleryRowMisses: 1,
        verificationAttempts: 10,
      });
      expect(result.reason).toContain(
        "gallery row for ProbeApp never appeared during 1 of 2 attempts",
      );
      expect(timer.getSleepHistory().filter((ms) => ms === 20000)).toHaveLength(missFirst ? 0 : 1);
    },
  );
  test.each(["dump", "relaunch", "settle"])(
    "honors cancellation during gallery %s",
    async (phase) => {
      const { client, timer } = arrange([withEdit, ...missingGalleryDumps]);
      const controller = new AbortController();
      let relaunches = 0;
      const cancel = () => controller.abort(new ActionableError("Cancelled gallery recovery"));
      client.onRequest = () => {
        if (phase === "dump" && client.commands.length === missingRowAttempt.length) {
          cancel();
        }
      };
      const result = await addWatchSmartStackWidget(
        client,
        { ...options, signal: controller.signal },
        {
          timer,
          relaunchClockface: async () => {
            relaunches++;
            if (phase === "relaunch") {
              cancel();
            }
            if (phase === "settle") {
              timer.setTimeout(cancel, 1000);
            }
          },
        },
      );
      expect(result).toMatchObject({
        success: false,
        attempts: 1,
        galleryRowMisses: 1,
        verificationAttempts: 0,
      });
      expect(result.reason).toContain("Cancelled gallery recovery");
      expect(relaunches).toBe(phase === "dump" ? 0 : 1);
      expect(client.commands).toEqual(missingRowAttempt);
      expect(timer.getSleepHistory()).toEqual([
        ...missingRowSleeps,
        ...(phase === "settle" ? [CLOCKFACE_RELAUNCH_SETTLE_MS] : []),
      ]);
    },
  );
  test.each([1, 3, 5])("bounds persistent gallery misses at %i attempts", async (maxAttempts) => {
    const { client, timer } = arrange(
      Array.from({ length: maxAttempts }, () => [withEdit, ...missingGalleryDumps]).flat(),
    );
    let relaunches = 0;
    const result = await addWatchSmartStackWidget(
      client,
      { ...options, maxAttempts },
      {
        timer,
        relaunchClockface: async () => {
          relaunches++;
        },
      },
    );
    expect(result).toMatchObject({
      success: false,
      attempts: maxAttempts,
      galleryRowMisses: maxAttempts,
      verificationAttempts: 0,
    });
    expect(result.reason).toContain("gallery row for ProbeApp never appeared");
    expect(relaunches).toBe(maxAttempts - 1);
    expect(result.reason).toContain("xcrun simctl terminate <udid> com.apple.clockface");
    expect(client.commands).toEqual(
      Array.from({ length: maxAttempts }, () => missingRowAttempt).flat(),
    );
    expect(timer.getSleepHistory()).toEqual(
      Array.from({ length: maxAttempts }, (_, attempt) => [
        ...missingRowSleeps,
        ...(attempt < maxAttempts - 1 ? [CLOCKFACE_RELAUNCH_SETTLE_MS] : []),
      ]).flat(),
    );
  });
});

describe("Smart Stack widget", () => {
  test("reads Edit button tap coordinates from the parsed fixture", () => {
    expect(readSmartStackEditTap(withEdit)).toEqual({ x: 0.5, y: (195.8 + 20.2 / 2) / 223 });
    expect(readSmartStackEditTap(noEdit)).toBeUndefined();
    expect(readSmartStackEditTap("container")).toBeUndefined();
  });
  test("matches exact app/widget cell fields in both real captures", () => {
    for (const capture of captures) {
      expect(hasSmartStackWidget(capture, options.appName, options.widgetName)).toBe(true);
      expect(hasSmartStackWidget(capture, "Probe", options.widgetName)).toBe(false);
      expect(hasSmartStackWidget(capture, options.appName, "ProbeWidget")).toBe(false);
      expect(hasSmartStackWidget(capture, "OtherApp", options.widgetName)).toBe(false);
      expect(
        hasSmartStackWidget(
          capture.replaceAll("Cell,", "Other,"),
          options.appName,
          options.widgetName,
        ),
      ).toBe(false);
    }
  });
  test("the empty-name capture has no exact name match", () => {
    expect(hasSmartStackWidget(emptyNames, options.appName, options.widgetName)).toBe(false);
  });
  test.each([
    ["no widget cell", noWidgetCells, oneEmptyCell, TOP_CELL],
    ["one empty-name cell", oneEmptyCell, emptyNames, LOWER_CELL],
  ])(
    "accepts the one empty-name cell added to a stack with %s",
    (_label, baseline, dump, cellId) => {
      expect(findUnnamedAddedWidget(dump, baseline, options.appName)?.card).toMatchObject({
        cellId,
        appName: "",
        widgetName: "",
        hostBundleId: "dev.probe.app",
        widgetKind: "probe",
      });
      expect(verifySmartStackWidget(dump, baseline, options)).toBe(true);
    },
  );
  test.each([
    ["the stack is unchanged", emptyNames, emptyNames],
    ["two cells appeared at once", noWidgetCells, emptyNames],
    ["a baseline cell disappeared", captures[0], emptyNames],
    ["a cell was removed", emptyNames, oneEmptyCell],
    ["the baseline is not a dump", "container", oneEmptyCell],
    ["the readback is not a dump", noWidgetCells, "container"],
    ["the cell is named for another widget", captures[0].replace(/Cell, .*\n/, ""), captures[0]],
  ])("rejects an empty-name readback when %s", (_label, baseline, dump) => {
    expect(findUnnamedAddedWidget(dump, baseline, options.appName)).toBeUndefined();
    expect(
      verifySmartStackWidget(dump, baseline, { appName: "OtherApp", widgetName: "OtherWidget" }),
    ).toBe(false);
  });
  test("rejects a new empty-name cell whose labels do not hold the app name", () => {
    expect(findUnnamedAddedWidget(oneEmptyCell, noWidgetCells, "OtherApp")).toBeUndefined();
    expect(
      findUnnamedAddedWidget(
        oneEmptyCell.replaceAll("label: 'ProbeApp'", "label: 'Other'"),
        noWidgetCells,
        options.appName,
      ),
    ).toBeUndefined();
  });
  test("rejects a duplicated cell id", () => {
    const duplicated = emptyNames.replace(LOWER_CELL, TOP_CELL);
    expect(findUnnamedAddedWidget(duplicated, noWidgetCells, options.appName)).toBeUndefined();
  });
  test("succeeds on the first attempt with a captured widget readback", async () => {
    const { client, timer } = arrange([withEdit, galleryWithApp, "container", captures[1]]);
    const result = await addWatchSmartStackWidget(client, options, { timer });
    expect(result).toMatchObject({
      success: true,
      attempts: 1,
      headerAttempts: 1,
      verificationAttempts: 2,
      steps: 13,
    });
    expect(client.commands).toEqual(widgetAttempt(2));
  });
  test("compares a retry against that attempt's own header dump", async () => {
    const { client, timer } = arrange([
      withEdit,
      galleryWithApp,
      ...Array(10).fill("container"),
      withEdit,
      galleryWithApp,
      captures[1],
    ]);
    const result = await addWatchSmartStackWidget(client, options, { timer });
    expect(result).toMatchObject({ success: true, attempts: 2, verificationAttempts: 11 });
  });
  test("fails when the empty-name cell was already on the stack before the edit", async () => {
    const { client, timer } = arrange([withEdit, galleryWithApp, ...Array(10).fill(emptyNames)]);
    const result = await addWatchSmartStackWidget(
      client,
      { ...options, maxAttempts: 1 },
      { timer },
    );
    expect(result).toMatchObject({ success: false, attempts: 1, verificationAttempts: 10 });
    expect(result.reason).toContain("Widget cell did not appear");
  });
  test("matches a nameless cell by host bundle id and widget kind", () => {
    expect(hasNamelessSmartStackWidget(emptyNames, identity)).toBe(true);
    expect(isSmartStackWidgetPresent(emptyNames, { ...options, ...identity })).toBe(true);
    expect(hasNamelessSmartStackWidget(emptyNames, { ...identity, widgetKind: "other" })).toBe(
      false,
    );
    expect(
      hasNamelessSmartStackWidget(emptyNames, { ...identity, hostBundleId: "dev.other.app" }),
    ).toBe(false);
    expect(hasNamelessSmartStackWidget(emptyNames, { hostBundleId: "dev.probe.app" })).toBe(false);
    expect(hasNamelessSmartStackWidget(noWidgetCells, identity)).toBe(false);
    expect(hasNamelessSmartStackWidget("container", identity)).toBe(false);
    // A named cell for the same descriptor is matched by names, never as a nameless cell.
    expect(hasNamelessSmartStackWidget(captures[0], identity)).toBe(false);
    expect(verifySmartStackWidget(emptyNames, emptyNames, { ...options, ...identity })).toBe(true);
  });
  test("the edit-button helper keeps the cells and opens the stack", () => {
    const header = withEditButton(emptyNames);
    expect(readSmartStackEditTap(header)).toEqual(readSmartStackEditTap(withEdit));
    expect(hasNamelessSmartStackWidget(header, identity)).toBe(true);
  });
  test("verifies a nameless readback by identity when the cell was already counted", async () => {
    const { client, timer } = arrange([withEditButton(noWidgetCells), galleryWithApp, emptyNames]);
    const result = await addWatchSmartStackWidget(
      client,
      { ...options, ...identity, maxAttempts: 1 },
      { timer },
    );
    expect(result).toMatchObject({ success: true, alreadyPresent: false, attempts: 1 });
    expect(client.commands).toEqual(widgetAttempt(1));
  });
  test.each([
    ["a named cell", withEditButton(captures[0]), options],
    [
      "a nameless cell with a matching identity",
      withEditButton(emptyNames),
      { ...options, ...identity },
    ],
  ])("adds nothing when %s is already on the stack", async (_label, header, target) => {
    const { client, timer } = arrange([header]);
    const result = await addWatchSmartStackWidget(client, target, { timer });
    expect(result).toMatchObject({
      success: true,
      alreadyPresent: true,
      attempts: 1,
      headerAttempts: 1,
      verificationAttempts: 0,
      galleryRowMisses: 0,
    });
    expect(result.reason).toContain("no widget was added");
    expect(client.commands).toEqual(openingRound(1));
  });
  test("a retry adds no duplicate when the first attempt's nameless cell landed late", async () => {
    const { client, timer } = arrange([
      withEditButton(noWidgetCells),
      galleryWithApp,
      ...Array(10).fill(withEditButton(noWidgetCells)),
      withEditButton(oneEmptyCell),
    ]);
    const result = await addWatchSmartStackWidget(client, options, { timer });
    expect(result).toMatchObject({ success: true, alreadyPresent: true, attempts: 2 });
    expect(client.commands).toEqual([...widgetAttempt(10), ...openingRound(1)]);
  });
  test("a retry still edits when the nameless cell was already there before the first attempt", async () => {
    const { client, timer } = arrange([
      withEditButton(oneEmptyCell),
      galleryWithApp,
      ...Array(10).fill(withEditButton(oneEmptyCell)),
      withEditButton(oneEmptyCell),
      galleryWithApp,
      withEditButton(emptyNames),
    ]);
    const result = await addWatchSmartStackWidget(
      client,
      { ...options, maxAttempts: 2 },
      { timer },
    );
    expect(result).toMatchObject({ success: true, alreadyPresent: false, attempts: 2 });
    expect(client.commands).toEqual([...widgetAttempt(10), ...widgetAttempt(1)]);
  });
  test.each([
    [{ hostBundleId: "dev.probe.app" }],
    [{ widgetKind: "probe" }],
    [{ hostBundleId: " ", widgetKind: "probe" }],
  ])("rejects a partial widget identity %p", async (partial) => {
    const { client, timer } = arrange([]);
    await expect(
      addWatchSmartStackWidget(client, { ...options, ...partial }, { timer }),
    ).rejects.toThrow("Provide both hostBundleId and widgetKind");
    expect(client.commands).toEqual([]);
  });
  test("uses clockface commands in order and polls past container-only dumps", async () => {
    const { client, timer } = arrange([
      "container",
      withEdit,
      galleryWithApp,
      "container",
      captures[1],
    ]);
    const result = await addWatchSmartStackWidget(client, options, { timer });
    expect(result).toMatchObject({
      success: true,
      attempts: 1,
      steps: 14,
      headerAttempts: 2,
      verificationAttempts: 2,
    });
    expect(client.commands).toEqual([
      { type: "home" },
      { type: "face", op: "swipe", direction: "up" },
      { type: "face", op: "dump" },
      { type: "face", op: "dump" },
      { type: "face", op: "tap", x: 0.5, y: (195.8 + 20.2 / 2) / 223 },
      { type: "face", op: "tap", x: 0.5, y: 0.44 },
      { type: "face", op: "swipe", direction: "up" },
      { type: "face", op: "dump" },
      { type: "face", op: "drag", fromX: 0.5, fromY: 0.5, toX: 0.5, toY: 0.6 },
      { type: "face", op: "tap", x: 0.5, y: 0.65 },
      { type: "face", op: "tap", x: 0.5, y: 0.5 },
      { type: "face", op: "tap", x: 0.16, y: 0.14 },
      { type: "face", op: "dump" },
      { type: "face", op: "dump" },
    ]);
    expect(timer.getSleepHistory()).toEqual([250, ...widgetAttemptSleeps(2)]);
  });
  test("recovers a swallowed first home on the second opening round", async () => {
    const { client, timer } = arrange([
      ...Array(8).fill("container"),
      withEdit,
      galleryWithApp,
      captures[1],
    ]);
    const result = await addWatchSmartStackWidget(client, options, { timer });
    expect(result).toMatchObject({
      success: true,
      attempts: 1,
      headerAttempts: 9,
      verificationAttempts: 1,
      steps: 25,
    });
    expect(client.commands).toEqual([
      ...openingRound(2, 3),
      ...openingRound(1),
      ...galleryCommands,
      { type: "face", op: "dump" },
    ]);
    expect(timer.getSleepHistory()).toEqual([
      ...Array(11).fill(250),
      ...widgetAttemptSleeps(1).slice(2),
    ]);
  });
  test.each([undefined, 0, 1234, 120000])(
    "delays only between failed verification and retry with retryDelayMs %s",
    async (retryDelayMs) => {
      const { client, timer } = arrange([
        withEdit,
        galleryWithApp,
        ...Array(10).fill("container"),
        withEdit,
        galleryWithApp,
        captures[1],
      ]);
      const commandsAtRetryDelay: number[] = [];
      const sleep = timer.sleep.bind(timer);
      timer.sleep = async (ms) => {
        if (ms === (retryDelayMs ?? 20000)) {
          commandsAtRetryDelay.push(client.commands.length);
        }
        await sleep(ms);
      };
      const result = await addWatchSmartStackWidget(
        client,
        { ...options, retryDelayMs },
        { timer },
      );
      expect(result).toMatchObject({
        success: true,
        attempts: 2,
        headerAttempts: 2,
        verificationAttempts: 11,
        steps: 33,
      });
      expect(client.commands).toEqual([...widgetAttempt(10), ...widgetAttempt(1)]);
      const delay = retryDelayMs ?? 20000;
      expect(timer.getSleepHistory()).toEqual([
        ...widgetAttemptSleeps(10),
        ...(delay === 0 ? [] : [delay]),
        ...widgetAttemptSleeps(1),
      ]);
      expect(commandsAtRetryDelay).toEqual(delay === 0 ? [] : [21]);
    },
  );
  test.each([undefined, 2, 5])("bounds whole-flow attempts at %s", async (maxAttempts) => {
    const expectedAttempts = maxAttempts ?? 3;
    const { client, timer } = arrange(
      Array.from({ length: expectedAttempts }, () => [
        withEdit,
        galleryWithApp,
        ...Array(10).fill("container"),
      ]).flat(),
    );
    const result = await addWatchSmartStackWidget(client, { ...options, maxAttempts }, { timer });
    expect(result).toMatchObject({
      success: false,
      attempts: expectedAttempts,
      headerAttempts: expectedAttempts,
      verificationAttempts: 10 * expectedAttempts,
      steps: 21 * expectedAttempts,
    });
    expect(result.reason).toContain("Widget cell did not appear");
    expect(client.commands).toEqual(
      Array.from({ length: expectedAttempts }, () => widgetAttempt(10)).flat(),
    );
    expect(timer.getSleepHistory()).toEqual(
      Array.from({ length: expectedAttempts }, (_, attempt) => [
        ...widgetAttemptSleeps(10),
        ...(attempt < expectedAttempts - 1 ? [20000] : []),
      ]).flat(),
    );
  });
  test("returns bounded failure when widget never appears", async () => {
    const { client, timer } = arrange([withEdit]);
    const result = await addWatchSmartStackWidget(
      client,
      { ...options, maxAttempts: 1 },
      { timer },
    );
    expect(result).toMatchObject({
      success: false,
      attempts: 1,
      verificationAttempts: 10,
      headerAttempts: 1,
      steps: 21,
    });
    expect(result.reason).toContain("Widget cell did not appear");
    expect(timer.getSleepHistory()).toEqual(widgetAttemptSleeps(10));
  });
  test("swipes again when Edit is below the fold, then taps Edit", async () => {
    const { client, timer } = arrange([noEdit, "container", withEdit, galleryWithApp, captures[1]]);
    const result = await addWatchSmartStackWidget(client, options, { timer });
    expect(result.success).toBe(true);
    expect(result.headerAttempts).toBe(3);
    expect(client.commands.slice(0, 7)).toEqual([
      { type: "home" },
      { type: "face", op: "swipe", direction: "up" },
      { type: "face", op: "dump" },
      { type: "face", op: "dump" },
      { type: "face", op: "swipe", direction: "up" },
      { type: "face", op: "dump" },
      { type: "face", op: "tap", x: 0.5, y: (195.8 + 20.2 / 2) / 223 },
    ]);
    expect(client.commands).toContainEqual({
      type: "face",
      op: "tap",
      x: 0.5,
      y: (195.8 + 20.2 / 2) / 223,
    });
  });
  test("starts the next home round after all extra swipes fail", async () => {
    const { client, timer } = arrange([
      ...Array(8).fill(noEdit),
      withEdit,
      galleryWithApp,
      captures[1],
    ]);
    const result = await addWatchSmartStackWidget(client, options, { timer });
    expect(result.success).toBe(true);
    expect(result.headerAttempts).toBe(9);
    expect(client.commands.slice(0, 16)).toEqual([
      { type: "home" },
      ...openingRound(2, 3).slice(1),
      { type: "home" },
      { type: "face", op: "swipe", direction: "up" },
      { type: "face", op: "dump" },
    ]);
  });
  test("stops before editing if the Smart Stack never opens", async () => {
    const { client, timer } = arrange([]);
    const result = await addWatchSmartStackWidget(client, options, { timer });
    expect(result).toMatchObject({
      success: false,
      attempts: 1,
      headerAttempts: 24,
      verificationAttempts: 0,
      steps: 39,
    });
    expect(result.reason).toContain("after 3 home/swipe rounds");
    expect(client.commands).toEqual(Array.from({ length: 3 }, () => openingRound(2, 3)).flat());
    expect(timer.getSleepHistory()).toEqual(Array(27).fill(250));
    expect(
      client.commands.every(
        (command) => command.type === "home" || (command.type === "face" && command.op !== "tap"),
      ),
    ).toBe(true);
  });
  test.each([0, 2])("supports %i gallery steps", async (galleryStepsFromBottom) => {
    const { client, timer } = arrange([withEdit, galleryWithApp, captures[1]]);
    expect(
      (await addWatchSmartStackWidget(client, { ...options, galleryStepsFromBottom }, { timer }))
        .success,
    ).toBe(true);
    expect(
      client.commands.filter((command) => command.type === "face" && command.op === "drag"),
    ).toHaveLength(galleryStepsFromBottom);
  });
  test.each([
    { appName: " " },
    { widgetName: "" },
    ...[0, 6, 1.5, NaN].map((maxAttempts) => ({ maxAttempts })),
    ...[-1, 120001, 1.5, NaN, Infinity].map((retryDelayMs) => ({ retryDelayMs })),
    ...[-1, 1.5, 101, NaN, Infinity].map((galleryStepsFromBottom) => ({ galleryStepsFromBottom })),
  ])("rejects invalid arguments %j before dispatch", async (invalid) => {
    const { client, timer } = arrange([]);
    await expect(
      addWatchSmartStackWidget(client, { ...options, ...invalid }, { timer }),
    ).rejects.toBeInstanceOf(ActionableError);
    expect(client.commands).toEqual([]);
    expect(timer.getSleepHistory()).toEqual([]);
  });
  test("returns a typed failure for command rejection", async () => {
    const { client, timer } = arrange([]);
    client.failure = new ActionableError("Runner disconnected; reconnect it.");
    const result = await addWatchSmartStackWidget(client, options, { timer });
    expect(result.success).toBe(false);
    expect(result.reason).toContain("Runner disconnected");
    expect(result.steps).toBe(1);
    expect(result.attempts).toBe(1);
  });
  test("rejects malformed dump payloads as a typed failure", async () => {
    const { client, timer } = arrange([]);
    client.invalidDump = true;
    const result = await addWatchSmartStackWidget(client, options, { timer });
    expect(result.success).toBe(false);
    expect(result.reason).toContain("dump was not text");
    expect(result.attempts).toBe(1);
    expect(client.commands).toHaveLength(3);
  });
  test("an already aborted operation sends no commands", async () => {
    const { client, timer } = arrange([]);
    const controller = new AbortController();
    controller.abort(new ActionableError("Cancelled"));
    const result = await addWatchSmartStackWidget(
      client,
      { ...options, signal: controller.signal },
      { timer },
    );
    expect(result.success).toBe(false);
    expect(result.reason).toContain("Cancelled");
    expect(result.attempts).toBe(0);
    expect(client.commands).toEqual([]);
    expect(timer.getSleepHistory()).toEqual([]);
  });
  test.each([1, 21])("stops on cancellation after request %i without retrying", async (stopAt) => {
    const { client, timer } = arrange([withEdit]);
    const controller = new AbortController();
    client.onRequest = () => {
      if (client.commands.length === stopAt) {
        controller.abort(new ActionableError("Cancelled"));
      }
    };
    const result = await addWatchSmartStackWidget(
      client,
      { ...options, signal: controller.signal },
      { timer },
    );
    expect(result).toMatchObject({ success: false, attempts: 1, steps: stopAt });
    expect(result.reason).toContain("Cancelled");
    expect(client.commands).toHaveLength(stopAt);
    expect(timer.getSleepHistory()).toHaveLength(stopAt === 1 ? 0 : 18);
  });
  test("passes the signal to every request", async () => {
    const { client, timer } = arrange([withEdit, galleryWithApp, captures[1]]);
    const signal = new AbortController().signal;
    await addWatchSmartStackWidget(client, { ...options, signal }, { timer });
    expect(client.signals).toHaveLength(client.commands.length);
    expect(client.signals.every((value) => value === signal)).toBe(true);
  });
  test("stops after cancellation during the retry delay without another command", async () => {
    const { client, timer } = arrange([withEdit]);
    const controller = new AbortController();
    client.onRequest = () => {
      if (client.commands.length === 21) {
        timer.setTimeout(() => controller.abort(new ActionableError("Cancelled")), 10000);
      }
    };
    const result = await addWatchSmartStackWidget(
      client,
      { ...options, signal: controller.signal },
      { timer },
    );
    expect(result).toMatchObject({ success: false, attempts: 1, steps: 21 });
    expect(result.reason).toContain("Cancelled");
    expect(client.commands).toEqual(widgetAttempt(10));
    expect(timer.getSleepHistory()).toEqual([...widgetAttemptSleeps(10), 20000]);
  });
});
