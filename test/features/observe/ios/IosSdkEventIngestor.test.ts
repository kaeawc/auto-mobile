import { beforeEach, describe, expect, test } from "bun:test";
import {
  DefaultIosSdkEventIngestor,
  type IosTelemetryRecorder,
  type NavigationEventSink,
} from "../../../../src/features/observe/ios/IosSdkEventIngestor";
import type { SdkEvent } from "../../../../src/features/observe/interfaces/SdkEventIngestor";
import type { CtrlProxyScreenshotResult } from "../../../../src/features/observe/ios/types";
import type { ViewHierarchyResult } from "../../../../src/models";
import type { NavigationEvent } from "../../../../src/utils/interfaces/NavigationGraph";
import { FakeFailureRecorder } from "../../../fakes/FakeFailureRecorder";

const DEVICE_ID = "A1B2C3D4-E5F6-7890-ABCD-EF1234567890";

interface CapturedCall {
  event: Record<string, unknown>;
  contextAtCall: { deviceId: string | null; sessionId: string | null };
}

/**
 * Capturing telemetry recorder double. Records each call together with the
 * device context active at call-time so tests can assert context save/restore.
 */
class CapturingTelemetryRecorder {
  context: { deviceId: string | null; sessionId: string | null } = { deviceId: "prev-device", sessionId: "prev-session" };
  network: CapturedCall[] = [];
  logs: CapturedCall[] = [];
  os: CapturedCall[] = [];
  navigation: CapturedCall[] = [];
  storage: CapturedCall[] = [];
  layout: CapturedCall[] = [];

  getContext(): { deviceId: string | null; sessionId: string | null } {
    return this.context;
  }

  setContext(deviceId: string | null, sessionId: string | null): void {
    this.context = { deviceId, sessionId };
  }

  private capture(bucket: CapturedCall[], event: Record<string, unknown>): void {
    bucket.push({ event, contextAtCall: { ...this.context } });
  }

  async recordNetworkEvent(event: Record<string, unknown>): Promise<void> { this.capture(this.network, event); }
  async recordLogEvent(event: Record<string, unknown>): Promise<void> { this.capture(this.logs, event); }
  async recordOsEvent(event: Record<string, unknown>): Promise<void> { this.capture(this.os, event); }
  async recordNavigationEvent(event: Record<string, unknown>): Promise<void> { this.capture(this.navigation, event); }
  async recordStorageEvent(event: Record<string, unknown>): Promise<void> { this.capture(this.storage, event); }
  async recordLayoutEvent(event: Record<string, unknown>): Promise<void> { this.capture(this.layout, event); }
}

class CapturingNavigationSink implements NavigationEventSink {
  recorded: Array<Record<string, unknown>> = [];
  screenshotUpdates: Array<{ appId: string; screenName: string; path: string | null }> = [];

  async recordNavigationEvent(event: NavigationEvent): Promise<void> {
    this.recorded.push(event as unknown as Record<string, unknown>);
  }

  async updateNodeScreenshot(appId: string, screenName: string, screenshotPath: string | null): Promise<void> {
    this.screenshotUpdates.push({ appId, screenName, path: screenshotPath });
  }
}

describe("DefaultIosSdkEventIngestor", () => {
  let recorder: CapturingTelemetryRecorder;
  let failureRecorder: FakeFailureRecorder;
  let navSink: CapturingNavigationSink;
  let ingestor: DefaultIosSdkEventIngestor;

  const buildIngestor = (overrides: { navigationScreenshotsEnabled?: () => boolean } = {}): DefaultIosSdkEventIngestor =>
    new DefaultIosSdkEventIngestor({
      deviceId: DEVICE_ID,
      getNavigationGraphManager: () => navSink,
      captureScreenshot: async (): Promise<CtrlProxyScreenshotResult> => ({ success: false }),
      telemetryRecorder: recorder as unknown as IosTelemetryRecorder,
      failureRecorder,
      navigationScreenshotsEnabled: overrides.navigationScreenshotsEnabled ?? (() => false),
    });

  const event = (type: string, payload: Record<string, unknown>, timestamp = 1000): SdkEvent => ({ type, timestamp, payload });

  beforeEach(() => {
    recorder = new CapturingTelemetryRecorder();
    failureRecorder = new FakeFailureRecorder();
    navSink = new CapturingNavigationSink();
    ingestor = buildIngestor();
  });

  test("network_request routes to recordNetworkEvent with mapped fields", async () => {
    await ingestor.recordSdkEvent(event("network_request", {
      url: "https://x.test/a", method: "POST", statusCode: 201, durationMs: 15,
    }), "com.app");
    expect(recorder.network).toHaveLength(1);
    expect(recorder.network[0].event).toMatchObject({
      applicationId: "com.app",
      url: "https://x.test/a",
      method: "POST",
      statusCode: 201,
      durationMs: 15,
      timestamp: 1000,
    });
  });

  test("network_request defaults missing fields", async () => {
    await ingestor.recordSdkEvent(event("network_request", {}), null);
    expect(recorder.network[0].event).toMatchObject({
      url: "", method: "GET", statusCode: 0, durationMs: 0,
      requestBodySize: -1, responseBodySize: -1,
    });
  });

  test("sets device context during ingestion and restores it afterward", async () => {
    await ingestor.recordSdkEvent(event("network_request", { url: "u" }), "com.app");
    // Context active during the recorder call is the iOS device, sessionId null.
    expect(recorder.network[0].contextAtCall).toEqual({ deviceId: DEVICE_ID, sessionId: null });
    // Context restored to the previous values after ingestion.
    expect(recorder.getContext()).toEqual({ deviceId: "prev-device", sessionId: "prev-session" });
  });

  test("log routes to recordLogEvent", async () => {
    await ingestor.recordSdkEvent(event("log", { level: 3, tag: "T", message: "hello", filterName: "f" }), "com.app");
    expect(recorder.logs[0].event).toMatchObject({ level: 3, tag: "T", message: "hello", filterName: "f", applicationId: "com.app" });
  });

  test("lifecycle routes to recordOsEvent", async () => {
    await ingestor.recordSdkEvent(event("lifecycle", { state: "foreground", bundleId: "com.app" }), "com.app");
    expect(recorder.os[0].event).toMatchObject({ category: "lifecycle", kind: "foreground" });
  });

  test("hang routes to recordOsEvent with duration kind", async () => {
    await ingestor.recordSdkEvent(event("hang", { durationMs: 250 }), "com.app");
    expect(recorder.os[0].event).toMatchObject({ category: "hang", kind: "250ms" });
  });

  test("custom is merged into a log event", async () => {
    await ingestor.recordSdkEvent(event("custom", { name: "purchase", properties: { sku: "x" } }), "com.app");
    expect(recorder.logs[0].event).toMatchObject({ tag: "CustomEvent", filterName: "custom" });
    expect((recorder.logs[0].event as { message: string }).message).toContain("purchase");
    expect((recorder.logs[0].event as { message: string }).message).toContain("sku");
  });

  test("storage_changed routes to recordStorageEvent (fileName from suiteName)", async () => {
    await ingestor.recordSdkEvent(event("storage_changed", {
      suiteName: "defaults", key: "k", value: "v", operation: "write",
    }), "com.app");
    expect(recorder.storage[0].event).toMatchObject({ fileName: "defaults", key: "k", value: "v" });
  });

  test("unknown event types fall back to a log event", async () => {
    await ingestor.recordSdkEvent(event("totally_new_type", { foo: "bar" }), "com.app");
    expect(recorder.logs[0].event).toMatchObject({ tag: "UnknownEvent", filterName: "custom" });
    expect((recorder.logs[0].event as { message: string }).message).toContain("totally_new_type");
  });

  test("navigation records to the nav graph and to telemetry", async () => {
    await ingestor.recordSdkEvent(event("navigation", {
      destination: "Home", source: "Login", arguments: { a: "1" }, metadata: { m: "2" },
    }), "com.app");
    expect(navSink.recorded).toHaveLength(1);
    expect(navSink.recorded[0]).toMatchObject({ applicationId: "com.app", destination: "Home", source: "Login" });
    expect(recorder.navigation[0].event).toMatchObject({ destination: "Home", source: "Login", applicationId: "com.app" });
  });

  test("navigation without applicationId still records telemetry but not the nav graph", async () => {
    await ingestor.recordSdkEvent(event("navigation", { destination: "Home" }), null);
    expect(navSink.recorded).toHaveLength(0);
    expect(recorder.navigation).toHaveLength(1);
  });

  test("navigation with screenshots enabled but no screenshot data records telemetry without a screenshotUri", async () => {
    // Exercises the navigationScreenshotsEnabled() branch: capture returns no data, so
    // updateNodeScreenshot is skipped and the nav event still records with screenshotUri null.
    const withScreenshots = buildIngestor({ navigationScreenshotsEnabled: () => true });
    await withScreenshots.recordSdkEvent(event("navigation", { destination: "Home" }), "com.app");
    expect(navSink.recorded).toHaveLength(1);
    expect(navSink.screenshotUpdates).toHaveLength(0);
    expect(recorder.navigation).toHaveLength(1);
    expect((recorder.navigation[0].event as { screenshotUri: string | null }).screenshotUri).toBeNull();
  });

  test("handled_exception routes to failure recorder as non-fatal", async () => {
    await ingestor.recordSdkEvent(event("handled_exception", {
      exceptionClass: "NSError", exceptionMessage: "bad", stackTrace: "frame1\nframe2",
    }), "com.app");
    const nonFatals = failureRecorder.getRecordedFailures().filter(f => f.type === "nonfatal");
    expect(nonFatals).toHaveLength(1);
    const nonFatal = nonFatals[0].input as {
      exceptionType: string;
      stackTrace: Array<{ methodName: string; isAppCode: boolean }>;
    };
    expect(nonFatal.exceptionType).toBe("NSError");
    // Stack string is split per newline into frames; app-code detection keys on applicationId.
    expect(nonFatal.stackTrace.map(f => f.methodName)).toEqual(["frame1", "frame2"]);
  });

  test("crash routes to failure recorder as crash", async () => {
    await ingestor.recordSdkEvent(event("crash", {
      exceptionClass: "SIGABRT", exceptionMessage: "crashed", stackTrace: "a\nb",
    }), "com.app");
    const crashes = failureRecorder.getRecordedFailures().filter(f => f.type === "crash");
    expect(crashes).toHaveLength(1);
    expect((crashes[0].input as { exceptionType: string }).exceptionType).toBe("SIGABRT");
  });

  test("ingestion never throws even when a recorder rejects", async () => {
    const throwingRecorder = {
      getContext: () => ({ deviceId: null, sessionId: null }),
      setContext: () => {},
      recordLogEvent: async () => { throw new Error("db down"); },
    } as unknown as IosTelemetryRecorder;
    const resilient = new DefaultIosSdkEventIngestor({
      deviceId: DEVICE_ID,
      getNavigationGraphManager: () => navSink,
      captureScreenshot: async () => ({ success: false }),
      telemetryRecorder: throwingRecorder,
      failureRecorder,
      navigationScreenshotsEnabled: () => false,
    });
    await expect(resilient.recordSdkEvent(event("log", {}), null)).resolves.toBeUndefined();
  });

  describe("recordLayoutTelemetryEvent", () => {
    const hierarchy = (): ViewHierarchyResult => ({
      hierarchy: { node: [{ $: { text: "a" } }, { $: { text: "b" } }] },
      packageName: "com.app",
      windows: [],
      updatedAt: 123,
    } as unknown as ViewHierarchyResult);

    test("records a hierarchy_change layout event with a node count", () => {
      ingestor.recordLayoutTelemetryEvent(hierarchy());
      expect(recorder.layout).toHaveLength(1);
      expect(recorder.layout[0].event).toMatchObject({
        subType: "hierarchy_change",
        applicationId: "com.app",
        screenName: "com.app",
      });
      expect((recorder.layout[0].event as { recompositionCount: number }).recompositionCount).toBeGreaterThan(0);
    });

    test("uses device context and restores it", () => {
      ingestor.recordLayoutTelemetryEvent(hierarchy());
      expect(recorder.layout[0].contextAtCall).toEqual({ deviceId: DEVICE_ID, sessionId: null });
      expect(recorder.getContext()).toEqual({ deviceId: "prev-device", sessionId: "prev-session" });
    });
  });
});
