import { describe, test } from "bun:test";
import fc from "fast-check";
import type { CrashDeviceInfo } from "../../../../src/utils/interfaces/CrashMonitor";
import {
  normalizeAnr,
  normalizeCrash,
  type SdkAnrPayload,
  type SdkCrashPayload,
} from "../../../../src/features/observe/crash/sdkCrashIngestion";

// Property-based tests. See test/utils/Backoff.property.test.ts for the pinned-seed rationale.
const RUN_OPTIONS = { seed: 1_234_567, numRuns: 300 } as const;

const str = fc.string({ maxLength: 16 });
const optStr = fc.option(str, { nil: undefined });
const deviceInfo: fc.Arbitrary<CrashDeviceInfo> = fc.record({
  model: str,
  manufacturer: str,
  osVersion: str,
  sdkInt: fc.integer({ min: 1, max: 40 }),
});

const crashPayload: fc.Arbitrary<SdkCrashPayload> = fc.record({
  timestamp: fc.integer(),
  exceptionClass: str,
  message: optStr,
  stackTrace: str,
  threadName: str,
  currentScreen: optStr,
  packageName: str,
  appVersion: optStr,
  deviceInfo,
});

const anrPayload: fc.Arbitrary<SdkAnrPayload> = fc.record({
  timestamp: fc.integer(),
  pid: fc.integer(),
  processName: str,
  importance: str,
  trace: optStr,
  reason: str,
  packageName: optStr,
  appVersion: optStr,
  deviceInfo,
});

describe("normalizeCrash (property-based)", () => {
  test("stamps the constant java / sdk_websocket discriminators", () => {
    fc.assert(
      fc.property(crashPayload, str, (p, deviceId) => {
        const e = normalizeCrash(p, deviceId);
        return e.crashType === "java" && e.detectionSource === "sdk_websocket";
      }),
      RUN_OPTIONS,
    );
  });

  test("carries the deviceId argument and maps every payload field to its slot", () => {
    fc.assert(
      fc.property(crashPayload, str, (p, deviceId) => {
        const e = normalizeCrash(p, deviceId);
        return (
          e.deviceId === deviceId &&
          e.packageName === p.packageName &&
          e.timestamp === p.timestamp &&
          e.threadName === p.threadName &&
          e.exceptionClass === p.exceptionClass &&
          e.exceptionMessage === p.message &&
          e.stacktrace === p.stackTrace &&
          e.currentScreen === p.currentScreen &&
          e.appVersion === p.appVersion &&
          e.deviceInfo === p.deviceInfo
        );
      }),
      RUN_OPTIONS,
    );
  });
});

describe("normalizeAnr (property-based)", () => {
  test("stamps the constant sdk_websocket discriminator", () => {
    fc.assert(
      fc.property(
        anrPayload,
        str,
        (p, deviceId) => normalizeAnr(p, deviceId).detectionSource === "sdk_websocket",
      ),
      RUN_OPTIONS,
    );
  });

  test("packageName falls back to processName only when absent (nullish, not falsy)", () => {
    fc.assert(
      fc.property(
        anrPayload,
        str,
        (p, deviceId) => normalizeAnr(p, deviceId).packageName === (p.packageName ?? p.processName),
      ),
      RUN_OPTIONS,
    );
  });

  test("carries the deviceId argument and maps every payload field to its slot", () => {
    fc.assert(
      fc.property(anrPayload, str, (p, deviceId) => {
        const e = normalizeAnr(p, deviceId);
        return (
          e.deviceId === deviceId &&
          e.timestamp === p.timestamp &&
          e.processName === p.processName &&
          e.pid === p.pid &&
          e.reason === p.reason &&
          e.stacktrace === p.trace &&
          e.importance === p.importance &&
          e.appVersion === p.appVersion &&
          e.deviceInfo === p.deviceInfo
        );
      }),
      RUN_OPTIONS,
    );
  });
});
