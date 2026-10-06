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

describe("AndroidSdkEventIngestor event inputs", () => {
  it("preserves every supplied network field and sets context first", async () => {
    const { ingestor, telemetry } = makeIngestor();
    const event = {
      applicationId: "com.x",
      url: "https://x/path",
      method: "POST",
      statusCode: 201,
      durationMs: 8,
      requestBodySize: 2,
      responseBodySize: 3,
      protocol: "h2",
      host: "x",
      path: "/path",
      error: "err",
      requestHeaders: { request: "header" },
      responseHeaders: { response: "header" },
      requestBody: "in",
      responseBody: "out",
      contentType: "text/plain",
    };
    const order: string[] = [];
    const setContext = telemetry.setContext.bind(telemetry);
    telemetry.setContext = (deviceId, sessionId) => {
      order.push("context");
      setContext(deviceId, sessionId);
    };
    const record = telemetry.recordNetworkEvent.bind(telemetry);
    telemetry.recordNetworkEvent = async (input) => {
      order.push("record");
      return record(input);
    };
    await ingestor.recordSdkEvent(
      { type: "network_event", timestamp: 42, payload: { event } },
      "ignored",
    );
    expect(telemetry.network).toEqual([{ timestamp: 42, ...event }]);
    expect(order).toEqual(["context", "record"]);
  });

  for (const absent of [undefined, null]) {
    it(`defaults all missing network fields supplied as ${String(absent)}`, async () => {
      const { ingestor, telemetry } = makeIngestor();
      const event = Object.fromEntries(
        [
          "applicationId",
          "statusCode",
          "durationMs",
          "requestBodySize",
          "responseBodySize",
          "protocol",
          "host",
          "path",
          "error",
          "requestHeaders",
          "responseHeaders",
          "requestBody",
          "responseBody",
          "contentType",
        ].map((key) => [key, absent]),
      );
      await ingestor.recordSdkEvent(
        { type: "network_event", timestamp: 0, payload: { event } },
        "ignored",
      );
      expect(telemetry.network).toEqual([
        {
          timestamp: 0,
          applicationId: null,
          url: undefined,
          method: undefined,
          statusCode: 0,
          durationMs: 0,
          requestBodySize: -1,
          responseBodySize: -1,
          protocol: null,
          host: null,
          path: null,
          error: null,
          requestHeaders: null,
          responseHeaders: null,
          requestBody: null,
          responseBody: null,
          contentType: null,
        },
      ]);
    });
  }

  for (const [type, event, expected] of [
    [
      "websocket_frame_event",
      {},
      {
        timestamp: 0,
        applicationId: null,
        category: "websocket_frame",
        kind: "unknown",
        details: { connectionId: "", url: "", direction: "", payloadSize: "0", success: "true" },
      },
    ],
    [
      "websocket_frame_event",
      {
        applicationId: "com.x",
        frameType: "binary",
        connectionId: "id",
        url: "wss://x",
        direction: "out",
        payloadSize: 0,
        success: false,
      },
      {
        timestamp: 0,
        applicationId: "com.x",
        category: "websocket_frame",
        kind: "binary",
        details: {
          connectionId: "id",
          url: "wss://x",
          direction: "out",
          payloadSize: "0",
          success: "false",
        },
      },
    ],
    [
      "broadcast_event",
      {},
      { timestamp: 0, applicationId: null, category: "broadcast", kind: "unknown", details: null },
    ],
    [
      "broadcast_event",
      { applicationId: "com.x", action: "", extraKeys: {} },
      { timestamp: 0, applicationId: "com.x", category: "broadcast", kind: "", details: {} },
    ],
    [
      "lifecycle_event",
      {},
      { timestamp: 0, applicationId: null, category: "lifecycle", kind: "unknown", details: null },
    ],
    [
      "lifecycle_event",
      { applicationId: "com.x", kind: "resumed", details: { key: "value" } },
      {
        timestamp: 0,
        applicationId: "com.x",
        category: "lifecycle",
        kind: "resumed",
        details: { key: "value" },
      },
    ],
  ] as const) {
    it(`preserves ${type} input ${JSON.stringify(event)}`, async () => {
      const { ingestor, telemetry } = makeIngestor();
      await ingestor.recordSdkEvent({ type, timestamp: 0, payload: { event } }, "ignored");
      expect(telemetry.os).toEqual([expected]);
    });
  }

  for (const [type, event, expected] of [
    [
      "log_event",
      {},
      { timestamp: 0, applicationId: null, level: 0, tag: "", message: "", filterName: "" },
    ],
    [
      "log_event",
      { applicationId: "com.x", level: 0, tag: "tag", message: "msg", filterName: "filter" },
      {
        timestamp: 0,
        applicationId: "com.x",
        level: 0,
        tag: "tag",
        message: "msg",
        filterName: "filter",
      },
    ],
    [
      "custom_event",
      {},
      {
        timestamp: 0,
        applicationId: null,
        level: 4,
        tag: "CustomEvent",
        message: "",
        filterName: "custom",
      },
    ],
    [
      "custom_event",
      { name: "event", properties: {} },
      {
        timestamp: 0,
        applicationId: null,
        level: 4,
        tag: "CustomEvent",
        message: "event",
        filterName: "custom",
      },
    ],
    [
      "custom_event",
      { applicationId: "com.x", name: "event", properties: { zero: 0 } },
      {
        timestamp: 0,
        applicationId: "com.x",
        level: 4,
        tag: "CustomEvent",
        message: 'event {"zero":0}',
        filterName: "custom",
      },
    ],
  ] as const) {
    it(`preserves ${type} input ${JSON.stringify(event)}`, async () => {
      const { ingestor, telemetry } = makeIngestor();
      await ingestor.recordSdkEvent({ type, timestamp: 0, payload: { event } }, "ignored");
      expect(telemetry.logs).toEqual([expected]);
    });
  }

  it("does not read the event if setting context fails", async () => {
    const { ingestor, telemetry } = makeIngestor();
    telemetry.setContext = () => {
      throw new Error("context failed");
    };
    let reads = 0;
    await expect(
      ingestor.recordSdkEvent(
        {
          type: "network_event",
          timestamp: 0,
          payload: {
            get event() {
              reads++;
              return {};
            },
          },
        },
        null,
      ),
    ).resolves.toBeUndefined();
    expect(reads).toBe(0);
    expect(telemetry.network).toEqual([]);
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

  it("records the message the device frame carries under `message` (#10068)", async () => {
    // The event object of WebSocketResponseTest.kt's handled_exception_event encoding.
    const frame: { event: AndroidHandledExceptionEvent } = JSON.parse(
      '{"type":"handled_exception_event","timestamp":1700000001000,"event":{"exceptionClass":"java.lang.IllegalStateException","message":"cart is empty","stackTrace":"at com.example.Main.run(Main.java:42)","customMessage":null,"currentScreen":null,"packageName":"com.example.app","appVersion":null,"deviceInfo":{"model":"Pixel 7","manufacturer":"Google","osVersion":"14","sdkInt":34},"applicationId":null}}',
    );
    const { ingestor, failure } = makeIngestor();
    await ingestor.recordHandledException(frame.event);
    expect(failure.nonFatals[0].exceptionMessage).toBe("cart is empty");
  });

  it("still reads the legacy exceptionMessage name when `message` is absent", async () => {
    const { ingestor, failure } = makeIngestor();
    await ingestor.recordHandledException({ ...handled, exceptionMessage: "legacy" });
    expect(failure.nonFatals[0].exceptionMessage).toBe("legacy");
  });

  it("uses the placeholder when the device sent a null message", async () => {
    const { ingestor, failure } = makeIngestor();
    await ingestor.recordHandledException({ ...handled, message: null });
    expect(failure.nonFatals[0].exceptionMessage).toBe("Handled exception");
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
