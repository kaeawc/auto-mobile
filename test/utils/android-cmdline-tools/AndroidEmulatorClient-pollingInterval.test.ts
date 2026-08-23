import { afterEach, describe, expect, test } from "bun:test";
import type { ExecResult } from "../../../src/models";
import type { AdbClientFactory } from "../../../src/utils/android-cmdline-tools/AdbClientFactory";
import { AndroidEmulatorClient } from "../../../src/utils/android-cmdline-tools/AndroidEmulatorClient";
import { FakeAdbExecutor } from "../../fakes/FakeAdbExecutor";
import { FakeTimer } from "../../fakes/FakeTimer";

const POLLING_INTERVAL_ENV = "EMULATOR_POLLING_INTERVAL_MS";
const originalPollingInterval = process.env[POLLING_INTERVAL_ENV];

const result: ExecResult = {
  stdout: "",
  stderr: "",
  toString: () => "",
  trim: () => "",
  includes: () => false,
};

afterEach(() => {
  if (originalPollingInterval === undefined) {
    delete process.env[POLLING_INTERVAL_ENV];
  } else {
    process.env[POLLING_INTERVAL_ENV] = originalPollingInterval;
  }
});

async function observePollingInterval(value: string | undefined): Promise<number> {
  if (value === undefined) {
    delete process.env[POLLING_INTERVAL_ENV];
  } else {
    process.env[POLLING_INTERVAL_ENV] = value;
  }

  const timer = new FakeTimer();
  const client = new AndroidEmulatorClient(
    async () => result,
    null,
    timer,
    { create: () => new FakeAdbExecutor() } as AdbClientFactory,
  );
  const controller = new AbortController();
  const readiness = client.waitForEmulatorReady(
    "Missing",
    1_000,
    null,
    "emulator-5554",
    controller.signal,
  );

  for (let attempt = 0; attempt < 10 && timer.getPendingTimeoutCount() < 2; attempt += 1) {
    await new Promise<void>((resolve) => setImmediate(resolve));
  }

  const delays = timer.getPendingTimeouts();
  controller.abort(new Error("polling interval observed"));
  await expect(readiness).rejects.toThrow("polling interval observed");

  expect(delays[0]).toBe(500);
  expect(delays).toHaveLength(2);
  return delays[1];
}

describe("AndroidEmulatorClient polling interval configuration", () => {
  test("uses the safe default for absent or invalid values", async () => {
    const values = [
      undefined,
      "",
      "garbage",
      "-1",
      "0",
      "2147483648",
      "1e308",
      "9".repeat(400),
    ];
    const observed = [];

    for (const value of values) {
      observed.push(await observePollingInterval(value));
    }

    expect(observed).toEqual([500, 500, 500, 500, 500, 500, 500, 500]);
  });

  test("clamps finite positive values to the documented minimum", async () => {
    expect(await observePollingInterval("1")).toBe(100);
    expect(await observePollingInterval("99")).toBe(100);
    expect(await observePollingInterval("100")).toBe(100);
    expect(await observePollingInterval("250")).toBe(250);
  });

  test("chunks a large finite interval to preserve exit responsiveness", async () => {
    expect(await observePollingInterval("1e9")).toBe(500);
  });
});
