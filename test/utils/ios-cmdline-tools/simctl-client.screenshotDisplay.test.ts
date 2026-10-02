import { expect, spyOn, test } from "bun:test";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import type { ChildProcess, SpawnOptions } from "node:child_process";
import {
  SimCtlClient,
  SimctlScreenshotError,
} from "../../../src/utils/ios-cmdline-tools/SimCtlClient";
import { logger } from "../../../src/utils/logger";
import { captureIosPanelScreenshot } from "../../../src/features/observe/ios/CtrlProxyScreenshot";
import type { BootedDevice } from "../../../src/models";
import { loadDuoEnumerate } from "../../fixtures/loadDuoEnumerate";
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

test("simctl screenshot passes the selected display as one argv token and preserves PNG bytes", async () => {
  const calls: string[][] = [];
  const frame = png(2853, 2007);
  const spawn = (_file: string, args: string[]): ChildProcess => {
    calls.push(args);
    const child = new EventEmitter() as ChildProcess;
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    Object.assign(child, { stdout, stderr });
    queueMicrotask(() => {
      stdout.end(frame);
      stderr.end();
      child.emit("close", 0);
    });
    return child;
  };
  const simctl = new SimCtlClient(device, null, new FakeTimer(), "darwin", spawn);
  expect(await simctl.screenshot(udid, "primary-1")).toEqual(frame);
  expect(calls).toEqual([["simctl", "io", udid, "screenshot", "--display=primary-1", "-"]]);
});

test("simctl screenshot reports empty successful output as a typed failure", async () => {
  const spawn = (): ChildProcess => {
    const child = new EventEmitter() as ChildProcess;
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    Object.assign(child, { stdout, stderr });
    queueMicrotask(() => {
      stdout.end();
      stderr.end();
      child.emit("close", 0);
    });
    return child;
  };
  const simctl = new SimCtlClient(device, null, new FakeTimer(), "darwin", spawn);
  await expect(simctl.screenshot(udid, "primary-1")).rejects.toMatchObject({
    name: "SimctlScreenshotError",
    reason: "empty-output",
    exitCode: 0,
    byteLength: 0,
  });
});

test("simctl screenshot truncates stderr on typed non-zero exit while preserving its message", async () => {
  const stderrText = "simctl diagnostic ".padEnd(340, "x");
  const spawn = (): ChildProcess => {
    const child = new EventEmitter() as ChildProcess;
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    Object.assign(child, { stdout, stderr });
    queueMicrotask(() => {
      stderr.end(stderrText);
      child.emit("close", 17);
    });
    return child;
  };
  const simctl = new SimCtlClient(device, null, new FakeTimer(), "darwin", spawn);
  const failure = simctl.screenshot(udid, "primary-1");
  await expect(failure).rejects.toBeInstanceOf(SimctlScreenshotError);
  const error = await failure.catch((caught: unknown) => caught);
  expect(error).toMatchObject({
    reason: "non-zero-exit",
    exitCode: 17,
    stderrExcerpt: stderrText.slice(0, 300),
  });
  expect((error as Error).message.startsWith("simctl screenshot failed:")).toBe(true);
});

test("simctl screenshot rejects a late successful close after caller abort", async () => {
  const controller = new AbortController();
  let child: ChildProcess | undefined;
  const spawn = (): ChildProcess => {
    child = new EventEmitter() as ChildProcess;
    Object.assign(child, { stdout: new PassThrough(), stderr: new PassThrough() });
    return child;
  };
  const simctl = new SimCtlClient(device, null, new FakeTimer(), "darwin", spawn);
  const pending = simctl.screenshot(udid, "primary-1", controller.signal);
  controller.abort(new Error("capture cancelled"));
  child?.emit("close", 0);
  await expect(pending).rejects.toThrow("capture cancelled");
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

function abortingSpawn(
  _file: string,
  _args: readonly string[],
  options?: SpawnOptions,
): ChildProcess {
  const child = new EventEmitter() as ChildProcess;
  Object.assign(child, { stdout: new PassThrough(), stderr: new PassThrough() });
  options?.signal?.addEventListener(
    "abort",
    () => {
      child.emit(
        "error",
        Object.assign(new Error("The operation was aborted"), { name: "AbortError" }),
      );
    },
    { once: true },
  );
  return child;
}

test("simctl screenshot reports its 10s timeout, not a bare AbortError", async () => {
  const timer = new FakeTimer();
  const simctl = new SimCtlClient(device, null, timer, "darwin", abortingSpawn);
  const screenshot = simctl.screenshot(udid, "primary-1");
  timer.advanceTime(10_000);
  await expect(screenshot).rejects.toThrow("simctl screenshot timed out after 10000ms");
  await expect(screenshot).rejects.toMatchObject({ reason: "aborted-by-timeout" });
  expect(timer.getPendingTimeoutCount()).toBe(0);
});

test("simctl screenshot reports a caller cancellation", async () => {
  const timer = new FakeTimer();
  const caller = new AbortController();
  const simctl = new SimCtlClient(device, null, timer, "darwin", abortingSpawn);
  const screenshot = simctl.screenshot(udid, "primary-1", caller.signal);
  timer.advanceTime(25);
  caller.abort(new Error("distinct caller reason"));
  await expect(screenshot).rejects.toThrow(
    "simctl screenshot cancelled by the caller after 25ms: distinct caller reason",
  );
  expect(timer.getPendingTimeoutCount()).toBe(0);
});

test("simctl screenshot close after caller abort carries typed attribution and cause", async () => {
  const caller = new AbortController();
  let child: ChildProcess | undefined;
  const spawn = (): ChildProcess => {
    child = new EventEmitter() as ChildProcess;
    Object.assign(child, { stdout: new PassThrough(), stderr: new PassThrough() });
    return child;
  };
  const simctl = new SimCtlClient(device, null, new FakeTimer(), "darwin", spawn);
  const pending = simctl.screenshot(udid, "primary-1", caller.signal);
  const reason = new Error("capture cancelled");
  caller.abort(reason);
  child?.emit("close", 0);
  const error = await pending.catch((caught: unknown) => caught);
  expect(error).toBeInstanceOf(SimctlScreenshotError);
  expect(error).toMatchObject({
    reason: "aborted-by-caller",
    message: expect.stringContaining("capture cancelled"),
  });
  expect((error as SimctlScreenshotError).cause).toBe(reason);
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
