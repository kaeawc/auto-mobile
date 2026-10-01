import { expect, spyOn, test } from "bun:test";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import type { ChildProcess, SpawnOptions } from "node:child_process";
import { SimCtlClient } from "../../../src/utils/ios-cmdline-tools/SimCtlClient";
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
