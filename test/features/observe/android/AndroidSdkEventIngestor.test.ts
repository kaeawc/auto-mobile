import { describe, it, expect, beforeEach } from "bun:test";
import {
  DefaultAndroidSdkEventIngestor,
  type AndroidTelemetryRecorder,
  type AndroidHandledExceptionEvent,
} from "../../../../src/features/observe/android/AndroidSdkEventIngestor";
import type { FailureRecorderService } from "../../../../src/features/failures/interfaces/FailureRecorderService";
import type { StackTraceElement } from "../../../../src/server/failuresResources";
import type {
  SdkAnrPayload,
  SdkCrashPayload,
} from "../../../../src/features/observe/crash/sdkCrashIngestion";

/** Records every telemetry call for assertion. */
class FakeTelemetryRecorder implements AndroidTelemetryRecorder {
  contexts: Array<{ deviceId: string; sessionId: string | null }> = [];
  network: any[] = [];
  logs: any[] = [];
  os: any[] = [];
  storage: any[] = [];
  throwOn: string | null = null;

  setContext(deviceId: string, sessionId: string | null): void {
    this.contexts.push({ deviceId, sessionId });
  }
  async recordNetworkEvent(input: any): Promise<number> {
    if (this.throwOn === "network") {
      throw new Error("boom");
    }
    this.network.push(input);
    return 1;
  }
  async recordLogEvent(input: any): Promise<void> {
    this.logs.push(input);
  }
  async recordOsEvent(input: any): Promise<void> {
    this.os.push(input);
  }
  async recordStorageEvent(input: any): Promise<void> {
    this.storage.push(input);
  }
}

class FakeFailureRecorder implements FailureRecorderService {
  crashes: any[] = [];
  anrs: any[] = [];
  nonFatals: any[] = [];
  async recordToolFailure(): Promise<string> {
    return "tool";
  }
  async recordCrash(input: any): Promise<string> {
    this.crashes.push(input);
    return "crash-1";
  }
  async recordAnr(input: any): Promise<string> {
    this.anrs.push(input);
    return "anr-1";
  }
  async recordNonFatal(input: any): Promise<string> {
    this.nonFatals.push(input);
    return "nf-1";
  }
}

const STACK: StackTraceElement[] = [
  {
    className: "com.x.Foo",
    methodName: "bar",
    fileName: "Foo.kt",
    lineNumber: 12,
    isAppCode: true,
  },
];

function makeIngestor(overrides?: {
  telemetry?: FakeTelemetryRecorder;
  failure?: FakeFailureRecorder;
  currentScreen?: string | null;
  parse?: (s: string, p: string) => StackTraceElement[];
}) {
  const telemetry = overrides?.telemetry ?? new FakeTelemetryRecorder();
  const failure = overrides?.failure ?? new FakeFailureRecorder();
  const ingestor = new DefaultAndroidSdkEventIngestor({
    deviceId: "emulator-5554",
    getNavigationScreenSource: () => ({
      getCurrentScreen: () => overrides?.currentScreen ?? null,
    }),
    parseStackTrace: overrides?.parse ?? (() => STACK),
    now: () => 1000,
    telemetryRecorder: telemetry,
    failureRecorder: failure,
  });
  return { ingestor, telemetry, failure };
}

const deviceInfo = { model: "Pixel", manufacturer: "Google", osVersion: "14", sdkInt: 34 };

describe("AndroidSdkEventIngestor.recordSdkEvent", () => {
  let telemetry: FakeTelemetryRecorder;
  let ingestor: DefaultAndroidSdkEventIngestor;

  beforeEach(() => {
    const made = makeIngestor();
    telemetry = made.telemetry;
    ingestor = made.ingestor;
  });

  it("sets device context before recording", async () => {
    await ingestor.recordSdkEvent(
      {
        type: "log_event",
        timestamp: 5,
        payload: { event: { applicationId: "com.x", message: "hi" } },
      },
      "com.x",
    );
    expect(telemetry.contexts[0]).toEqual({ deviceId: "emulator-5554", sessionId: null });
  });

  it("routes network_event with wire defaults", async () => {
    await ingestor.recordSdkEvent(
      {
        type: "network_event",
        timestamp: 5,
        payload: { event: { url: "http://x", method: "GET" } },
      },
      null,
    );
    expect(telemetry.network).toHaveLength(1);
    expect(telemetry.network[0]).toMatchObject({
      timestamp: 5,
      url: "http://x",
      method: "GET",
      statusCode: 0,
      requestBodySize: -1,
      responseBodySize: -1,
      applicationId: null,
    });
  });

  it("routes websocket_frame_event to an os event", async () => {
    await ingestor.recordSdkEvent(
      {
        type: "websocket_frame_event",
        timestamp: 7,
        payload: { event: { frameType: "text", payloadSize: 3 } },
      },
      null,
    );
    expect(telemetry.os[0]).toMatchObject({
      category: "websocket_frame",
      kind: "text",
      details: { payloadSize: "3", connectionId: "", url: "", direction: "" },
    });
  });

  it("routes broadcast_event and lifecycle_event to os events", async () => {
    await ingestor.recordSdkEvent(
      { type: "broadcast_event", timestamp: 1, payload: { event: { action: "BOOT" } } },
      null,
    );
    await ingestor.recordSdkEvent(
      { type: "lifecycle_event", timestamp: 2, payload: { event: { kind: "resumed" } } },
      null,
    );
    expect(telemetry.os.map((e) => e.category)).toEqual(["broadcast", "lifecycle"]);
    expect(telemetry.os[0].kind).toBe("BOOT");
    expect(telemetry.os[1].kind).toBe("resumed");
  });

  it("merges custom_event into a log event with serialized properties", async () => {
    await ingestor.recordSdkEvent(
      {
        type: "custom_event",
        timestamp: 9,
        payload: { event: { name: "checkout", properties: { step: "1" } } },
      },
      "com.x",
    );
    expect(telemetry.logs[0]).toMatchObject({ tag: "CustomEvent", filterName: "custom", level: 4 });
    expect(telemetry.logs[0].message).toBe(`checkout ${JSON.stringify({ step: "1" })}`);
  });

  it("never throws when the recorder fails", async () => {
    const t = new FakeTelemetryRecorder();
    t.throwOn = "network";
    const { ingestor: ing } = makeIngestor({ telemetry: t });
    await expect(
      ing.recordSdkEvent({ type: "network_event", timestamp: 1, payload: { event: {} } }, null),
    ).resolves.toBeUndefined();
  });

  it("ignores unknown event types without recording", async () => {
    await ingestor.recordSdkEvent({ type: "mystery", timestamp: 1, payload: { event: {} } }, null);
    expect(telemetry.network).toHaveLength(0);
    expect(telemetry.logs).toHaveLength(0);
    expect(telemetry.os).toHaveLength(0);
  });
});

describe("AndroidSdkEventIngestor.recordStorageEvent", () => {
  it("sets context and forwards the prebuilt input", () => {
    const { ingestor, telemetry } = makeIngestor();
    ingestor.recordStorageEvent({
      timestamp: 5,
      applicationId: "com.x",
      fileName: "prefs",
      key: "k",
      value: "v",
      valueType: "STRING",
      changeType: "modify",
    });
    expect(telemetry.contexts[0].deviceId).toBe("emulator-5554");
    expect(telemetry.storage[0]).toMatchObject({ fileName: "prefs", key: "k" });
  });
});

describe("AndroidSdkEventIngestor failure analytics", () => {
  const handled: AndroidHandledExceptionEvent = {
    timestamp: 1,
    exceptionClass: "NPE",
    stackTrace: "at x",
    packageName: "com.x",
    deviceInfo,
  };
  const crash: SdkCrashPayload = {
    timestamp: 1,
    exceptionClass: "RTE",
    stackTrace: "at x",
    threadName: "main",
    packageName: "com.x",
    deviceInfo,
  };
  const anr: SdkAnrPayload = {
    timestamp: 1,
    pid: 9,
    processName: "com.x",
    importance: "fg",
    reason: "input",
    packageName: "com.x",
    deviceInfo,
  };

  it("records a handled exception with parsed stack and default message", async () => {
    const { ingestor, failure } = makeIngestor();
    await ingestor.recordHandledException(handled);
    expect(failure.nonFatals[0]).toMatchObject({
      exceptionType: "NPE",
      exceptionMessage: "Handled exception",
      stackTrace: STACK,
      sessionId: "handled-com.x-1000",
      deviceModel: "Pixel",
      os: "Android 14 (API 34)",
    });
  });

  it("prefers the event currentScreen over the nav graph", async () => {
    const { ingestor, failure } = makeIngestor({ currentScreen: "NavScreen" });
    await ingestor.recordHandledException({ ...handled, currentScreen: "EventScreen" });
    expect(failure.nonFatals[0].currentScreen).toBe("EventScreen");
  });

  it("falls back to the nav graph screen when the event omits it", async () => {
    const { ingestor, failure } = makeIngestor({ currentScreen: "NavScreen" });
    await ingestor.recordHandledException(handled);
    expect(failure.nonFatals[0].currentScreen).toBe("NavScreen");
  });

  it("records crash analytics", async () => {
    const { ingestor, failure } = makeIngestor();
    await ingestor.recordCrashAnalytics(crash);
    expect(failure.crashes[0]).toMatchObject({
      exceptionType: "RTE",
      threadName: "main",
      sessionId: "crash-com.x-1000",
      exceptionMessage: "Application crashed",
    });
  });

  it("records ANR analytics, omitting an empty stack", async () => {
    const { ingestor, failure } = makeIngestor({ parse: () => [] });
    await ingestor.recordAnrAnalytics(anr, "com.x");
    expect(failure.anrs[0]).toMatchObject({ reason: "input", sessionId: "anr-com.x-1000" });
    expect(failure.anrs[0].stackTrace).toBeUndefined();
  });

  it("swallows failure-recorder errors", async () => {
    const failure = new FakeFailureRecorder();
    failure.recordCrash = async () => {
      throw new Error("db down");
    };
    const { ingestor } = makeIngestor({ failure });
    await expect(ingestor.recordCrashAnalytics(crash)).resolves.toBeUndefined();
  });
});
