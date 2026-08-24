import { describe, expect, test } from "bun:test";
import {
  normalizeAnr,
  normalizeCrash,
  type SdkAnrPayload,
  type SdkCrashPayload,
} from "../../../../src/features/observe/crash/sdkCrashIngestion";

function makeCrashPayload(overrides: Partial<SdkCrashPayload> = {}): SdkCrashPayload {
  return {
    timestamp: 1_700_000_000,
    exceptionClass: "java.lang.NullPointerException",
    message: "npe",
    stackTrace: "at com.example.Main.run(Main.java:42)",
    threadName: "main",
    packageName: "com.example.app",
    appVersion: "1.2.3",
    deviceInfo: {
      model: "Pixel 7",
      manufacturer: "Google",
      osVersion: "14",
      sdkInt: 34,
    },
    ...overrides,
  };
}

function makeAnrPayload(overrides: Partial<SdkAnrPayload> = {}): SdkAnrPayload {
  return {
    timestamp: 1_700_000_500,
    pid: 12345,
    processName: "com.example.app",
    importance: "FOREGROUND",
    reason: "Input dispatching timed out",
    trace: "at android.os.MessageQueue.nativePollOnce(Native Method)",
    appVersion: "1.2.3",
    deviceInfo: {
      model: "Pixel 7",
      manufacturer: "Google",
      osVersion: "14",
      sdkInt: 34,
    },
    ...overrides,
  };
}

describe("normalizeCrash", () => {
  test("maps SDK payload fields to CrashEvent shape", () => {
    const event = normalizeCrash(makeCrashPayload(), "emulator-5554");
    expect(event.deviceId).toBe("emulator-5554");
    expect(event.packageName).toBe("com.example.app");
    expect(event.crashType).toBe("java");
    expect(event.detectionSource).toBe("sdk_websocket");
    expect(event.timestamp).toBe(1_700_000_000);
    expect(event.threadName).toBe("main");
    expect(event.exceptionClass).toBe("java.lang.NullPointerException");
    expect(event.exceptionMessage).toBe("npe");
    expect(event.stacktrace).toBe("at com.example.Main.run(Main.java:42)");
    expect(event.appVersion).toBe("1.2.3");
    expect(event.deviceInfo?.model).toBe("Pixel 7");
  });

  test("passes through currentScreen when present", () => {
    const event = normalizeCrash(
      makeCrashPayload({ currentScreen: "HomeScreen" }),
      "emulator-5554",
    );
    expect(event.currentScreen).toBe("HomeScreen");
  });

  test("leaves optional message undefined when absent", () => {
    const event = normalizeCrash(makeCrashPayload({ message: undefined }), "emulator-5554");
    expect(event.exceptionMessage).toBeUndefined();
  });
});

describe("normalizeAnr", () => {
  test("maps SDK payload fields and renames trace -> stacktrace", () => {
    const event = normalizeAnr(makeAnrPayload(), "emulator-5554");
    expect(event.deviceId).toBe("emulator-5554");
    expect(event.packageName).toBe("com.example.app");
    expect(event.detectionSource).toBe("sdk_websocket");
    expect(event.pid).toBe(12345);
    expect(event.processName).toBe("com.example.app");
    expect(event.importance).toBe("FOREGROUND");
    expect(event.reason).toBe("Input dispatching timed out");
    expect(event.stacktrace).toBe("at android.os.MessageQueue.nativePollOnce(Native Method)");
  });

  test("falls back to processName when payload packageName is absent", () => {
    const event = normalizeAnr(
      makeAnrPayload({ packageName: undefined, processName: "com.proc.name" }),
      "emulator-5554",
    );
    expect(event.packageName).toBe("com.proc.name");
  });

  test("prefers payload packageName over processName", () => {
    const event = normalizeAnr(makeAnrPayload({ packageName: "com.payload.pkg" }), "emulator-5554");
    expect(event.packageName).toBe("com.payload.pkg");
  });
});
