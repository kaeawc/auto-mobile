import { beforeEach, describe, expect, spyOn, test } from "bun:test";
import { getDbWriteBarrier, resetDbWriteBarrier } from "../../../../src/db/dbWriteBarrier";
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
import { NavigationScreenshotManager } from "../../../../src/features/navigation/NavigationScreenshotManager";
import { withInMemorySingletonDatabase } from "../../../db/inMemorySingletonDatabase";
import { getDatabase } from "../../../../src/db/database";
import { runMigrations } from "../../../../src/db/migrator";
import type { Database } from "../../../../src/db/types";
import type { Kysely } from "kysely";

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
  context: { deviceId: string | null; sessionId: string | null } = {
    deviceId: "prev-device",
    sessionId: "prev-session",
  };
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

  async recordNetworkEvent(event: Record<string, unknown>): Promise<void> {
    this.capture(this.network, event);
  }
  async recordLogEvent(event: Record<string, unknown>): Promise<void> {
    this.capture(this.logs, event);
  }
  async recordOsEvent(event: Record<string, unknown>): Promise<void> {
    this.capture(this.os, event);
  }
  async recordNavigationEvent(event: Record<string, unknown>): Promise<void> {
    this.capture(this.navigation, event);
  }
  async recordStorageEvent(event: Record<string, unknown>): Promise<void> {
    this.capture(this.storage, event);
  }
  async recordLayoutEvent(event: Record<string, unknown>): Promise<void> {
    this.capture(this.layout, event);
  }
}

class CapturingNavigationSink implements NavigationEventSink {
  recorded: Array<Record<string, unknown>> = [];
  screenshotUpdates: Array<{ appId: string; screenName: string; path: string | null }> = [];

  async recordNavigationEvent(event: NavigationEvent): Promise<void> {
    this.recorded.push(event as unknown as Record<string, unknown>);
  }

  async updateNodeScreenshot(
    appId: string,
    screenName: string,
    screenshotPath: string | null,
  ): Promise<void> {
    this.screenshotUpdates.push({ appId, screenName, path: screenshotPath });
  }
}

describe("DefaultIosSdkEventIngestor", () => {
  let recorder: CapturingTelemetryRecorder;
  let failureRecorder: FakeFailureRecorder;
  let navSink: CapturingNavigationSink;
  let ingestor: DefaultIosSdkEventIngestor;

  const buildIngestor = (
    overrides: { navigationScreenshotsEnabled?: () => boolean } = {},
  ): DefaultIosSdkEventIngestor =>
    new DefaultIosSdkEventIngestor({
      deviceId: DEVICE_ID,
      getNavigationGraphManager: () => navSink,
      captureScreenshot: async (): Promise<CtrlProxyScreenshotResult> => ({ success: false }),
      telemetryRecorder: recorder as unknown as IosTelemetryRecorder,
      failureRecorder,
      navigationScreenshotsEnabled: overrides.navigationScreenshotsEnabled ?? (() => false),
    });

  const event = (type: string, payload: Record<string, unknown>, timestamp = 1000): SdkEvent => ({
    type,
    timestamp,
    payload,
  });

  beforeEach(() => {
    recorder = new CapturingTelemetryRecorder();
    failureRecorder = new FakeFailureRecorder();
    navSink = new CapturingNavigationSink();
    ingestor = buildIngestor();
  });

  test("network_request routes to recordNetworkEvent with mapped fields", async () => {
    await ingestor.recordSdkEvent(
      event("network_request", {
        url: "https://x.test/a",
        method: "POST",
        statusCode: 201,
        durationMs: 15,
      }),
      "com.app",
    );
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
      url: "",
      method: "GET",
      statusCode: 0,
      durationMs: 0,
      requestBodySize: -1,
      responseBodySize: -1,
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
    await ingestor.recordSdkEvent(
      event("log", { level: 3, tag: "T", message: "hello", filterName: "f" }),
      "com.app",
    );
    expect(recorder.logs[0].event).toMatchObject({
      level: 3,
      tag: "T",
      message: "hello",
      filterName: "f",
      applicationId: "com.app",
    });
  });

  test("lifecycle routes to recordOsEvent", async () => {
    await ingestor.recordSdkEvent(
      event("lifecycle", { state: "foreground", bundleId: "com.app" }),
      "com.app",
    );
    expect(recorder.os[0].event).toMatchObject({ category: "lifecycle", kind: "foreground" });
  });

  test("hang routes to recordOsEvent with duration kind", async () => {
    await ingestor.recordSdkEvent(event("hang", { durationMs: 250 }), "com.app");
    expect(recorder.os[0].event).toMatchObject({ category: "hang", kind: "250ms" });
  });

  test("custom is merged into a log event", async () => {
    await ingestor.recordSdkEvent(
      event("custom", { name: "purchase", properties: { sku: "x" } }),
      "com.app",
    );
    expect(recorder.logs[0].event).toMatchObject({ tag: "CustomEvent", filterName: "custom" });
    expect((recorder.logs[0].event as { message: string }).message).toContain("purchase");
    expect((recorder.logs[0].event as { message: string }).message).toContain("sku");
  });

  test("storage_changed maps the real iOS SDK wire shape to the recorder contract", async () => {
    // The iOS SDK emits SdkStorageChangedEvent → JSON keys suiteName/key/newValue/valueType/
    // sequenceNumber (see ios/auto-mobile-sdk/.../SdkEvent.swift). It carries no `operation`
    // and no `value` field. The recorder REQUIRES valueType + changeType (issue #3001).
    await ingestor.recordSdkEvent(
      event("storage_changed", {
        suiteName: "defaults",
        key: "k",
        newValue: "v",
        valueType: "string",
        sequenceNumber: 7,
      }),
      "com.app",
    );
    const stored = recorder.storage[0].event;
    expect(stored).toMatchObject({
      applicationId: "com.app",
      fileName: "defaults",
      key: "k",
      value: "v",
      valueType: "string",
      changeType: "modify",
      timestamp: 1000,
    });
    // Required-by-contract fields must be present (not undefined/NULL on the wire).
    expect(stored.valueType).toBe("string");
    expect(stored.changeType).toBe("modify");
    // The undeclared `operation` field must not leak into the recorder input.
    expect("operation" in stored).toBe(false);
  });

  test("storage_changed sources value from newValue, not a `value` field", async () => {
    // Regression guard: the old call site read p.value (which the wire never sends),
    // so the recorded value was always dropped. It must read newValue.
    await ingestor.recordSdkEvent(
      event("storage_changed", {
        suiteName: "s",
        key: "k",
        newValue: "the-real-value",
        valueType: "string",
        sequenceNumber: 1,
      }),
      "com.app",
    );
    expect(recorder.storage[0].event.value).toBe("the-real-value");
  });

  test("storage_changed defaults valueType/value/changeType when the wire omits them", async () => {
    // KVO-driven emissions carry newValue: null and valueType: "unknown"; a fully-sparse
    // payload must still satisfy the required recorder fields with safe defaults.
    await ingestor.recordSdkEvent(event("storage_changed", { suiteName: "s", key: "k" }), null);
    const stored = recorder.storage[0].event;
    expect(stored).toMatchObject({
      fileName: "s",
      key: "k",
      value: null,
      valueType: null,
      changeType: "modify",
    });
  });

  test("storage_changed passes the wire valueType through unchanged (real KVO shape)", async () => {
    // The KVO emit path sends valueType: "unknown" with newValue: null; that literal must
    // reach the recorder untouched (the ?? null fallback only applies when it is absent).
    await ingestor.recordSdkEvent(
      event("storage_changed", {
        suiteName: "s",
        key: "k",
        newValue: null,
        valueType: "unknown",
        sequenceNumber: 3,
      }),
      "com.app",
    );
    const stored = recorder.storage[0].event;
    expect(stored.valueType).toBe("unknown");
    expect(stored.value).toBeNull();
    expect(stored.changeType).toBe("modify");
  });

  test("storage_changed honors an explicit operation as the changeType (forward-compat)", async () => {
    // If a future SDK build adds an `operation` discriminator, map it to changeType.
    await ingestor.recordSdkEvent(
      event("storage_changed", {
        suiteName: "s",
        key: "k",
        newValue: null,
        valueType: "unknown",
        operation: "delete",
      }),
      "com.app",
    );
    expect(recorder.storage[0].event.changeType).toBe("delete");
  });

  test("storage_changed threads a runner-supplied previousValue through (#3000)", async () => {
    await ingestor.recordSdkEvent(
      event("storage_changed", {
        suiteName: "defaults",
        key: "k",
        value: "new",
        previousValue: "old",
        operation: "write",
      }),
      "com.app",
    );
    expect(recorder.storage[0].event).toMatchObject({
      key: "k",
      value: "new",
      previousValue: "old",
    });
  });

  test("storage_changed threads an explicit previousValue: null through (#3000)", async () => {
    await ingestor.recordSdkEvent(
      event("storage_changed", {
        suiteName: "defaults",
        key: "k",
        value: "new",
        previousValue: null,
        operation: "write",
      }),
      "com.app",
    );
    // Explicit null asserts "no prior value" — must be preserved verbatim, not dropped.
    expect(recorder.storage[0].event).toHaveProperty("previousValue", null);
  });

  test("storage_changed omits previousValue when the runner does not emit it (auto-lookup preserved)", async () => {
    await ingestor.recordSdkEvent(
      event("storage_changed", {
        suiteName: "defaults",
        key: "k",
        value: "new",
        operation: "write",
      }),
      "com.app",
    );
    // Field must be absent (undefined) so the repository's `!== undefined` guard
    // falls through to the auto-lookup for legacy runners.
    expect(recorder.storage[0].event.previousValue).toBeUndefined();
    expect(Object.prototype.hasOwnProperty.call(recorder.storage[0].event, "previousValue")).toBe(
      false,
    );
  });

  test("storage_changed reads the SDK-diffed changeType (add) from the payload", async () => {
    // The snapshot-diff SDK build emits a real add/modify/remove changeType; it
    // must be read directly (not defaulted to "modify").
    await ingestor.recordSdkEvent(
      event("storage_changed", {
        suiteName: "defaults",
        key: "k",
        newValue: "v",
        valueType: "string",
        changeType: "add",
      }),
      "com.app",
    );
    expect(recorder.storage[0].event).toMatchObject({
      fileName: "defaults",
      key: "k",
      value: "v",
      valueType: "string",
      changeType: "add",
    });
  });

  test("storage_changed forces previousValue: null for adds (defeats the repo auto-lookup)", async () => {
    // An "add" has no prior value by definition. Swift's Encodable omits the nil
    // previousValue, so the ingestor must assert null explicitly — otherwise the
    // repository would auto-look-up a stale earlier row for the same suite/key.
    await ingestor.recordSdkEvent(
      event("storage_changed", {
        suiteName: "defaults",
        key: "k",
        newValue: "v",
        valueType: "string",
        changeType: "add",
      }),
      "com.app",
    );
    // Present AND null (not undefined), so recordStorageEvent skips its lookup.
    expect(recorder.storage[0].event).toHaveProperty("previousValue", null);
  });

  test("storage_changed does NOT force previousValue for modify (auto-lookup preserved)", async () => {
    // A modify without a runner-supplied previousValue must omit it so the
    // repository's `!== undefined` guard falls through to the auto-lookup (#3000).
    await ingestor.recordSdkEvent(
      event("storage_changed", {
        suiteName: "defaults",
        key: "k",
        newValue: "v2",
        valueType: "string",
        changeType: "modify",
      }),
      "com.app",
    );
    expect(recorder.storage[0].event.previousValue).toBeUndefined();
    expect(Object.prototype.hasOwnProperty.call(recorder.storage[0].event, "previousValue")).toBe(
      false,
    );
  });

  test("storage_changed reads changeType remove, and defaults to modify when the wire omits it", async () => {
    await ingestor.recordSdkEvent(
      event("storage_changed", {
        suiteName: "defaults",
        key: "gone",
        newValue: null,
        valueType: "string",
        changeType: "remove",
      }),
      "com.app",
    );
    expect(recorder.storage[0].event).toMatchObject({
      fileName: "defaults",
      key: "gone",
      value: null,
      valueType: "string",
      changeType: "remove",
    });

    await ingestor.recordSdkEvent(
      event("storage_changed", { suiteName: "defaults", key: "k" }),
      "com.app",
    );
    expect(recorder.storage[1].event).toMatchObject({
      fileName: "defaults",
      key: "k",
      value: null,
      valueType: null,
      changeType: "modify",
    });
  });

  test("unknown event types fall back to a log event", async () => {
    await ingestor.recordSdkEvent(event("totally_new_type", { foo: "bar" }), "com.app");
    expect(recorder.logs[0].event).toMatchObject({ tag: "UnknownEvent", filterName: "custom" });
    expect((recorder.logs[0].event as { message: string }).message).toContain("totally_new_type");
  });

  test("navigation records to the nav graph and to telemetry", async () => {
    await ingestor.recordSdkEvent(
      event("navigation", {
        destination: "Home",
        source: "Login",
        arguments: { a: "1" },
        metadata: { m: "2" },
      }),
      "com.app",
    );
    expect(navSink.recorded).toHaveLength(1);
    expect(navSink.recorded[0]).toMatchObject({
      applicationId: "com.app",
      destination: "Home",
      source: "Login",
    });
    expect(recorder.navigation[0].event).toMatchObject({
      destination: "Home",
      source: "Login",
      applicationId: "com.app",
    });
  });

  test("routes the navigation-graph write through the DB-write barrier for shutdown drain (#3506)", async () => {
    resetDbWriteBarrier();
    const barrier = getDbWriteBarrier();
    const trackExistingSpy = spyOn(barrier, "trackExisting");

    try {
      await ingestor.recordSdkEvent(event("navigation", { destination: "Home" }), "com.app");

      expect(trackExistingSpy).toHaveBeenCalledTimes(1);
    } finally {
      trackExistingSpy.mockRestore();
      resetDbWriteBarrier();
    }
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
    expect(
      (recorder.navigation[0].event as { screenshotUri: string | null }).screenshotUri,
    ).toBeNull();
  });

  /**
   * Regression (#5851, follow-up to #5600/#5534/#4933): when a screenshot is
   * captured and stored, the telemetry event's screenshotUri must be the
   * app-SCOPED resource URI (`?appId=<applicationId>`), built via
   * buildNavigationNodeScreenshotUri(node.id, applicationId). An unscoped URI
   * resolves against the daemon's current foreground app, so a client following
   * it while another app is foregrounded gets the wrong app's screenshot.
   */
  test("navigation screenshot URI is scoped by applicationId (#5851)", async () => {
    await withInMemorySingletonDatabase(async () => {
      const db = getDatabase() as unknown as Kysely<Database>;
      await runMigrations(db as unknown as Kysely<unknown>);

      await db
        .insertInto("navigation_apps")
        .values([{ app_id: "com.other" }, { app_id: "com.app" }])
        .execute();

      // Colliding "Home" node under a different app to make scoping meaningful.
      await db
        .insertInto("navigation_nodes")
        .values({
          app_id: "com.other",
          screen_name: "Home",
          first_seen_at: 1000,
          last_seen_at: 1000,
          visit_count: 1,
          back_stack_depth: null,
          task_id: null,
          screenshot_path: "/screens/com.other/Home.webp",
        })
        .execute();
      const node = await db
        .insertInto("navigation_nodes")
        .values({
          app_id: "com.app",
          screen_name: "Home",
          first_seen_at: 1000,
          last_seen_at: 1000,
          visit_count: 1,
          back_stack_depth: null,
          task_id: null,
          screenshot_path: "/screens/com.app/Home.webp",
        })
        .returning("id")
        .executeTakeFirstOrThrow();

      const screenshotManagerSpy = spyOn(
        NavigationScreenshotManager,
        "getInstance",
      ).mockReturnValue({
        storeScreenshot: async () => "/screens/com.app/Home.webp",
      } as unknown as NavigationScreenshotManager);

      try {
        const withScreenshots = new DefaultIosSdkEventIngestor({
          deviceId: DEVICE_ID,
          getNavigationGraphManager: () => navSink,
          captureScreenshot: async (): Promise<CtrlProxyScreenshotResult> => ({
            success: true,
            data: "AAAA",
            format: "png",
          }),
          telemetryRecorder: recorder as unknown as IosTelemetryRecorder,
          failureRecorder,
          navigationScreenshotsEnabled: () => true,
        });

        await withScreenshots.recordSdkEvent(
          event("navigation", { destination: "Home" }),
          "com.app",
        );

        expect(recorder.navigation).toHaveLength(1);
        expect(
          (recorder.navigation[0].event as { screenshotUri: string | null }).screenshotUri,
        ).toBe(`automobile:navigation/nodes/${node.id}/screenshot?appId=com.app`);
      } finally {
        screenshotManagerSpy.mockRestore();
      }
    });
  });

  test("handled_exception routes to failure recorder as non-fatal", async () => {
    await ingestor.recordSdkEvent(
      event("handled_exception", {
        exceptionClass: "NSError",
        exceptionMessage: "bad",
        stackTrace: "frame1\nframe2",
      }),
      "com.app",
    );
    const nonFatals = failureRecorder.getRecordedFailures().filter((f) => f.type === "nonfatal");
    expect(nonFatals).toHaveLength(1);
    const nonFatal = nonFatals[0].input as {
      exceptionType: string;
      stackTrace: Array<{ methodName: string; isAppCode: boolean }>;
    };
    expect(nonFatal.exceptionType).toBe("NSError");
    // Stack string is split per newline into frames; app-code detection keys on applicationId.
    expect(nonFatal.stackTrace.map((f) => f.methodName)).toEqual(["frame1", "frame2"]);
  });

  test("crash routes to failure recorder as crash", async () => {
    await ingestor.recordSdkEvent(
      event("crash", {
        exceptionClass: "SIGABRT",
        exceptionMessage: "crashed",
        stackTrace: "a\nb",
      }),
      "com.app",
    );
    const crashes = failureRecorder.getRecordedFailures().filter((f) => f.type === "crash");
    expect(crashes).toHaveLength(1);
    expect((crashes[0].input as { exceptionType: string }).exceptionType).toBe("SIGABRT");
  });

  test("ingestion never throws and still restores context when a recorder rejects", async () => {
    // R2 rewrite: the old version stubbed `setContext: () => {}`, so it could not
    // observe the finally-block restore at all — it passed even if the restore
    // were deleted. Use the CapturingTelemetryRecorder (seeded with a prior
    // Android context) and make recordLogEvent throw AFTER setContext(iOS) ran.
    // The observable guarantee: the promise resolves (never throws) AND the prior
    // context is restored despite the throw.
    recorder.recordLogEvent = async (): Promise<void> => {
      throw new Error("db down");
    };
    await expect(ingestor.recordSdkEvent(event("log", {}), null)).resolves.toBeUndefined();
    expect(recorder.getContext()).toEqual({ deviceId: "prev-device", sessionId: "prev-session" });
  });

  describe("recordLayoutTelemetryEvent", () => {
    const hierarchy = (): ViewHierarchyResult =>
      ({
        hierarchy: { node: [{ $: { text: "a" } }, { $: { text: "b" } }] },
        packageName: "com.app",
        windows: [],
        updatedAt: 123,
      }) as unknown as ViewHierarchyResult;

    test("records a hierarchy_change layout event with a node count", () => {
      ingestor.recordLayoutTelemetryEvent(hierarchy());
      expect(recorder.layout).toHaveLength(1);
      expect(recorder.layout[0].event).toMatchObject({
        subType: "hierarchy_change",
        applicationId: "com.app",
        screenName: "com.app",
      });
      // Fixture is root ({ node: [...] }) + 2 leaves (each has $), so
      // countViewHierarchyNodes returns 3 (1 for the root's `node`, +1 per leaf `$`).
      expect((recorder.layout[0].event as { recompositionCount: number }).recompositionCount).toBe(
        3,
      );
    });

    test("uses device context and restores it", () => {
      ingestor.recordLayoutTelemetryEvent(hierarchy());
      expect(recorder.layout[0].contextAtCall).toEqual({ deviceId: DEVICE_ID, sessionId: null });
      expect(recorder.getContext()).toEqual({ deviceId: "prev-device", sessionId: "prev-session" });
    });

    test("restores the previous context when serialization throws (finally, not fall-through)", () => {
      // ADD-2 live bug: the restore used to sit after the JSON.stringify+record
      // inside the try, so a synchronous throw between setContext(iOS) and the
      // restore skipped it, leaving the shared context pinned to the iOS udid and
      // permanently mis-attributing later Android telemetry. A BigInt in the
      // hierarchy makes the internal JSON.stringify throw synchronously — after
      // setContext(iOS) has already run.
      const unserializable = {
        hierarchy: { node: [{ $: { bad: BigInt(1) } }] },
        packageName: "com.app",
        windows: [],
        updatedAt: 1,
      } as unknown as ViewHierarchyResult;
      // Must not throw (telemetry is best-effort) ...
      expect(() => ingestor.recordLayoutTelemetryEvent(unserializable)).not.toThrow();
      // ... and must have restored the prior context despite the throw.
      expect(recorder.getContext()).toEqual({ deviceId: "prev-device", sessionId: "prev-session" });
    });

    test("stays non-fatal when restoring the context itself throws", () => {
      // The restore runs in the finally, OUTSIDE the catch. If the recorder's
      // setContext throws while restoring the prior context, the exception must be
      // swallowed — processMessage calls this and telemetry must never break
      // observation. Only the restore call (deviceId "prev-device") throws; the
      // setContext(iOS) at the start still succeeds.
      class RestoreThrows extends CapturingTelemetryRecorder {
        setContext(deviceId: string | null, sessionId: string | null): void {
          if (deviceId === "prev-device") {
            throw new Error("setContext failed during restore");
          }
          super.setContext(deviceId, sessionId);
        }
      }
      const localIngestor = new DefaultIosSdkEventIngestor({
        deviceId: DEVICE_ID,
        getNavigationGraphManager: () => navSink,
        captureScreenshot: async (): Promise<CtrlProxyScreenshotResult> => ({ success: false }),
        telemetryRecorder: new RestoreThrows() as unknown as IosTelemetryRecorder,
        failureRecorder,
        navigationScreenshotsEnabled: () => false,
      });
      expect(() => localIngestor.recordLayoutTelemetryEvent(hierarchy())).not.toThrow();
    });
  });
});
