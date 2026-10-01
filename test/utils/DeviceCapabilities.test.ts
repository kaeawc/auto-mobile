import { afterEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { BootedDevice, ExecResult } from "../../src/models";
import {
  DeviceCapabilitiesDetector,
  clearDeviceCapabilitiesCache,
  REFRESH_RATE_DETECTION_BUDGET_MS,
  REFRESH_RATE_PROBE_TIMEOUT_MS,
} from "../../src/utils/DeviceCapabilities";
import { setDeviceIncarnationResolver } from "../../src/utils/deviceIncarnation";
import { FakeAdbClient } from "../fakes/FakeAdbClient";
import { FakeAdbClientFactory } from "../fakes/FakeAdbClientFactory";
import { FakeTimer } from "../fakes/FakeTimer";

const DISPLAY_MODES_CAPTURE = readFileSync(
  join(import.meta.dir, "../fixtures/android-display/phone-display-device-info.txt"),
  "utf8",
);

function device(deviceId: string): BootedDevice {
  return { name: deviceId, deviceId, platform: "android" };
}

afterEach(() => {
  clearDeviceCapabilitiesCache();
  setDeviceIncarnationResolver(undefined);
});

describe("DeviceCapabilitiesDetector", () => {
  test("bounds empty-output probes, disables retries, and falls back after at most three calls", async () => {
    const adb = new FakeAdbClient();
    const detector = new DeviceCapabilitiesDetector(
      device("empty-device"),
      new FakeAdbClientFactory(adb),
    );

    expect(await detector.detectRefreshRate()).toBe(60);
    const calls = adb.getCommandCalls();
    expect(calls).toHaveLength(3);
    expect(calls.every((call) => call.noRetry === true)).toBe(true);
    expect(
      calls.every(
        (call) =>
          call.timeoutMs !== undefined &&
          call.timeoutMs > 0 &&
          call.timeoutMs <= REFRESH_RATE_PROBE_TIMEOUT_MS,
      ),
    ).toBe(true);
  });

  test("stops issuing probes when the total time budget is exhausted", async () => {
    const timer = new FakeTimer();
    class BudgetAdvancingAdb extends FakeAdbClient {
      override async executeCommand(
        command: string,
        timeoutMs?: number,
        maxBuffer?: number,
        noRetry?: boolean,
        signal?: AbortSignal,
        waitForProcessSettlementAfterAbort?: boolean,
      ): Promise<ExecResult> {
        const result = await super.executeCommand(
          command,
          timeoutMs,
          maxBuffer,
          noRetry,
          signal,
          waitForProcessSettlementAfterAbort,
        );
        timer.advanceTime(REFRESH_RATE_DETECTION_BUDGET_MS);
        return result;
      }
    }

    const adb = new BudgetAdvancingAdb();
    const detector = new DeviceCapabilitiesDetector(
      device("budget-device"),
      new FakeAdbClientFactory(adb),
      timer,
    );

    expect(await detector.detectRefreshRate()).toBe(60);
    expect(adb.getCommandCalls()).toHaveLength(1);
    expect(timer.now()).toBeGreaterThanOrEqual(REFRESH_RATE_DETECTION_BUDGET_MS);
  });

  test("uses the captured modes output and stops after its first conclusive source", async () => {
    const adb = new FakeAdbClient();
    adb.setCommandResult(
      "shell dumpsys display | grep -A 5 'mBaseDisplayInfo'",
      DISPLAY_MODES_CAPTURE,
    );
    const detector = new DeviceCapabilitiesDetector(
      device("captured-device"),
      new FakeAdbClientFactory(adb),
    );

    expect(await detector.detectRefreshRate()).toBe(60);
    expect(adb.getCommandCalls()).toHaveLength(3);
  });

  test("caches conclusive results per device incarnation", async () => {
    const adb = new FakeAdbClient();
    adb.setCommandResult(
      "shell dumpsys display | grep -A 5 'mBaseDisplayInfo'",
      DISPLAY_MODES_CAPTURE,
    );
    let incarnation = 1;
    setDeviceIncarnationResolver(() => incarnation);

    expect(
      await new DeviceCapabilitiesDetector(
        device("cached-device"),
        new FakeAdbClientFactory(adb),
      ).detectRefreshRate(),
    ).toBe(60);
    expect(
      await new DeviceCapabilitiesDetector(
        device("cached-device"),
        new FakeAdbClientFactory(adb),
      ).detectRefreshRate(),
    ).toBe(60);
    expect(adb.getCommandCalls()).toHaveLength(3);

    incarnation = 2;
    expect(
      await new DeviceCapabilitiesDetector(
        device("cached-device"),
        new FakeAdbClientFactory(adb),
      ).detectRefreshRate(),
    ).toBe(60);
    expect(adb.getCommandCalls()).toHaveLength(6);

    expect(
      await new DeviceCapabilitiesDetector(
        device("other-device"),
        new FakeAdbClientFactory(adb),
      ).detectRefreshRate(),
    ).toBe(60);
    expect(adb.getCommandCalls()).toHaveLength(9);
  });

  test("does not cache a 60Hz fallback after a command error", async () => {
    const adb = new FakeAdbClient();
    adb.setCommandError("shell dumpsys display | grep mRefreshRate", new Error("probe failed"));
    const factory = new FakeAdbClientFactory(adb);

    expect(
      await new DeviceCapabilitiesDetector(device("error-device"), factory).detectRefreshRate(),
    ).toBe(60);
    expect(
      await new DeviceCapabilitiesDetector(device("error-device"), factory).detectRefreshRate(),
    ).toBe(60);
    expect(adb.getCommandCalls()).toHaveLength(2);
    expect(adb.getCommandCalls().every((call) => call.noRetry === true)).toBe(true);
  });
});
