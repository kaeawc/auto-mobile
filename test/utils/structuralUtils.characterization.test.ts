import { describe, expect, spyOn, test } from "bun:test";
import fs from "fs/promises";
import path from "path";
import { PNG } from "pngjs";
import { YamlPlanSerializer } from "../../src/utils/plan/PlanSerializer";
import { summarizeObserveResultForFailure } from "../../src/utils/plan/summarizeFailureObservation";
import { DefaultRetryExecutor } from "../../src/utils/retry/RetryExecutor";
import { ScreenshotComparator } from "../../src/utils/screenshot/ScreenshotComparator";
import { processTimingData, type TimingData } from "../../src/utils/PerformanceTracker";
import { getMcpServerVersion, releaseVersion } from "../../src/utils/mcpVersion";
import { logger } from "../../src/utils/logger";
import { FakeTimer } from "../fakes/FakeTimer";
import { FakeImageBackend } from "../fakes/FakeImageBackend";

const createdAt = "2026-01-01T00:00:00.000Z";
const version = releaseVersion(getMcpServerVersion());
const logPaths = {
  a: path.join("/logs", "a.json"),
  b: path.join("/logs", "b.json"),
  c: path.join("/logs", "c.json"),
};

function logEntry(tool: string, timestamp: number, optional?: boolean): string {
  return JSON.stringify({
    timestamp: new Date(timestamp).toISOString(),
    tool,
    params: { text: tool },
    optional,
    result: { success: true },
  });
}

describe("Plan export characterization", () => {
  test("log fixture paths match Windows joins without changing the native path module", () => {
    const windowsPaths = ["a.json", "b.json", "c.json"].map((file) =>
      path.win32.join("/logs", file),
    );
    expect(Object.values(logPaths).map((file) => path.win32.normalize(file))).toEqual(windowsPaths);
    expect(windowsPaths[0]).toBe("\\logs\\a.json");
    expect(windowsPaths[0]).not.toBe(path.posix.join("/logs", "a.json"));
  });

  test("exports exact YAML after ordered parsing, failures, omissions and last-observe selection", async () => {
    const logs = new Map([
      [
        logPaths.a,
        `${logEntry("observe", 1)}\ninvalid\nnull\n${JSON.stringify({ result: { success: false } })}\n${logEntry("tapOn", 3, true)}\n`,
      ],
      [
        logPaths.c,
        `${logEntry("observe", 5, false)}\n${logEntry("inputText", 2, false)}\n${logEntry("listDevices", 4)}\n`,
      ],
    ]);
    const listing = spyOn(fs, "readdir").mockResolvedValue([
      "c.json",
      "ignored.txt",
      "b.json",
      "a.json",
    ]);
    const reading = spyOn(fs, "readFile").mockImplementation(async (file) => {
      const content = logs.get(String(file));
      if (content === undefined) {
        throw new Error("unreadable");
      }
      return content;
    });
    const writing = spyOn(fs, "writeFile").mockResolvedValue(undefined);
    const date = spyOn(Date.prototype, "toISOString").mockReturnValue(createdAt);
    const warning = spyOn(logger, "warn").mockImplementation(() => {});
    try {
      const content = `name: Export\ndescription: Exported plan with 3 steps\nsteps:\n  - tool: inputText\n    params:\n      text: inputText\n  - tool: tapOn\n    params:\n      text: tapOn\n    optional: true\n  - tool: observe\n    params:\n      text: observe\nmcpVersion: ${version}\nmetadata:\n  createdAt: '${createdAt}'\n  version: 1.0.0\n`;
      expect(
        await new YamlPlanSerializer().exportPlanFromLogs("/logs", "Export", "/out.yaml"),
      ).toEqual({
        success: true,
        planPath: "/out.yaml",
        planContent: content,
        stepCount: 3,
      });
      expect(reading.mock.calls.map(([file]) => file)).toEqual([
        logPaths.a,
        logPaths.b,
        logPaths.c,
      ]);
      expect(writing.mock.calls).toEqual([["/out.yaml", content, "utf-8"]]);
      expect(warning.mock.calls.map(([message]) => String(message).split(":")[0])).toEqual([
        "Failed to parse line in a.json",
        "Failed to parse line in a.json",
        "Failed to read log file b.json",
      ]);
    } finally {
      listing.mockRestore();
      reading.mockRestore();
      writing.mockRestore();
      date.mockRestore();
      warning.mockRestore();
    }
  });

  test.each([
    {
      files: ["ignored.txt"],
      content: "",
      expected: { success: false, error: "No log files found" },
    },
    {
      files: ["a.json"],
      content: ' \n{}\n{"result":{"success":false}}\n',
      expected: { success: false, error: "No successful tool calls found in logs" },
    },
    { files: ["a.json"], content: logEntry("killDevice", 0), expected: { success: true } },
  ])("handles empty and omitted calls: $files $content", async ({ files, content, expected }) => {
    const listing = spyOn(fs, "readdir").mockResolvedValue(files);
    const reading = spyOn(fs, "readFile").mockResolvedValue(content);
    const writing = spyOn(fs, "writeFile").mockResolvedValue(undefined);
    const date = spyOn(Date.prototype, "toISOString").mockReturnValue(createdAt);
    try {
      const result = await new YamlPlanSerializer().exportPlanFromLogs(
        "/logs",
        "Empty",
        "/out.yaml",
      );
      if (!expected.success) {
        expect(result).toEqual(expected);
        expect(writing).not.toHaveBeenCalled();
      } else {
        expect(result).toEqual({
          success: true,
          planPath: "/out.yaml",
          stepCount: 0,
          planContent: `name: Empty\ndescription: Exported plan with 0 steps\nsteps: []\nmcpVersion: ${version}\nmetadata:\n  createdAt: '${createdAt}'\n  version: 1.0.0\n`,
        });
      }
    } finally {
      listing.mockRestore();
      reading.mockRestore();
      writing.mockRestore();
      date.mockRestore();
    }
  });

  test.each(["readdir", "writeFile"] as const)("preserves %s errors", async (method) => {
    const listing = spyOn(fs, "readdir").mockResolvedValue(["a.json"]);
    const reading = spyOn(fs, "readFile").mockResolvedValue(logEntry("tapOn", 0));
    const writing = spyOn(fs, "writeFile").mockResolvedValue(undefined);
    const errorLog = spyOn(logger, "error").mockImplementation(() => {});
    (method === "readdir" ? listing : writing).mockRejectedValue(new Error("denied"));
    try {
      expect(
        await new YamlPlanSerializer().exportPlanFromLogs("/logs", "Failure", "/out.yaml"),
      ).toEqual({ success: false, error: "Error: denied" });
    } finally {
      listing.mockRestore();
      reading.mockRestore();
      writing.mockRestore();
      errorLog.mockRestore();
    }
  });
});

function expectSummary(raw: Record<string, unknown>, texts: string[], ids: string[]): void {
  const now = spyOn(Date, "now").mockReturnValue(123);
  try {
    const expected = {
      capturedAtMs: 123,
      activeWindow: raw.activeWindow,
      awaitTimeout: typeof raw.awaitTimeout === "boolean" ? raw.awaitTimeout : undefined,
      awaitedElement: raw.awaitedElement,
      accessibilityState: raw.accessibilityState,
      viewHierarchy: raw.viewHierarchy,
      rawViewHierarchy: raw.rawViewHierarchy,
      visibleTextsSample: texts,
      resourceIdsSample: ids,
      observeError: typeof raw.error === "string" ? raw.error : undefined,
    };
    const actual = summarizeObserveResultForFailure(raw);
    expect(actual).toEqual(expected);
    expect(JSON.stringify(actual)).toBe(JSON.stringify(expected));
  } finally {
    now.mockRestore();
  }
}

describe("Failure summary characterization", () => {
  test("preserves complete payload, bucket order, deduplication, clipping and malformed entries", () => {
    const longText = "t".repeat(301);
    const longId = "i".repeat(201);
    expectSummary(
      {
        activeWindow: { appId: "app" },
        awaitTimeout: false,
        awaitedElement: { text: "target" },
        accessibilityState: "enabled",
        viewHierarchy: { children: [] },
        rawViewHierarchy: "xml",
        error: "failure",
        elements: {
          clickable: [
            null,
            false,
            1,
            "bad",
            {},
            { text: " \t", resourceId: "" },
            { text: " first ", resourceId: " id " },
            { text: longText, resourceId: longId },
          ],
          text: [
            { text: "first", resourceId: " id " },
            { text: 3, resourceId: false },
            { text: "second", resourceId: "second-id" },
          ],
          scrollable: [{ text: "third", resourceId: "third-id" }],
        },
      },
      ["first", `${"t".repeat(300)}…`, "second", "third"],
      [" id ", `${"i".repeat(200)}…`, "second-id", "third-id"],
    );
  });

  test.each([undefined, null, false, 1, "bad", { clickable: {}, text: null, scrollable: "bad" }])(
    "handles invalid buckets: %j",
    (elements) => {
      expectSummary({ elements, awaitTimeout: "true", error: 42 }, [], []);
    },
  );

  test("stops at both sample limits before reading later buckets", () => {
    const samples = Array.from({ length: 80 }, (_, i) => ({
      text: `text-${i}`,
      resourceId: `id-${i}`,
    }));
    const elements = {
      clickable: samples,
      get text() {
        throw new Error("must not read");
      },
    };
    expectSummary(
      { elements },
      samples.map((item) => item.text),
      samples.map((item) => item.resourceId),
    );
  });

  test("limits each bucket to 80 items but continues when only one sample set is full", () => {
    const first = Array.from({ length: 81 }, (_, i) => ({ text: `text-${i}` }));
    const ids = Array.from({ length: 80 }, (_, i) => ({
      text: `later-${i}`,
      resourceId: `id-${i}`,
    }));
    expectSummary(
      {
        elements: {
          clickable: first,
          text: ids,
          scrollable: [{ text: "unread", resourceId: "unread" }],
        },
      },
      first.slice(0, 80).map((item) => item.text),
      ids.map((item) => item.resourceId),
    );
  });

  test("continues collecting text when only the resource sample is full", () => {
    const ids = Array.from({ length: 80 }, (_, i) => ({ resourceId: `id-${i}` }));
    expectSummary(
      {
        elements: {
          clickable: ids,
          text: [{ text: "later", resourceId: "extra" }],
          scrollable: [{ text: "last" }],
        },
      },
      ["later", "last"],
      ids.map((item) => item.resourceId),
    );
  });
});

describe("Retry characterization", () => {
  test.each([
    {
      name: "first success",
      max: 3,
      succeedAt: 1,
      delays: 10,
      sleeps: [],
      attempts: 1,
      success: true,
    },
    {
      name: "fixed delay",
      max: 3,
      succeedAt: 3,
      delays: 10,
      sleeps: [10, 10],
      attempts: 3,
      success: true,
    },
    {
      name: "array repeats last delay",
      max: 4,
      succeedAt: 9,
      delays: [5, 10],
      sleeps: [5, 10, 10],
      attempts: 4,
      success: false,
    },
    {
      name: "zero delay",
      max: 2,
      succeedAt: 9,
      delays: 0,
      sleeps: [],
      attempts: 2,
      success: false,
    },
    {
      name: "negative delay",
      max: 2,
      succeedAt: 9,
      delays: -5,
      sleeps: [],
      attempts: 2,
      success: false,
    },
    {
      name: "zero attempts",
      max: 0,
      succeedAt: 1,
      delays: 10,
      sleeps: [],
      attempts: 0,
      success: false,
    },
    {
      name: "predicate stop",
      max: 4,
      succeedAt: 9,
      delays: 10,
      sleeps: [10],
      attempts: 2,
      success: false,
      stopAt: 2,
    },
  ])(
    "pins $name result and side effects",
    async ({ max, succeedAt, delays, sleeps, attempts, success, stopAt }) => {
      const timer = new FakeTimer();
      timer.enableAutoAdvance();
      const error = new Error("failure");
      const calls: number[] = [];
      const events: string[] = [];
      const result = await new DefaultRetryExecutor(timer).execute(
        async (attempt) => {
          calls.push(attempt);
          events.push(`op:${attempt}`);
          if (attempt < succeedAt) {
            throw error;
          }
          return "ok";
        },
        {
          maxAttempts: max,
          delays,
          shouldRetry: (_error, attempt) => {
            events.push(`predicate:${attempt}`);
            return attempt !== stopAt;
          },
          onRetry: (_error, attempt, delay) => {
            events.push(`retry:${attempt}:${delay}`);
          },
        },
      );
      expect(result).toEqual(
        success
          ? {
              success: true,
              value: "ok",
              attempts,
              totalTimeMs: sleeps.reduce((sum, delay) => sum + delay, 0),
            }
          : {
              success: false,
              error: max === 0 ? undefined : error,
              attempts,
              totalTimeMs: sleeps.reduce((sum, delay) => sum + delay, 0),
            },
      );
      expect(timer.getSleepHistory()).toEqual(sleeps);
      expect(calls).toEqual(Array.from({ length: attempts }, (_, i) => i + 1));
      const expectedEvents: string[] = [];
      for (let attempt = 1; attempt <= attempts; attempt++) {
        expectedEvents.push(`op:${attempt}`);
        if (attempt < succeedAt && attempt < max) {
          expectedEvents.push(`predicate:${attempt}`);
          if (attempt !== stopAt) {
            const delay = Array.isArray(delays)
              ? delays[Math.min(attempt - 1, delays.length - 1)]
              : delays;
            expectedEvents.push(`retry:${attempt}:${Math.max(0, delay)}`);
          }
        }
      }
      expect(events).toEqual(expectedEvents);
    },
  );

  test.each(["before", "rejection", "sleep", "callback-zero", "callback-positive"] as const)(
    "pins abort during %s",
    async (phase) => {
      const timer = new FakeTimer();
      const controller = new AbortController();
      const reason = new Error("cancelled");
      const events: string[] = [];
      if (phase === "before") {
        controller.abort(reason);
      }
      const pending = new DefaultRetryExecutor(timer).execute(
        async (attempt) => {
          events.push(`op:${attempt}`);
          if (phase === "rejection") {
            controller.abort(reason);
          }
          throw new Error("stale failure");
        },
        {
          signal: controller.signal,
          maxAttempts: 3,
          delays: phase === "callback-zero" ? 0 : 10,
          shouldRetry: () => {
            events.push("predicate");
            return true;
          },
          onRetry: () => {
            events.push("retry");
            if (phase.startsWith("callback")) {
              controller.abort(reason);
            }
          },
        },
      );
      if (phase === "sleep") {
        await Promise.resolve();
        expect(timer.getPendingTimeouts()).toEqual([10]);
        controller.abort(reason);
      }
      expect(await pending).toEqual({
        success: false,
        error: reason,
        attempts: phase === "callback-zero" ? 2 : 1,
        totalTimeMs: 0,
      });
      expect(events).toEqual(
        phase === "before" ? [] : phase === "rejection" ? ["op:1"] : ["op:1", "predicate", "retry"],
      );
      expect(timer.getSleepHistory()).toEqual([]);
      expect(timer.getPendingTimeoutCount()).toBe(0);
    },
  );

  test("runs the next zero-delay attempt before an abort queued after rejection", async () => {
    const controller = new AbortController();
    let calls = 0;
    const result = await new DefaultRetryExecutor(new FakeTimer()).execute(
      async () => {
        calls++;
        if (calls === 1) {
          queueMicrotask(() => queueMicrotask(() => controller.abort(new Error("cancelled"))));
          throw new Error("retry");
        }
        return "ok";
      },
      { maxAttempts: 3, delays: 0, signal: controller.signal },
    );
    expect(calls).toBe(2);
    expect(result).toEqual({ success: true, value: "ok", attempts: 2, totalTimeMs: 0 });
  });

  test("normalizes a non-Error rejection", async () => {
    const result = await new DefaultRetryExecutor(new FakeTimer()).execute(
      async () => {
        throw "failure";
      },
      { maxAttempts: 1 },
    );
    expect(result).toEqual({
      success: false,
      error: new Error("failure"),
      attempts: 1,
      totalTimeMs: 0,
    });
  });
});

function solidPng(width: number, height: number, value: number): Buffer {
  const image = new PNG({ width, height });
  for (let i = 0; i < image.data.length; i += 4) {
    image.data[i] = value;
    image.data[i + 1] = value;
    image.data[i + 2] = value;
    image.data[i + 3] = 255;
  }
  return PNG.sync.write(image);
}

describe("Screenshot comparison characterization", () => {
  test.each([
    { fast: false, threshold: 0.1, value: 255, difference: 4 },
    { fast: false, threshold: 0.1, value: 35, difference: 4 },
    { fast: true, threshold: 0.1, value: 35, difference: 0 },
    { fast: true, threshold: 0.5, value: 100, difference: 4 },
    { fast: true, threshold: 0.1, value: 0, difference: 0 },
  ])(
    "pins fast=$fast threshold=$threshold value=$value",
    async ({ fast, threshold, value, difference }) => {
      const backend = new FakeImageBackend();
      expect(
        await ScreenshotComparator.compareImages(
          solidPng(2, 2, 0),
          solidPng(2, 2, value),
          threshold,
          fast,
          new FakeTimer(),
          backend,
        ),
      ).toEqual({
        similarity: difference === 0 ? 100 : 0,
        pixelDifference: difference,
        totalPixels: 4,
      });
      expect(backend.executeCalls).toEqual([]);
    },
  );

  test.each([false, true])("pins conversion then resizing order in fast mode %s", async (fast) => {
    const backend = new FakeImageBackend();
    const converted = solidPng(2, 2, 0);
    const resized = solidPng(1, 2, 0);
    backend.setExecuteResult(converted);
    const original = backend.execute.bind(backend);
    const execute = spyOn(backend, "execute").mockImplementation(async (source, pipeline) => {
      if (pipeline.operations.length > 0) {
        backend.setExecuteResult(resized);
      }
      return original(source, pipeline);
    });
    try {
      const input = Buffer.from("not-png");
      expect(
        await ScreenshotComparator.compareImages(
          input,
          resized,
          0.1,
          fast,
          new FakeTimer(),
          backend,
        ),
      ).toEqual({ similarity: 100, pixelDifference: 0, totalPixels: 2 });
      expect(backend.executeCalls).toEqual([
        { source: input, pipeline: { operations: [], encoding: { mime: "image/png" } } },
        {
          source: converted,
          pipeline: {
            operations: [
              { type: "resize", width: 1, height: 2, maintainAspectRatio: false, mode: "nearest" },
            ],
            encoding: { mime: "image/png" },
          },
        },
      ]);
    } finally {
      execute.mockRestore();
    }
  });

  test.each([false, true])(
    "pins dimension selection and both resizes in fast mode %s",
    async (fast) => {
      const backend = new FakeImageBackend();
      const tiny = solidPng(1, 1, 0);
      backend.setExecuteResult(tiny);
      const first = Buffer.from(tiny);
      const second = Buffer.from(tiny);
      first.writeUInt32BE(800, 16);
      first.writeUInt32BE(700, 20);
      second.writeUInt32BE(900, 16);
      second.writeUInt32BE(650, 20);
      expect(
        await ScreenshotComparator.compareImages(
          first,
          second,
          0.1,
          fast,
          new FakeTimer(),
          backend,
        ),
      ).toEqual({ similarity: 100, pixelDifference: 0, totalPixels: 1 });
      expect(backend.executeCalls.map(({ pipeline }) => pipeline)).toEqual(
        [0, 1].map(() => ({
          operations: [
            {
              type: "resize",
              width: fast ? 400 : 800,
              height: fast ? 600 : 650,
              maintainAspectRatio: false,
              mode: "nearest",
            },
          ],
          encoding: { mime: "image/png" },
        })),
      );
      expect(backend.executeCalls.map(({ source }) => source)).toEqual([first, second]);
    },
  );

  test("returns the exact failure shape when conversion fails", async () => {
    const backend = new FakeImageBackend();
    backend.setShouldThrowOnExecute(true);
    expect(
      await ScreenshotComparator.compareImages(
        Buffer.from("bad"),
        Buffer.from("other"),
        0.1,
        false,
        new FakeTimer(),
        backend,
      ),
    ).toEqual({ similarity: 0, pixelDifference: -1, totalPixels: 0 });
    expect(backend.executeCalls).toHaveLength(1);
  });
});

describe("Timing filtering characterization", () => {
  test.each([false, true])(
    "recursively filters array and object children with object root %s",
    (objectRoot) => {
      const entries = {
        leaf: { name: "leaf", durationMs: 1 },
        zero: { name: "zero", durationMs: 0, children: [{ name: "hidden", durationMs: 1 }] },
        negative: { name: "negative", durationMs: -1 },
        emptyArray: { name: "emptyArray", durationMs: 2, children: [] },
        emptyObject: { name: "emptyObject", durationMs: 2, children: {} },
        emptiedObject: {
          name: "emptiedObject",
          durationMs: 3,
          children: { zero: { name: "zero", durationMs: 0 } },
        },
        retained: {
          name: "retained",
          durationMs: 5,
          children: {
            removed: {
              name: "removed",
              durationMs: 2,
              children: [{ name: "zero", durationMs: 0 }],
            },
            nested: {
              name: "nested",
              durationMs: 4,
              children: [
                { name: "leaf", durationMs: 3 },
                { name: "zero", durationMs: 0 },
              ],
            },
          },
        },
      };
      const input: TimingData = objectRoot ? entries : Object.values(entries);
      const original = structuredClone(input);
      const expected = {
        leaf: { name: "leaf", durationMs: 1, children: undefined },
        retained: {
          name: "retained",
          durationMs: 5,
          children: {
            nested: {
              name: "nested",
              durationMs: 4,
              children: [{ name: "leaf", durationMs: 3, children: undefined }],
            },
          },
        },
      };
      expect(processTimingData(input)).toEqual({
        data: objectRoot ? expected : Object.values(expected),
      });
      expect(input).toEqual(original);
    },
  );
});
