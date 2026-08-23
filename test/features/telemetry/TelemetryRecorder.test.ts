import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import {
  TelemetryRecorder,
  type TelemetryRepository,
  type TelemetryPushTarget,
  type TelemetryEvent,
} from "../../../src/features/telemetry/TelemetryRecorder";
import { NetworkState } from "../../../src/server/NetworkState";
import type { RecordNetworkEventInput } from "../../../src/db/networkEventRepository";
import type { RecordLogEventInput } from "../../../src/db/logEventRepository";
import type { RecordOsEventInput } from "../../../src/db/osEventRepository";
import type { RecordNavigationEventInput } from "../../../src/db/navigationEventRepository";
import type { RecordStorageEventInput } from "../../../src/db/storageEventRepository";
import type { RecordLayoutEventInput } from "../../../src/db/layoutEventRepository";
import { InMemoryDbWriteBarrier } from "../../../src/db/dbWriteBarrier";
import { FakeTimer } from "../../fakes/FakeTimer";
import {
  TelemetryEventBuffer,
  type BatchTelemetryRepository,
} from "../../../src/features/telemetry/TelemetryEventBuffer";

class FakeRepository implements TelemetryRepository {
  networkEvents: RecordNetworkEventInput[] = [];
  logEvents: RecordLogEventInput[] = [];
  osEvents: RecordOsEventInput[] = [];
  navigationEvents: RecordNavigationEventInput[] = [];
  storageEvents: RecordStorageEventInput[] = [];
  layoutEvents: RecordLayoutEventInput[] = [];
  shouldThrow = false;
  private nextNetworkId = 1;

  async recordNetworkEvent(input: RecordNetworkEventInput): Promise<number> {
    if (this.shouldThrow) {
      throw new Error("db error");
    }
    this.networkEvents.push(input);
    return this.nextNetworkId++;
  }
  async recordLogEvent(input: RecordLogEventInput): Promise<void> {
    if (this.shouldThrow) {
      throw new Error("db error");
    }
    this.logEvents.push(input);
  }
  async recordOsEvent(input: RecordOsEventInput): Promise<void> {
    if (this.shouldThrow) {
      throw new Error("db error");
    }
    this.osEvents.push(input);
  }
  async recordNavigationEvent(input: RecordNavigationEventInput): Promise<void> {
    if (this.shouldThrow) {
      throw new Error("db error");
    }
    this.navigationEvents.push(input);
  }
  async recordStorageEvent(input: RecordStorageEventInput): Promise<void> {
    if (this.shouldThrow) {
      throw new Error("db error");
    }
    this.storageEvents.push(input);
  }
  async recordLayoutEvent(input: RecordLayoutEventInput): Promise<void> {
    if (this.shouldThrow) {
      throw new Error("db error");
    }
    this.layoutEvents.push(input);
  }
}

class FakePushTarget implements TelemetryPushTarget {
  pushedEvents: TelemetryEvent[] = [];
  pushTelemetryEvent(event: TelemetryEvent): void {
    this.pushedEvents.push(event);
  }
}

describe("TelemetryRecorder", () => {
  let repo: FakeRepository;
  let pushTarget: FakePushTarget;
  let recorder: TelemetryRecorder;

  beforeEach(() => {
    repo = new FakeRepository();
    pushTarget = new FakePushTarget();
    recorder = new TelemetryRecorder(repo, () => pushTarget);
    TelemetryRecorder.resetInstance();
    NetworkState.resetInstance();
    NetworkState.getInstance().setCapture(true);
  });

  afterEach(() => {
    NetworkState.resetInstance();
  });

  it("records network event to repository with context", async () => {
    recorder.setContext("device-1", "session-1");

    await recorder.recordNetworkEvent({
      timestamp: 1000,
      applicationId: "com.example",
      url: "https://api.example.com/users",
      method: "GET",
      statusCode: 200,
      durationMs: 42,
      requestBodySize: 0,
      responseBodySize: 1024,
      protocol: "h2",
      host: "api.example.com",
      path: "/users",
      error: null,
    });

    expect(repo.networkEvents).toHaveLength(1);
    expect(repo.networkEvents[0].deviceId).toBe("device-1");
    expect(repo.networkEvents[0].sessionId).toBe("session-1");
    expect(repo.networkEvents[0].url).toBe("https://api.example.com/users");
  });

  it("pushes network event to socket", async () => {
    await recorder.recordNetworkEvent({
      timestamp: 1000,
      applicationId: null,
      url: "/test",
      method: "GET",
      statusCode: 200,
      durationMs: 10,
      requestBodySize: 0,
      responseBodySize: 0,
      protocol: null,
      host: null,
      path: null,
      error: null,
    });

    expect(pushTarget.pushedEvents).toHaveLength(1);
    expect(pushTarget.pushedEvents[0].category).toBe("network");
    expect(pushTarget.pushedEvents[0].timestamp).toBe(1000);
    expect(pushTarget.pushedEvents[0].deviceId).toBeNull();
  });

  it("skips DB write when capture is disabled but still pushes to socket", async () => {
    NetworkState.getInstance().setCapture(false);

    await recorder.recordNetworkEvent({
      timestamp: 1000,
      applicationId: null,
      url: "/test",
      method: "GET",
      statusCode: 200,
      durationMs: 10,
      requestBodySize: 0,
      responseBodySize: 0,
      protocol: null,
      host: null,
      path: null,
      error: null,
    });

    expect(repo.networkEvents).toHaveLength(0);
    expect(pushTarget.pushedEvents).toHaveLength(1);
  });

  it("includes deviceId in pushed events", async () => {
    recorder.setContext("emulator-5554", "s1");

    await recorder.recordLogEvent({
      timestamp: 1000,
      applicationId: null,
      level: 4,
      tag: "t",
      message: "m",
      filterName: "f",
    });

    expect(pushTarget.pushedEvents).toHaveLength(1);
    expect(pushTarget.pushedEvents[0].deviceId).toBe("emulator-5554");
  });

  it("records log event to repository", async () => {
    recorder.setContext("d1", "s1");

    await recorder.recordLogEvent({
      timestamp: 2000,
      applicationId: "com.example",
      level: 4,
      tag: "TestTag",
      message: "hello",
      filterName: "main",
    });

    expect(repo.logEvents).toHaveLength(1);
    expect(repo.logEvents[0].tag).toBe("TestTag");
    expect(repo.logEvents[0].deviceId).toBe("d1");
  });

  it("records OS event to repository", async () => {
    await recorder.recordOsEvent({
      timestamp: 4000,
      applicationId: null,
      category: "lifecycle",
      kind: "foreground",
      details: null,
    });

    expect(repo.osEvents).toHaveLength(1);
    expect(repo.osEvents[0].category).toBe("lifecycle");
  });

  it("pushes all event types to socket", async () => {
    await recorder.recordNetworkEvent({
      timestamp: 1,
      applicationId: null,
      url: "u",
      method: "GET",
      statusCode: 200,
      durationMs: 0,
      requestBodySize: 0,
      responseBodySize: 0,
      protocol: null,
      host: null,
      path: null,
      error: null,
    });
    await recorder.recordLogEvent({
      timestamp: 2,
      applicationId: null,
      level: 4,
      tag: "t",
      message: "m",
      filterName: "f",
    });
    await recorder.recordOsEvent({
      timestamp: 3,
      applicationId: null,
      category: "c",
      kind: "k",
      details: null,
    });

    expect(pushTarget.pushedEvents).toHaveLength(3);
    expect(pushTarget.pushedEvents.map((e) => e.category)).toEqual(["network", "log", "os"]);
  });

  it("still pushes to socket when repository throws", async () => {
    repo.shouldThrow = true;

    await recorder.recordNetworkEvent({
      timestamp: 1000,
      applicationId: null,
      url: "u",
      method: "GET",
      statusCode: 200,
      durationMs: 0,
      requestBodySize: 0,
      responseBodySize: 0,
      protocol: null,
      host: null,
      path: null,
      error: null,
    });

    expect(repo.networkEvents).toHaveLength(0);
    expect(pushTarget.pushedEvents).toHaveLength(1);
  });

  it("does not throw when push target is null", async () => {
    const recorderNoPush = new TelemetryRecorder(repo, () => null);

    await recorderNoPush.recordLogEvent({
      timestamp: 1000,
      applicationId: null,
      level: 4,
      tag: "t",
      message: "m",
      filterName: "f",
    });

    expect(repo.logEvents).toHaveLength(1);
  });

  it("setContext updates deviceId and sessionId for subsequent events", async () => {
    recorder.setContext("d1", "s1");
    await recorder.recordLogEvent({
      timestamp: 1,
      applicationId: null,
      level: 4,
      tag: "t",
      message: "m",
      filterName: "f",
    });

    recorder.setContext("d2", "s2");
    await recorder.recordLogEvent({
      timestamp: 2,
      applicationId: null,
      level: 4,
      tag: "t",
      message: "m",
      filterName: "f",
    });

    expect(repo.logEvents[0].deviceId).toBe("d1");
    expect(repo.logEvents[0].sessionId).toBe("s1");
    expect(repo.logEvents[1].deviceId).toBe("d2");
    expect(repo.logEvents[1].sessionId).toBe("s2");
  });

  it("getContext returns current context", () => {
    recorder.setContext("dev-1", "sess-1");
    const ctx = recorder.getContext();
    expect(ctx.deviceId).toBe("dev-1");
    expect(ctx.sessionId).toBe("sess-1");
  });

  it("getInstance returns singleton", () => {
    const a = TelemetryRecorder.getInstance();
    const b = TelemetryRecorder.getInstance();
    expect(a).toBe(b);
  });

  it("resetInstance clears singleton", () => {
    const a = TelemetryRecorder.getInstance();
    TelemetryRecorder.resetInstance();
    const b = TelemetryRecorder.getInstance();
    expect(a).not.toBe(b);
  });

  it("snapshots context before async write to avoid race", async () => {
    // Simulate: start recording with device-A, then setContext to device-B
    // before the repo write completes. Both DB write and push should use device-A.
    let resolveWrite: (() => void) | null = null;
    const slowRepo: TelemetryRepository = {
      ...repo,
      recordNetworkEvent: async (input) => {
        repo.networkEvents.push(input);
        // Block until test resolves
        await new Promise<void>((r) => {
          resolveWrite = r;
        });
      },
    };
    const slowRecorder = new TelemetryRecorder(slowRepo, () => pushTarget);
    slowRecorder.setContext("device-A", "session-A");

    const promise = slowRecorder.recordNetworkEvent({
      timestamp: 1000,
      applicationId: null,
      url: "u",
      method: "GET",
      statusCode: 200,
      durationMs: 0,
      requestBodySize: 0,
      responseBodySize: 0,
      protocol: null,
      host: null,
      path: null,
      error: null,
    });

    // Context changes while the write is in flight
    slowRecorder.setContext("device-B", "session-B");

    // Let the write complete
    resolveWrite!();
    await promise;

    // DB should have device-A (snapshotted before await)
    expect(repo.networkEvents[0].deviceId).toBe("device-A");
    expect(repo.networkEvents[0].sessionId).toBe("session-A");
    // Push should also have device-A
    expect(pushTarget.pushedEvents[0].deviceId).toBe("device-A");
  });

  it("recordNavigationEvent stores to repository with context", async () => {
    recorder.setContext("d1", "s1");

    await recorder.recordNavigationEvent({
      timestamp: 5000,
      applicationId: "com.example",
      destination: "HomeScreen",
      source: "SplashScreen",
      arguments: { id: "123" },
      metadata: null,
    });

    expect(repo.navigationEvents).toHaveLength(1);
    expect(repo.navigationEvents[0].deviceId).toBe("d1");
    expect(repo.navigationEvents[0].sessionId).toBe("s1");
    expect(repo.navigationEvents[0].destination).toBe("HomeScreen");
    expect(repo.navigationEvents[0].source).toBe("SplashScreen");
  });

  it("recordNavigationEvent pushes category navigation to socket with triggeringInteraction and screenshotUri", async () => {
    await recorder.recordNavigationEvent({
      timestamp: 5000,
      applicationId: null,
      destination: "Settings",
      source: null,
      arguments: null,
      metadata: null,
      triggeringInteraction: { type: "tap", elementText: "Settings" },
      screenshotUri: "file:///tmp/screenshot.png",
    });

    expect(pushTarget.pushedEvents).toHaveLength(1);
    expect(pushTarget.pushedEvents[0].category).toBe("navigation");
    expect(pushTarget.pushedEvents[0].timestamp).toBe(5000);
    const data = pushTarget.pushedEvents[0].data as any;
    expect(data.triggeringInteraction).toEqual({ type: "tap", elementText: "Settings" });
    expect(data.screenshotUri).toBe("file:///tmp/screenshot.png");
  });

  it("recordStorageEvent stores to repository with context", async () => {
    recorder.setContext("d2", "s2");

    await recorder.recordStorageEvent({
      timestamp: 6000,
      applicationId: "com.example",
      fileName: "shared_prefs.xml",
      key: "theme",
      value: "dark",
      valueType: "string",
      changeType: "put",
    });

    expect(repo.storageEvents).toHaveLength(1);
    expect(repo.storageEvents[0].deviceId).toBe("d2");
    expect(repo.storageEvents[0].sessionId).toBe("s2");
    expect(repo.storageEvents[0].fileName).toBe("shared_prefs.xml");
    expect(repo.storageEvents[0].key).toBe("theme");
  });

  it("recordStorageEvent threads an explicit previousValue through to the repository", async () => {
    await recorder.recordStorageEvent({
      timestamp: 6000,
      applicationId: null,
      fileName: "prefs.xml",
      key: "theme",
      value: "dark",
      valueType: "string",
      changeType: "put",
      previousValue: "light",
    });

    expect(repo.storageEvents).toHaveLength(1);
    expect(repo.storageEvents[0].previousValue).toBe("light");
  });

  it("recordStorageEvent leaves previousValue undefined when the caller omits it", async () => {
    await recorder.recordStorageEvent({
      timestamp: 6000,
      applicationId: null,
      fileName: "prefs.xml",
      key: "theme",
      value: "dark",
      valueType: "string",
      changeType: "put",
    });

    expect(repo.storageEvents).toHaveLength(1);
    // Absent field → repository falls back to its auto-lookup path.
    expect(repo.storageEvents[0].previousValue).toBeUndefined();
  });

  it("recordStorageEvent pushes category storage to socket", async () => {
    await recorder.recordStorageEvent({
      timestamp: 6000,
      applicationId: null,
      fileName: "prefs.xml",
      key: "k",
      value: "v",
      valueType: null,
      changeType: "put",
    });

    expect(pushTarget.pushedEvents).toHaveLength(1);
    expect(pushTarget.pushedEvents[0].category).toBe("storage");
    expect(pushTarget.pushedEvents[0].timestamp).toBe(6000);
  });

  it("recordLayoutEvent stores to repository with context and screenName", async () => {
    recorder.setContext("d3", "s3");

    await recorder.recordLayoutEvent({
      timestamp: 7000,
      applicationId: "com.example",
      subType: "recomposition",
      composableName: "UserList",
      composableId: "user-list-1",
      recompositionCount: 15,
      durationMs: 8,
      likelyCause: "state change",
      detailsJson: null,
      screenName: "HomeScreen",
    });

    expect(repo.layoutEvents).toHaveLength(1);
    expect(repo.layoutEvents[0].deviceId).toBe("d3");
    expect(repo.layoutEvents[0].sessionId).toBe("s3");
    expect(repo.layoutEvents[0].composableName).toBe("UserList");
    expect(repo.layoutEvents[0].screenName).toBe("HomeScreen");
  });

  it("recordLayoutEvent pushes category layout to socket", async () => {
    await recorder.recordLayoutEvent({
      timestamp: 7000,
      applicationId: null,
      subType: "recomposition",
      composableName: null,
      composableId: null,
      recompositionCount: null,
      durationMs: null,
      likelyCause: null,
      detailsJson: null,
    });

    expect(pushTarget.pushedEvents).toHaveLength(1);
    expect(pushTarget.pushedEvents[0].category).toBe("layout");
    expect(pushTarget.pushedEvents[0].timestamp).toBe(7000);
  });

  it("recordFailureTelemetry pushes crash event with stackTrace to socket", () => {
    recorder.setContext("d1", "s1");

    recorder.recordFailureTelemetry({
      type: "crash",
      occurrenceId: "occ_1",
      groupId: "crash:NullPointerException",
      severity: "high",
      title: "NullPointerException in onClick",
      exceptionType: "NullPointerException",
      screen: "HomeScreen",
      timestamp: 8000,
      stackTrace: [
        {
          className: "com.example.MainActivity",
          methodName: "onClick",
          fileName: "MainActivity.kt",
          lineNumber: 42,
          isAppCode: true,
        },
      ],
    });

    expect(pushTarget.pushedEvents).toHaveLength(1);
    expect(pushTarget.pushedEvents[0].category).toBe("crash");
    expect(pushTarget.pushedEvents[0].timestamp).toBe(8000);
    expect(pushTarget.pushedEvents[0].deviceId).toBe("d1");
    const data = pushTarget.pushedEvents[0].data as any;
    expect(data.stackTrace).toHaveLength(1);
    expect(data.stackTrace[0].className).toBe("com.example.MainActivity");
  });

  it("recordFailureTelemetry pushes anr event to socket", () => {
    recorder.recordFailureTelemetry({
      type: "anr",
      occurrenceId: "occ_2",
      groupId: "anr:main",
      severity: "high",
      title: "ANR: Main thread blocked",
      screen: null,
      timestamp: 9000,
    });

    expect(pushTarget.pushedEvents).toHaveLength(1);
    expect(pushTarget.pushedEvents[0].category).toBe("anr");
    expect(pushTarget.pushedEvents[0].timestamp).toBe(9000);
  });

  it("recordFailureTelemetry does not write to repository", () => {
    recorder.recordFailureTelemetry({
      type: "crash",
      occurrenceId: "occ_3",
      groupId: "crash:RuntimeException",
      severity: "medium",
      title: "RuntimeException",
      timestamp: 10000,
    });

    expect(repo.networkEvents).toHaveLength(0);
    expect(repo.logEvents).toHaveLength(0);
    expect(repo.osEvents).toHaveLength(0);
    expect(repo.navigationEvents).toHaveLength(0);
    expect(repo.storageEvents).toHaveLength(0);
    expect(repo.layoutEvents).toHaveLength(0);
  });

  it("recordNetworkEvent with headers and bodies passes through to repository and push", async () => {
    recorder.setContext("d1", "s1");

    await recorder.recordNetworkEvent({
      timestamp: 11000,
      applicationId: "com.example",
      url: "https://api.example.com/data",
      method: "POST",
      statusCode: 201,
      durationMs: 100,
      requestBodySize: 50,
      responseBodySize: 200,
      protocol: "h2",
      host: "api.example.com",
      path: "/data",
      error: null,
      requestHeaders: { "Content-Type": "application/json" },
      responseHeaders: { "X-Request-Id": "abc123" },
      requestBody: '{"name":"test"}',
      responseBody: '{"id":1}',
      contentType: "application/json",
    });

    expect(repo.networkEvents).toHaveLength(1);
    expect(repo.networkEvents[0].requestHeaders).toEqual({ "Content-Type": "application/json" });
    expect(repo.networkEvents[0].responseHeaders).toEqual({ "X-Request-Id": "abc123" });
    expect(repo.networkEvents[0].requestBody).toBe('{"name":"test"}');
    expect(repo.networkEvents[0].responseBody).toBe('{"id":1}');
    expect(repo.networkEvents[0].contentType).toBe("application/json");

    expect(pushTarget.pushedEvents).toHaveLength(1);
    expect(pushTarget.pushedEvents[0].category).toBe("network");
    const data = pushTarget.pushedEvents[0].data as any;
    expect(data.requestHeaders).toEqual({ "Content-Type": "application/json" });
    expect(data.responseBody).toBe('{"id":1}');
  });

  describe("batched ingestion (issue #3138)", () => {
    class FakeBatchRepo implements BatchTelemetryRepository {
      logBatches: RecordLogEventInput[][] = [];
      osBatches: RecordOsEventInput[][] = [];
      navBatches: RecordNavigationEventInput[][] = [];
      layoutBatches: RecordLayoutEventInput[][] = [];
      async recordLogEvents(i: RecordLogEventInput[]): Promise<void> {
        this.logBatches.push(i);
      }
      async recordOsEvents(i: RecordOsEventInput[]): Promise<void> {
        this.osBatches.push(i);
      }
      async recordNavigationEvents(i: RecordNavigationEventInput[]): Promise<void> {
        this.navBatches.push(i);
      }
      async recordLayoutEvents(i: RecordLayoutEventInput[]): Promise<void> {
        this.layoutBatches.push(i);
      }
    }

    it("routes log/os/nav/layout through the buffer and coalesces into one batch per kind", async () => {
      const batchRepo = new FakeBatchRepo();
      const timer = new FakeTimer();
      const buffer = new TelemetryEventBuffer(batchRepo, timer, { maxBufferedRows: 1000 });
      const bufferedRecorder = new TelemetryRecorder(repo, () => pushTarget, undefined, buffer);
      bufferedRecorder.setContext("d1", "s1");

      await bufferedRecorder.recordLogEvent({
        timestamp: 1,
        applicationId: null,
        level: 4,
        tag: "t",
        message: "m",
        filterName: "f",
      });
      await bufferedRecorder.recordLogEvent({
        timestamp: 2,
        applicationId: null,
        level: 4,
        tag: "t",
        message: "m",
        filterName: "f",
      });
      await bufferedRecorder.recordOsEvent({
        timestamp: 3,
        applicationId: null,
        category: "c",
        kind: "k",
        details: null,
      });

      // Not written per-row, and the non-batch repo path is bypassed entirely.
      expect(batchRepo.logBatches).toHaveLength(0);
      expect(repo.logEvents).toHaveLength(0);
      // But still pushed to the socket immediately (live dashboard unaffected).
      expect(pushTarget.pushedEvents.map((e) => e.category)).toEqual(["log", "log", "os"]);

      await bufferedRecorder.flushBuffer();

      expect(batchRepo.logBatches).toHaveLength(1);
      expect(batchRepo.logBatches[0]).toHaveLength(2);
      expect(batchRepo.logBatches[0][0].deviceId).toBe("d1");
      expect(batchRepo.osBatches[0]).toHaveLength(1);
    });

    it("leaves network and storage on the per-row path even when buffering", async () => {
      const batchRepo = new FakeBatchRepo();
      const buffer = new TelemetryEventBuffer(batchRepo, new FakeTimer(), {
        maxBufferedRows: 1000,
      });
      const bufferedRecorder = new TelemetryRecorder(repo, () => pushTarget, undefined, buffer);

      await bufferedRecorder.recordNetworkEvent({
        timestamp: 1,
        applicationId: null,
        url: "u",
        method: "GET",
        statusCode: 200,
        durationMs: 0,
        requestBodySize: 0,
        responseBodySize: 0,
        protocol: null,
        host: null,
        path: null,
        error: null,
      });
      await bufferedRecorder.recordStorageEvent({
        timestamp: 2,
        applicationId: null,
        fileName: "p.xml",
        key: "k",
        value: "v",
        valueType: null,
        changeType: "put",
      });

      // Written synchronously through the per-row repository, not the buffer.
      expect(repo.networkEvents).toHaveLength(1);
      expect(repo.storageEvents).toHaveLength(1);
    });

    it("flushBuffer is a no-op when batching is disabled", async () => {
      await expect(recorder.flushBuffer()).resolves.toBeUndefined();
    });
  });

  describe("shutdown draining (issue #2792)", () => {
    it("skips the DB write once the barrier is draining, still pushes to socket (A5)", async () => {
      const barrier = new InMemoryDbWriteBarrier(new FakeTimer());
      const drainingRecorder = new TelemetryRecorder(
        repo,
        () => pushTarget,
        () => barrier,
      );
      drainingRecorder.setContext("device-1", "session-1");
      barrier.beginDrain();

      await drainingRecorder.recordNetworkEvent({
        timestamp: 1000,
        applicationId: null,
        url: "u",
        method: "GET",
        statusCode: 200,
        durationMs: 0,
        requestBodySize: 0,
        responseBodySize: 0,
        protocol: null,
        host: null,
        path: null,
        error: null,
      });
      await drainingRecorder.recordLogEvent({
        timestamp: 1000,
        applicationId: null,
        level: 3,
        tag: "t",
        message: "m",
        filterName: "f",
      });

      // No DB write hit the closing connection.
      expect(repo.networkEvents).toHaveLength(0);
      expect(repo.logEvents).toHaveLength(0);
      // Push side is unaffected (socket teardown is handled separately).
      expect(pushTarget.pushedEvents.map((e) => e.category)).toEqual(["network", "log"]);
    });

    it("does not throw to callers when draining even if the repo would fail", async () => {
      repo.shouldThrow = true;
      const barrier = new InMemoryDbWriteBarrier(new FakeTimer());
      const drainingRecorder = new TelemetryRecorder(
        repo,
        () => pushTarget,
        () => barrier,
      );
      barrier.beginDrain();

      // Would throw "db error" if the write were attempted; draining skips it.
      await expect(
        drainingRecorder.recordOsEvent({
          timestamp: 1,
          applicationId: null,
          category: "c",
          kind: "k",
          details: null,
        }),
      ).resolves.toBeUndefined();
    });

    it("routes writes through the barrier so drain awaits them", async () => {
      const barrier = new InMemoryDbWriteBarrier(new FakeTimer());
      let resolveWrite: (() => void) | null = null;
      const slowRepo: TelemetryRepository = {
        ...repo,
        recordLogEvent: async (input) => {
          repo.logEvents.push(input);
          await new Promise<void>((r) => {
            resolveWrite = r;
          });
        },
      };
      const slowRecorder = new TelemetryRecorder(
        slowRepo,
        () => pushTarget,
        () => barrier,
      );

      const p = slowRecorder.recordLogEvent({
        timestamp: 1,
        applicationId: null,
        level: 3,
        tag: "t",
        message: "m",
        filterName: "f",
      });
      // The in-flight write is visible to the barrier's drain set.
      expect(barrier.inFlightCount()).toBe(1);

      resolveWrite!();
      await p;
      expect(barrier.inFlightCount()).toBe(0);
    });
  });
});
