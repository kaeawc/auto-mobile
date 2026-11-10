import { readFileSync } from "node:fs";
import { describe, expect, test } from "bun:test";
import { ActionableError } from "../../../src/models/ActionableError";
import {
  addWatchSmartStackWidget,
  findUnnamedAddedWidget,
  hasSmartStackWidget,
  verifySmartStackWidget,
} from "../../../src/features/watch/WatchSmartStackWidget";
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
// #17793: both cells were added but their identifiers carry empty app and widget names.
const emptyNames = readFileSync(
  new URL("../../fixtures/watch/fixture-face-smartstack-empty-names.txt", import.meta.url),
  "utf8",
);
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

function openingRound(dumps: number): WatchCommand[] {
  return [
    { type: "home" },
    { type: "face", op: "swipe", direction: "up" },
    ...Array.from({ length: dumps }, (): WatchCommand => ({ type: "face", op: "dump" })),
  ];
}
const galleryCommands: WatchCommand[] = [
  { type: "face", op: "tap", x: 0.5, y: 0.92 },
  { type: "face", op: "tap", x: 0.5, y: 0.44 },
  { type: "face", op: "swipe", direction: "up" },
  { type: "face", op: "drag", fromX: 0.5, fromY: 0.5, toX: 0.5, toY: 0.6 },
  { type: "face", op: "tap", x: 0.5, y: 0.65 },
  { type: "face", op: "tap", x: 0.5, y: 0.5 },
  { type: "face", op: "tap", x: 0.16, y: 0.14 },
];
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

describe("Smart Stack widget", () => {
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
      expect(verifySmartStackWidget(dump, baseline, options.appName, options.widgetName)).toBe(
        true,
      );
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
    expect(verifySmartStackWidget(dump, baseline, "OtherApp", "OtherWidget")).toBe(false);
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
  test("succeeds on the first attempt when the added cell's names are empty", async () => {
    const { client, timer } = arrange([noWidgetCells, "container", oneEmptyCell]);
    const result = await addWatchSmartStackWidget(client, options, { timer });
    expect(result).toMatchObject({
      success: true,
      attempts: 1,
      headerAttempts: 1,
      verificationAttempts: 2,
      steps: 12,
    });
    expect(client.commands).toEqual(widgetAttempt(2));
  });
  test("compares a retry against that attempt's own header dump", async () => {
    const { client, timer } = arrange([
      noWidgetCells,
      ...Array(10).fill("container"),
      oneEmptyCell,
      emptyNames,
    ]);
    const result = await addWatchSmartStackWidget(client, options, { timer });
    expect(result).toMatchObject({ success: true, attempts: 2, verificationAttempts: 11 });
  });
  test("fails when the empty-name cell was already on the stack before the edit", async () => {
    const { client, timer } = arrange([emptyNames, ...Array(10).fill(emptyNames)]);
    const result = await addWatchSmartStackWidget(
      client,
      { ...options, maxAttempts: 1 },
      { timer },
    );
    expect(result).toMatchObject({ success: false, attempts: 1, verificationAttempts: 10 });
    expect(result.reason).toContain("Widget cell did not appear");
  });
  test("uses clockface commands in order and polls past container-only dumps", async () => {
    const { client, timer } = arrange(["container", captures[0], "container", captures[1]]);
    const result = await addWatchSmartStackWidget(client, options, { timer });
    expect(result).toMatchObject({
      success: true,
      attempts: 1,
      steps: 13,
      headerAttempts: 2,
      verificationAttempts: 2,
    });
    expect(client.commands).toEqual([
      { type: "home" },
      { type: "face", op: "swipe", direction: "up" },
      { type: "face", op: "dump" },
      { type: "face", op: "dump" },
      { type: "face", op: "tap", x: 0.5, y: 0.92 },
      { type: "face", op: "tap", x: 0.5, y: 0.44 },
      { type: "face", op: "swipe", direction: "up" },
      { type: "face", op: "drag", fromX: 0.5, fromY: 0.5, toX: 0.5, toY: 0.6 },
      { type: "face", op: "tap", x: 0.5, y: 0.65 },
      { type: "face", op: "tap", x: 0.5, y: 0.5 },
      { type: "face", op: "tap", x: 0.16, y: 0.14 },
      { type: "face", op: "dump" },
      { type: "face", op: "dump" },
    ]);
    expect(timer.getSleepHistory()).toEqual(Array(11).fill(250));
  });
  test("recovers a swallowed first home on the second opening round", async () => {
    const { client, timer } = arrange([...Array(4).fill("container"), captures[0], captures[1]]);
    const result = await addWatchSmartStackWidget(client, options, { timer });
    expect(result).toMatchObject({
      success: true,
      attempts: 1,
      headerAttempts: 5,
      verificationAttempts: 1,
      steps: 17,
    });
    expect(client.commands).toEqual([...openingRound(4), ...widgetAttempt(1)]);
    expect(timer.getSleepHistory()).toEqual(Array(14).fill(250));
  });
  test.each([undefined, 0, 1234, 120000])(
    "delays only between failed verification and retry with retryDelayMs %s",
    async (retryDelayMs) => {
      const { client, timer } = arrange([
        captures[0],
        ...Array(10).fill("container"),
        captures[0],
        captures[1],
      ]);
      const commandsAtRetryDelay: number[] = [];
      const sleep = timer.sleep.bind(timer);
      timer.sleep = async (ms) => {
        if (ms !== 250) {
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
        steps: 31,
      });
      expect(client.commands).toEqual([...widgetAttempt(10), ...widgetAttempt(1)]);
      const delay = retryDelayMs ?? 20000;
      expect(timer.getSleepHistory()).toEqual([
        ...Array(18).fill(250),
        ...(delay === 0 ? [] : [delay]),
        ...Array(9).fill(250),
      ]);
      expect(commandsAtRetryDelay).toEqual(delay === 0 ? [] : [20]);
    },
  );
  test.each([undefined, 2, 5])("bounds whole-flow attempts at %s", async (maxAttempts) => {
    const expectedAttempts = maxAttempts ?? 3;
    const { client, timer } = arrange(
      Array.from({ length: expectedAttempts }, () => [
        captures[0],
        ...Array(10).fill("container"),
      ]).flat(),
    );
    const result = await addWatchSmartStackWidget(client, { ...options, maxAttempts }, { timer });
    expect(result).toMatchObject({
      success: false,
      attempts: expectedAttempts,
      headerAttempts: expectedAttempts,
      verificationAttempts: 10 * expectedAttempts,
      steps: 20 * expectedAttempts,
    });
    expect(result.reason).toContain("Widget cell did not appear");
    expect(client.commands).toEqual(
      Array.from({ length: expectedAttempts }, () => widgetAttempt(10)).flat(),
    );
    expect(timer.getSleepHistory()).toEqual(
      Array.from({ length: expectedAttempts }, (_, attempt) => [
        ...Array(18).fill(250),
        ...(attempt < expectedAttempts - 1 ? [20000] : []),
      ]).flat(),
    );
  });
  test("returns bounded failure when widget never appears", async () => {
    const { client, timer } = arrange([captures[0]]);
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
      steps: 20,
    });
    expect(result.reason).toContain("Widget cell did not appear");
    expect(timer.getSleepHistory()).toEqual(Array(18).fill(250));
  });
  test("stops before editing if the Smart Stack never opens", async () => {
    const { client, timer } = arrange([]);
    const result = await addWatchSmartStackWidget(client, options, { timer });
    expect(result).toMatchObject({
      success: false,
      attempts: 1,
      headerAttempts: 12,
      verificationAttempts: 0,
      steps: 18,
    });
    expect(result.reason).toContain("after 3 home/swipe rounds");
    expect(client.commands).toEqual(Array.from({ length: 3 }, () => openingRound(4)).flat());
    expect(timer.getSleepHistory()).toEqual(Array(15).fill(250));
    expect(
      client.commands.every(
        (command) => command.type === "home" || (command.type === "face" && command.op !== "tap"),
      ),
    ).toBe(true);
  });
  test.each([0, 2])("supports %i gallery steps", async (galleryStepsFromBottom) => {
    const { client, timer } = arrange([captures[0], captures[1]]);
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
  test.each([1, 20])("stops on cancellation after request %i without retrying", async (stopAt) => {
    const { client, timer } = arrange([captures[0]]);
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
    const { client, timer } = arrange([captures[0], captures[1]]);
    const signal = new AbortController().signal;
    await addWatchSmartStackWidget(client, { ...options, signal }, { timer });
    expect(client.signals).toHaveLength(client.commands.length);
    expect(client.signals.every((value) => value === signal)).toBe(true);
  });
  test("stops after cancellation during the retry delay without another command", async () => {
    const { client, timer } = arrange([captures[0]]);
    const controller = new AbortController();
    client.onRequest = () => {
      if (client.commands.length === 20) {
        timer.setTimeout(() => controller.abort(new ActionableError("Cancelled")), 10000);
      }
    };
    const result = await addWatchSmartStackWidget(
      client,
      { ...options, signal: controller.signal },
      { timer },
    );
    expect(result).toMatchObject({ success: false, attempts: 1, steps: 20 });
    expect(result.reason).toContain("Cancelled");
    expect(client.commands).toEqual(widgetAttempt(10));
    expect(timer.getSleepHistory()).toEqual([...Array(18).fill(250), 20000]);
  });
});
