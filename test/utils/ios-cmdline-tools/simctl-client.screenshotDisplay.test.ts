import { CORESIMULATOR_DEVICE_SET_PATH_ENV } from "../../../src/utils/workingDirectory";
import { expect, spyOn, test } from "bun:test";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import type { ChildProcess } from "node:child_process";
import {
  SimCtlClient,
  SimctlScreenshotError,
  type SimCtlFileSystem,
} from "../../../src/utils/ios-cmdline-tools/SimCtlClient";
import { logger } from "../../../src/utils/logger";
import { captureIosPanelScreenshot } from "../../../src/features/observe/ios/CtrlProxyScreenshot";
import type { BootedDevice } from "../../../src/models";
import { loadDuoEnumerate } from "../../fixtures/loadDuoEnumerate";
import { isAbsolute, join, resolve, sep } from "node:path";
import { CountingIdGenerator } from "../../../src/utils/IdGenerator";
import { FakeTimer } from "../../fakes/FakeTimer";
import {
  parseSimulatorDisplays,
  simulatorDeviceDisplays,
} from "../../../src/utils/ios-cmdline-tools/SimulatorDisplays";

const udid = "34C35F33-224C-4E74-B8C0-668FF03E49F5";
const device: BootedDevice = {
  deviceId: udid,
  name: "iPhone Duo",
  platform: "ios",
  displays: simulatorDeviceDisplays(
    parseSimulatorDisplays(loadDuoEnumerate()),
    "com.apple.CoreSimulator.SimDeviceType.iPhone-Duo",
  ),
};

function png(width: number, height: number): Buffer {
  const buffer = Buffer.alloc(24);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(buffer);
  buffer.writeUInt32BE(13, 8);
  buffer.write("IHDR", 12, "ascii");
  buffer.writeUInt32BE(width, 16);
  buffer.writeUInt32BE(height, 20);
  return buffer;
}

function fakeCaptureDir(n: number): string {
  return resolve("fake", `capture-${n}`);
}

async function flushMicrotasks(): Promise<void> {
  for (let turn = 0; turn < 40; turn++) {
    await Promise.resolve();
  }
}

function captureHarness(
  options: {
    mkdtemp?: () => Promise<string>;
    cleanup?: () => Promise<void>;
    frame?: Buffer;
    readError?: Error;
    read?: () => Promise<Buffer>;
    exitCode?: number;
    stderr?: string;
    manual?: boolean;
    cleanupError?: Error;
    abortOnError?: boolean;
    spawnError?: Error;
  } = {},
) {
  const timer = new FakeTimer();
  const calls: string[][] = [];
  const files = new Map<string, Buffer>();
  const removed: string[] = [];
  const events: string[] = [];
  const children: ChildProcess[] = [];
  let count = 0;
  let notifyStarted: () => void = () => {};
  const started = new Promise<void>((resolve) => {
    notifyStarted = resolve;
  });
  const fileSystem: SimCtlFileSystem = {
    mkdtemp: async (prefix) => {
      expect(isAbsolute(prefix)).toBe(true);
      return options.mkdtemp ? options.mkdtemp() : fakeCaptureDir(++count);
    },
    writeFile: async () => {},
    readFile: async () => "",
    readFileBuffer: async (path) => {
      events.push("read");
      if (options.read) {
        return options.read();
      }
      if (options.readError) {
        throw options.readError;
      }
      const bytes = files.get(path);
      if (!bytes) {
        throw Object.assign(new Error("file missing"), { code: "ENOENT" });
      }
      return bytes;
    },
    rm: async (path, rmOptions) => {
      expect(rmOptions).toEqual({ recursive: true, force: true });
      events.push("cleanup");
      removed.push(path);
      if (options.cleanupError) {
        throw options.cleanupError;
      }
      if (options.cleanup) {
        await options.cleanup();
      }
      for (const key of files.keys()) {
        if (key.startsWith(path + sep)) {
          files.delete(key);
        }
      }
    },
  };
  const simctl = new SimCtlClient(
    device,
    null,
    timer,
    "darwin",
    (_file, args, spawnOptions) => {
      calls.push(args);
      if (options.spawnError) {
        throw options.spawnError;
      }
      const child = new EventEmitter() as ChildProcess;
      const stdout = new PassThrough();
      const stderr = new PassThrough();
      Object.assign(child, { stdout, stderr });
      children.push(child);
      spawnOptions?.signal?.addEventListener(
        "abort",
        () => {
          if (options.abortOnError === false) {
            return;
          }
          events.push("error");
          child.emit(
            "error",
            Object.assign(new Error("The operation was aborted"), { name: "AbortError" }),
          );
        },
        { once: true },
      );
      if (!options.manual) {
        queueMicrotask(() => {
          if (options.frame !== undefined) {
            files.set(args.at(-1)!, options.frame);
          }
          // stdout is diagnostic noise, never the screenshot bytes.
          stdout.end("not the image");
          stderr.end(options.stderr ?? "Wrote screenshot to file");
          events.push("close");
          child.emit("close", options.exitCode ?? 0);
        });
      }
      notifyStarted();
      return child;
    },
    fileSystem,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    new CountingIdGenerator("capture"),
  );
  return { simctl, timer, calls, files, removed, events, started, children };
}

for (const cancellation of ["caller", "timeout"] as const) {
  test(`pending mkdtemp honors ${cancellation} cancellation and cleans its late directory`, async () => {
    let release: (dir: string) => void = () => {};
    const directory = new Promise<string>((resolve) => {
      release = resolve;
    });
    const h = captureHarness({ mkdtemp: () => directory });
    const caller = new AbortController();
    const cause = new Error("setup cancelled");
    let outcome: unknown;
    const pending = h.simctl.screenshot(udid, "primary-1", caller.signal).then(
      (value) => {
        outcome = value;
      },
      (error: unknown) => {
        outcome = error;
      },
    );
    h.timer.advanceTime(cancellation === "timeout" ? 10_000 : 25);
    if (cancellation === "caller") {
      caller.abort(cause);
    }
    await flushMicrotasks();
    expect(outcome).toBeInstanceOf(SimctlScreenshotError);
    expect(outcome).toMatchObject({
      reason: cancellation === "caller" ? "aborted-by-caller" : "aborted-by-timeout",
      message:
        cancellation === "caller"
          ? "simctl screenshot cancelled by the caller after 25ms: setup cancelled"
          : "simctl screenshot timed out after 10000ms",
    });
    expect((outcome as Error).cause).toBeInstanceOf(Error);
    if (cancellation === "caller") {
      expect((outcome as Error).cause).toBe(cause);
    }
    expect(h.calls).toEqual([]);
    expect(h.timer.getPendingTimeoutCount()).toBe(0);
    release(fakeCaptureDir(1));
    await flushMicrotasks();
    expect(h.removed).toEqual([fakeCaptureDir(1)]);
    expect(h.calls).toEqual([]);
    expect(h.timer.getPendingTimeoutCount()).toBe(0);
    await pending;
  });
}

for (const failed of [false, true]) {
  test(`stalled cleanup preserves ${failed ? "typed failure" : "PNG success"} after its bound`, async () => {
    const debug = spyOn(logger, "debug").mockImplementation(() => {});
    const frame = png(2853, 2007);
    const h = captureHarness({
      frame,
      exitCode: failed ? 17 : 0,
      cleanup: () => new Promise<void>(() => {}),
    });
    let outcome: unknown;
    const pending = h.simctl.screenshot(udid, "primary-1").then(
      (value) => {
        outcome = value;
      },
      (error: unknown) => {
        outcome = error;
      },
    );
    try {
      await flushMicrotasks();
      expect(h.removed).toEqual([fakeCaptureDir(1)]);
      h.timer.advanceTime(1_000);
      await flushMicrotasks();
      if (failed) {
        expect(outcome).toBeInstanceOf(SimctlScreenshotError);
        expect(outcome).toMatchObject({ reason: "non-zero-exit", exitCode: 17 });
      } else {
        expect(outcome).toEqual(frame);
      }
      expect(debug.mock.calls.some((call) => String(call[0]).includes("cleanup"))).toBe(true);
      expect(h.timer.getPendingTimeoutCount()).toBe(0);
      await pending;
    } finally {
      debug.mockRestore();
    }
  });
}

test("stalled child settlement preserves caller abort after its bound", async () => {
  const debug = spyOn(logger, "debug").mockImplementation(() => {});
  const h = captureHarness({ manual: true, abortOnError: false });
  const caller = new AbortController();
  const cause = new Error("child cancelled");
  let outcome: unknown;
  const pending = h.simctl.screenshot(udid, "primary-1", caller.signal).then(
    (value) => {
      outcome = value;
    },
    (error: unknown) => {
      outcome = error;
    },
  );
  try {
    await h.started;
    h.timer.advanceTime(25);
    caller.abort(cause);
    await flushMicrotasks();
    expect(h.removed).toEqual([]);
    h.timer.advanceTime(1_000);
    await flushMicrotasks();
    expect(outcome).toBeInstanceOf(SimctlScreenshotError);
    expect(outcome).toMatchObject({
      reason: "aborted-by-caller",
      cause,
      message: "simctl screenshot cancelled by the caller after 25ms: child cancelled",
    });
    expect(h.removed).toEqual([fakeCaptureDir(1)]);
    expect(debug.mock.calls.some((call) => String(call[0]).includes("cleanup"))).toBe(true);
    expect(h.timer.getPendingTimeoutCount()).toBe(0);
    await pending;
  } finally {
    debug.mockRestore();
  }
});

test("mkdtemp failure before abort remains a typed read failure", async () => {
  const cause = new Error("setup denied");
  const h = captureHarness({
    mkdtemp: async () => {
      throw cause;
    },
  });
  await expect(h.simctl.screenshot(udid, "primary-1")).rejects.toMatchObject({
    reason: "read-failure",
    cause,
    message: "Unable to prepare simctl screenshot temp directory",
  });
  expect(h.calls).toEqual([]);
  expect(h.removed).toEqual([]);
  expect(h.timer.getPendingTimeoutCount()).toBe(0);
});

test("simctl screenshot reads PNG bytes from an absolute private temp path and removes it", async () => {
  const frame = png(2853, 2007);
  const h = captureHarness({ frame });
  expect(await h.simctl.screenshot(udid, "primary-1")).toEqual(frame);
  const path = h.calls[0]!.at(-1)!;
  expect(isAbsolute(path)).toBe(true);
  expect(path).toBe(join(h.removed[0]!, "screenshot-capture-1.png"));
  expect(h.calls).toEqual([["simctl", "io", udid, "screenshot", "--display=primary-1", path]]);
  expect(h.calls[0]).not.toContain("-");
  expect(h.files.size).toBe(0);
  expect(h.events).toEqual(["close", "read", "cleanup"]);
});

for (const cancellation of ["caller", "timeout"] as const) {
  for (const lateRead of ["resolve", "reject"] as const) {
    test(`simctl screenshot abandons pending read on ${cancellation} cancellation with late ${lateRead}`, async () => {
      const caller = new AbortController();
      const cause = new Error("pending read cancelled");
      let release: (buffer: Buffer) => void = () => {};
      let rejectRead: (error: Error) => void = () => {};
      const read = new Promise<Buffer>((resolve, reject) => {
        release = resolve;
        rejectRead = reject;
      });
      let notifyRead: () => void = () => {};
      const readStarted = new Promise<void>((resolve) => {
        notifyRead = resolve;
      });
      const h = captureHarness({
        manual: true,
        read: () => {
          notifyRead();
          return read;
        },
      });
      let outcome: unknown;
      const screenshot = h.simctl.screenshot(udid, "primary-1", caller.signal).then(
        (buffer) => {
          outcome = buffer;
        },
        (error: unknown) => {
          outcome = error;
        },
      );
      await h.started;
      h.timer.advanceTime(4_000);
      h.children[0]!.emit("close", 0);
      await readStarted;
      h.timer.advanceTime(cancellation === "timeout" ? 6_000 : 25);
      if (cancellation === "caller") {
        caller.abort(cause);
      }
      // Flush promise continuations without waiting for the deliberately pending read.
      for (let turn = 0; turn < 20; turn++) {
        await Promise.resolve();
      }
      try {
        expect(outcome).toBeInstanceOf(SimctlScreenshotError);
        expect(outcome).toMatchObject({
          reason: cancellation === "caller" ? "aborted-by-caller" : "aborted-by-timeout",
          exitCode: 0,
          message:
            cancellation === "caller"
              ? "simctl screenshot cancelled by the caller after 4025ms: pending read cancelled"
              : "simctl screenshot timed out after 10000ms",
          ...(cancellation === "caller" ? { cause } : {}),
        });
        expect(h.removed).toEqual([fakeCaptureDir(1)]);
        expect(h.timer.getPendingTimeoutCount()).toBe(0);
      } finally {
        if (lateRead === "resolve") {
          release(png(2853, 2007));
        } else {
          rejectRead(new Error("late read failure"));
        }
        await screenshot;
      }
      const cancelled = outcome;
      for (let turn = 0; turn < 20; turn++) {
        await Promise.resolve();
      }
      expect(outcome).toBe(cancelled);
      expect(h.removed).toHaveLength(1);
    });
  }
}

test("simctl screenshot honors caller abort between close and read", async () => {
  const caller = new AbortController();
  const cause = new Error("cancelled after close");
  const h = captureHarness({ manual: true });
  const screenshot = h.simctl.screenshot(udid, "primary-1", caller.signal);
  await h.started;
  h.files.set(h.calls[0]!.at(-1)!, png(2853, 2007));
  h.children[0]!.emit("close", 0);
  caller.abort(cause);
  await expect(screenshot).rejects.toMatchObject({ reason: "aborted-by-caller", cause });
  expect(h.events).not.toContain("read");
  expect(h.removed).toEqual([fakeCaptureDir(1)]);
  expect(h.timer.getPendingTimeoutCount()).toBe(0);
});

for (const scenario of [
  { reason: "missing-output-file", options: {}, byteLength: 0 },
  { reason: "empty-output", options: { frame: Buffer.alloc(0) }, byteLength: 0 },
  { reason: "non-image-output", options: { frame: Buffer.from("not PNG") }, byteLength: 7 },
  {
    reason: "read-failure",
    options: { readError: Object.assign(new Error("permission denied"), { code: "EACCES" }) },
    byteLength: 0,
  },
]) {
  test(`simctl screenshot reports ${scenario.reason} with cleanup and diagnostics`, async () => {
    const h = captureHarness(scenario.options);
    const error = await h.simctl.screenshot(udid, "primary-1").catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(SimctlScreenshotError);
    expect(error).toMatchObject({
      reason: scenario.reason,
      exitCode: 0,
      byteLength: scenario.byteLength,
      stderrExcerpt: "Wrote screenshot to file",
    });
    if ("readError" in scenario.options) {
      expect((error as Error).cause).toBe(scenario.options.readError);
    }
    expect(h.removed).toHaveLength(1);
  });
}

test("simctl screenshot truncates stderr on non-zero exit and cleans up", async () => {
  const stderr = "simctl diagnostic ".padEnd(340, "x");
  const h = captureHarness({ exitCode: 17, stderr });
  const error = await h.simctl.screenshot(udid, "primary-1").catch((caught: unknown) => caught);
  expect(error).toBeInstanceOf(SimctlScreenshotError);
  expect(error).toMatchObject({
    reason: "non-zero-exit",
    exitCode: 17,
    stderrExcerpt: stderr.slice(0, 300),
  });
  expect((error as Error).message.startsWith("simctl screenshot failed:")).toBe(true);
  expect(h.events).toEqual(["close", "cleanup"]);
});

for (const failed of [false, true]) {
  test(`cleanup failure preserves ${failed ? "the original capture failure" : "a successful capture"}`, async () => {
    const debug = spyOn(logger, "debug").mockImplementation(() => {});
    const frame = png(2853, 2007);
    const h = captureHarness({
      frame,
      exitCode: failed ? 17 : 0,
      cleanupError: new Error("cleanup denied"),
    });
    try {
      const pending = h.simctl.screenshot(udid, "primary-1");
      if (failed) {
        await expect(pending).rejects.toMatchObject({ reason: "non-zero-exit", exitCode: 17 });
      } else {
        expect(await pending).toEqual(frame);
      }
      expect(h.removed).toHaveLength(1);
      expect(debug.mock.calls.some((call) => String(call[0]).includes("cleanup"))).toBe(true);
    } finally {
      debug.mockRestore();
    }
  });
}

test("concurrent captures use different output paths and clean up both directories", async () => {
  const h = captureHarness({ frame: png(2853, 2007) });
  await Promise.all([
    h.simctl.screenshot(udid, "primary-1"),
    h.simctl.screenshot(udid, "primary-0"),
  ]);
  expect(new Set(h.calls.map((args) => args.at(-1))).size).toBe(2);
  expect(new Set(h.removed).size).toBe(2);
  expect(h.files.size).toBe(0);
});

test("missing output file still falls back to runner with its typed warning", async () => {
  const h = captureHarness();
  const warn = spyOn(logger, "warn").mockImplementation(() => {});
  let fallback = 0;
  try {
    const result = await captureIosPanelScreenshot(
      device,
      { updatedAt: 0, packageName: "app", hierarchy: {}, pixelWidth: 2853, pixelHeight: 2007 },
      h.simctl,
      async () => {
        fallback++;
        return { success: true, data: "runner" };
      },
    );
    expect(result.data).toBe("runner");
    expect(fallback).toBe(1);
    expect(warn.mock.calls).toHaveLength(1);
    expect(warn.mock.calls[0]?.[0]).toContain("reason=missing-output-file exit=0");
    expect(h.removed).toHaveLength(1);
  } finally {
    warn.mockRestore();
  }
});

test("spawn failure remains typed and removes the private directory", async () => {
  const cause = new Error("spawn failed");
  const h = captureHarness({ spawnError: cause });
  await expect(h.simctl.screenshot(udid, "primary-1")).rejects.toMatchObject({
    reason: "non-zero-exit",
    cause,
  });
  expect(h.removed).toHaveLength(1);
  expect(h.timer.getPendingTimeoutCount()).toBe(0);
});

test("pre-aborted caller never spawns and still removes its private directory", async () => {
  const caller = new AbortController();
  const cause = new Error("already cancelled");
  caller.abort(cause);
  const h = captureHarness();
  await expect(h.simctl.screenshot(udid, "primary-1", caller.signal)).rejects.toMatchObject({
    reason: "aborted-by-caller",
    cause,
  });
  expect(h.calls).toHaveLength(0);
  expect(h.removed).toHaveLength(1);
  expect(h.timer.getPendingTimeoutCount()).toBe(0);
});

test("multi-panel screenshot falls back with a warning when simctl returns cover dimensions", async () => {
  let fallback = 0;
  const result = await captureIosPanelScreenshot(
    device,
    { updatedAt: 0, packageName: "app", hierarchy: {}, pixelWidth: 2853, pixelHeight: 2007 },
    { screenshot: async () => png(1398, 2034) },
    async () => {
      fallback++;
      return { success: true, data: "runner" };
    },
  );
  expect(fallback).toBe(1);
  expect(result.data).toBe("runner");
});

test("multi-panel screenshot selects the inner panel from live hierarchy pixels", async () => {
  const captures: string[] = [];
  // Synthetic PNG header using the issue-reported landscape dimensions.
  const issueReportedPanelPng = png(2853, 2007);
  const result = await captureIosPanelScreenshot(
    device,
    { updatedAt: 0, packageName: "app", hierarchy: {}, pixelWidth: 2007, pixelHeight: 2853 },
    {
      screenshot: async (_deviceId, display) => {
        captures.push(display);
        return issueReportedPanelPng;
      },
    },
    async () => {
      throw new Error("runner should not capture the cover panel");
    },
  );
  expect(captures).toEqual(["primary-1"]);
  expect(result.data).toBe(issueReportedPanelPng.toString("base64"));
});

test("inner panel rejects a cover-sized PNG despite matching hierarchy points at scale", async () => {
  const frame = png(1398, 2034);
  expect(device.displays?.panels.find((panel) => panel.key === "primary-1")?.sizePx).toEqual({
    width: 2007,
    height: 2853,
  });
  const result = await captureIosPanelScreenshot(
    device,
    {
      updatedAt: 0,
      packageName: "app",
      hierarchy: {},
      screenWidth: 466,
      screenHeight: 678,
      screenScale: 3,
    },
    { screenshot: async () => frame },
    async () => ({ success: true, data: "runner" }),
    undefined,
    "primary-1",
  );
  expect(result.data).toBe("runner");
});

test("simctl screenshot reports its 10s timeout and cleans up after process error", async () => {
  const h = captureHarness({ manual: true });
  const screenshot = h.simctl.screenshot(udid, "primary-1");
  await h.started;
  h.timer.advanceTime(10_000);
  await expect(screenshot).rejects.toThrow("simctl screenshot timed out after 10000ms");
  await expect(screenshot).rejects.toMatchObject({ reason: "aborted-by-timeout" });
  expect(h.timer.getPendingTimeoutCount()).toBe(0);
  expect(h.events).toEqual(["error", "cleanup"]);
});

test("simctl screenshot reports caller cancellation and cleans up after process error", async () => {
  const caller = new AbortController();
  const h = captureHarness({ manual: true });
  const screenshot = h.simctl.screenshot(udid, "primary-1", caller.signal);
  await h.started;
  h.timer.advanceTime(25);
  caller.abort(new Error("distinct caller reason"));
  await expect(screenshot).rejects.toThrow(
    "simctl screenshot cancelled by the caller after 25ms: distinct caller reason",
  );
  await expect(screenshot).rejects.toMatchObject({ reason: "aborted-by-caller" });
  expect(h.timer.getPendingTimeoutCount()).toBe(0);
  expect(h.events).toEqual(["error", "cleanup"]);
});

test("simctl screenshot late close after caller abort preserves attribution and cause", async () => {
  const caller = new AbortController();
  const h = captureHarness({ manual: true, abortOnError: false });
  const pending = h.simctl.screenshot(udid, "primary-1", caller.signal);
  await h.started;
  const reason = new Error("capture cancelled");
  caller.abort(reason);
  expect(h.removed).toHaveLength(0);
  // Cleanup must wait for process settlement, even after cancellation.
  h.children[0]?.emit("close", 0);
  const error = await pending.catch((caught: unknown) => caught);
  expect(error).toBeInstanceOf(SimctlScreenshotError);
  expect(error).toMatchObject({
    reason: "aborted-by-caller",
    message: expect.stringContaining("capture cancelled"),
  });
  expect((error as Error).cause).toBe(reason);
  expect(h.removed).toHaveLength(1);
});

test("panel capture failure falls back to the runner and the warning names the caller-signal state", async () => {
  const warn = spyOn(logger, "warn").mockImplementation(() => {});
  const caller = new AbortController();
  const runnerResult = { success: true, data: "runner" };
  try {
    const result = await captureIosPanelScreenshot(
      device,
      // values reported in issue #8379's 2026-10-01 device verification
      { updatedAt: 0, packageName: "app", hierarchy: {}, pixelWidth: 2853, pixelHeight: 2007 },
      {
        screenshot: async () => {
          throw new Error("simctl screenshot timed out after 10000ms");
        },
      },
      async () => runnerResult,
      caller.signal,
    );
    expect(result).toBe(runnerResult);
    expect(warn.mock.calls).toHaveLength(1);
    expect(warn.mock.calls[0]?.[0]).toContain("caller signal aborted: false");
    expect(warn.mock.calls[0]?.[0]).toContain("simctl screenshot timed out after 10000ms");
  } finally {
    warn.mockRestore();
  }
});

test("panel capture logs one empty-output diagnostic before runner fallback", async () => {
  const warn = spyOn(logger, "warn").mockImplementation(() => {});
  let fallback = 0;
  try {
    await captureIosPanelScreenshot(
      device,
      { updatedAt: 0, packageName: "app", hierarchy: {}, pixelWidth: 2853, pixelHeight: 2007 },
      { screenshot: async () => Buffer.alloc(0) },
      async () => {
        fallback++;
        return { success: true, data: "runner" };
      },
    );
    expect(fallback).toBe(1);
    expect(warn.mock.calls).toHaveLength(1);
    expect(warn.mock.calls[0]?.[0]).toContain(
      "capture unidentifiable (reason=empty-output): bytes=0 magic=",
    );
    expect(warn.mock.calls[0]?.[0]).toContain("exit=0 stderr=n/a");
  } finally {
    warn.mockRestore();
  }
});

test("panel capture logs one non-image diagnostic with the first 16 bytes before runner fallback", async () => {
  const warn = spyOn(logger, "warn").mockImplementation(() => {});
  let fallback = 0;
  const nonImage = Buffer.alloc(32, 0xab);
  try {
    await captureIosPanelScreenshot(
      device,
      { updatedAt: 0, packageName: "app", hierarchy: {}, pixelWidth: 2853, pixelHeight: 2007 },
      { screenshot: async () => nonImage },
      async () => {
        fallback++;
        return { success: true, data: "runner" };
      },
    );
    expect(fallback).toBe(1);
    expect(warn.mock.calls).toHaveLength(1);
    expect(warn.mock.calls[0]?.[0]).toContain("reason=non-image-output): bytes=32");
    expect(warn.mock.calls[0]?.[0]).toContain("magic=abababababababababababababababab");
  } finally {
    warn.mockRestore();
  }
});

test("panel capture includes typed simctl failure diagnostics in one warning", async () => {
  const warn = spyOn(logger, "warn").mockImplementation(() => {});
  try {
    const result = await captureIosPanelScreenshot(
      device,
      { updatedAt: 0, packageName: "app", hierarchy: {}, pixelWidth: 2853, pixelHeight: 2007 },
      {
        screenshot: async () => {
          throw new SimctlScreenshotError(
            "non-zero-exit",
            "simctl screenshot failed: device busy",
            {
              exitCode: 9,
              stderr: "device busy",
              byteLength: 4,
            },
          );
        },
      },
      async () => ({ success: true, data: "runner" }),
    );
    expect(result.data).toBe("runner");
    expect(warn.mock.calls).toHaveLength(1);
    expect(warn.mock.calls[0]?.[0]).toContain("capture failed; using runner capture:");
    expect(warn.mock.calls[0]?.[0]).toContain(
      'reason=non-zero-exit exit=9 stderr="device busy" bytes=4',
    );
  } finally {
    warn.mockRestore();
  }
});

test("panel capture distinguishes timeout and caller abort in one warning each", async () => {
  const warn = spyOn(logger, "warn").mockImplementation(() => {});
  try {
    const timeoutResult = await captureIosPanelScreenshot(
      device,
      { updatedAt: 0, packageName: "app", hierarchy: {}, pixelWidth: 2853, pixelHeight: 2007 },
      {
        screenshot: async () => {
          throw new SimctlScreenshotError("aborted-by-timeout", "simctl screenshot timed out", {
            byteLength: 12,
          });
        },
      },
      async () => ({ success: true, data: "timeout-runner" }),
    );
    expect(timeoutResult.data).toBe("timeout-runner");
    expect(warn.mock.calls).toHaveLength(1);
    expect(warn.mock.calls[0]?.[0]).toContain("reason=aborted-by-timeout");
    expect(warn.mock.calls[0]?.[0]).toContain("timeoutAborted=true");
    expect(warn.mock.calls[0]?.[0]).toContain("caller signal aborted: false");

    warn.mockClear();
    const caller = new AbortController();
    caller.abort(new Error("caller stopped"));
    const callerResult = await captureIosPanelScreenshot(
      device,
      { updatedAt: 0, packageName: "app", hierarchy: {}, pixelWidth: 2853, pixelHeight: 2007 },
      {
        screenshot: async () => {
          throw new SimctlScreenshotError("aborted-by-caller", "simctl screenshot cancelled", {
            byteLength: 7,
            cause: caller.signal.reason,
          });
        },
      },
      async () => ({ success: true, data: "caller-runner" }),
      caller.signal,
    );
    expect(callerResult.data).toBe("caller-runner");
    expect(warn.mock.calls).toHaveLength(1);
    expect(warn.mock.calls[0]?.[0]).toContain("reason=aborted-by-caller");
    expect(warn.mock.calls[0]?.[0]).toContain("timeoutAborted=false");
    expect(warn.mock.calls[0]?.[0]).toContain("caller signal aborted: true");
  } finally {
    warn.mockRestore();
  }
});

test("valid panel PNG is accepted without a warning", async () => {
  const warn = spyOn(logger, "warn").mockImplementation(() => {});
  const frame = png(2853, 2007);
  try {
    const result = await captureIosPanelScreenshot(
      device,
      { updatedAt: 0, packageName: "app", hierarchy: {}, pixelWidth: 2853, pixelHeight: 2007 },
      { screenshot: async () => frame },
      async () => ({ success: true, data: "runner" }),
    );
    expect(warn.mock.calls).toHaveLength(0);
    expect(result.data).toBe(frame.toString("base64"));
  } finally {
    warn.mockRestore();
  }
});

test("screenshot spawn explicitly selects the custom device set (#6900)", async () => {
  const saved = process.env[CORESIMULATOR_DEVICE_SET_PATH_ENV];
  process.env[CORESIMULATOR_DEVICE_SET_PATH_ENV] = " /custom/device set ";
  try {
    const harness = captureHarness({ frame: png(10, 20) });
    await harness.simctl.screenshot(udid, "0");
    expect(harness.calls[0].slice(0, -1)).toEqual([
      "simctl",
      "--set",
      "/custom/device set",
      "io",
      udid,
      "screenshot",
      "--display=0",
    ]);
  } finally {
    if (saved === undefined) {
      delete process.env[CORESIMULATOR_DEVICE_SET_PATH_ENV];
    } else {
      process.env[CORESIMULATOR_DEVICE_SET_PATH_ENV] = saved;
    }
  }
});
