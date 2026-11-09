import { readFileSync } from "node:fs";
import { describe, expect, test } from "bun:test";
import { ActionableError } from "../../../src/models/ActionableError";
import {
  addWatchSmartStackWidget,
  hasSmartStackWidget,
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

class FakeClient implements Pick<WatchRunnerClient, "request"> {
  readonly commands: WatchCommand[] = [];
  readonly signals: (AbortSignal | undefined)[] = [];
  failure?: Error;
  invalidDump = false;
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
  test("uses clockface commands in order and polls past container-only dumps", async () => {
    const { client, timer } = arrange(["container", captures[0], "container", captures[1]]);
    const result = await addWatchSmartStackWidget(client, options, { timer });
    expect(result).toMatchObject({
      success: true,
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
  test("returns bounded failure when widget never appears", async () => {
    const { client, timer } = arrange([captures[0]]);
    const result = await addWatchSmartStackWidget(client, options, { timer });
    expect(result).toMatchObject({
      success: false,
      verificationAttempts: 10,
      headerAttempts: 1,
      steps: 20,
    });
    expect(result.reason).toContain("Widget cell did not appear");
    expect(timer.getSleepHistory()).toHaveLength(18);
  });
  test("stops before editing if the Smart Stack never opens", async () => {
    const { client, timer } = arrange([]);
    const result = await addWatchSmartStackWidget(client, options, { timer });
    expect(result).toMatchObject({
      success: false,
      headerAttempts: 10,
      verificationAttempts: 0,
      steps: 12,
    });
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
  });
  test("rejects malformed dump payloads as a typed failure", async () => {
    const { client, timer } = arrange([]);
    client.invalidDump = true;
    const result = await addWatchSmartStackWidget(client, options, { timer });
    expect(result.success).toBe(false);
    expect(result.reason).toContain("dump was not text");
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
    expect(client.commands).toEqual([]);
    expect(timer.getSleepHistory()).toEqual([]);
  });
  test("passes the signal to every request", async () => {
    const { client, timer } = arrange([captures[0], captures[1]]);
    const signal = new AbortController().signal;
    await addWatchSmartStackWidget(client, { ...options, signal }, { timer });
    expect(client.signals.every((value) => value === signal)).toBe(true);
  });
});
