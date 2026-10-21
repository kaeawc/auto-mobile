import { afterEach, describe, expect, mock, spyOn, test } from "bun:test";
import { AndroidInboundMessageRouter } from "../../../../src/features/observe/android/AndroidInboundMessageRouter";
import type { AndroidInboundMessageRouterContext as Context } from "../../../../src/features/observe/android/AndroidInboundMessageRouterContext";
import {
  ANDROID_REQUEST_ID_ECHO_CAPABILITY,
  ctrlProxyMissingRequestIdError,
} from "../../../../src/features/observe/android/ctrlProxyProtocol";
import { CountingIdGenerator } from "../../../../src/utils/IdGenerator";
import { RequestManager } from "../../../../src/utils/RequestManager";
import { logger } from "../../../../src/utils/logger";
import { FakeAdbExecutor } from "../../../fakes/FakeAdbExecutor";
import { FakeTimer } from "../../../fakes/FakeTimer";

class RecordingContext implements Context {
  transientObserver = false;
  closed = false;
  device = {
    deviceId: "inbound-router",
    platform: "android" as const,
    name: "Android",
    isEmulator: true,
  };
  adb = new FakeAdbExecutor();
  timer = new FakeTimer();
  requestManager = new RequestManager(this.timer, new CountingIdGenerator("inbound"));
  rejectedCommands = new Set<string>();
  supportedCommands: Set<string> | null = null;
  onDisplayTransition: Context["onDisplayTransition"] = undefined;
  lateCancelledScreenshotRequestIds = new Set<string>();
  screenshotObservationStreamSuppressions = new Set<string>();
  screenshotCaptureBindings: Context["screenshotCaptureBindings"] = new Map();
  sdkNavigationAppIds = new Set<string>();
  maxCachedInteractions = 100;
  lastInteractionByApp: Context["lastInteractionByApp"] = new Map();
  readonly calls: Array<{ name: string; args: unknown[] }> = [];
  echoMarks = 0;
  hierarchy = {
    markRequestIdEchoAdvertised: () => {
      this.echoMarks++;
    },
  };
  _hierarchy = {
    rejectPendingHierarchy: (
      ...args: Parameters<NonNullable<Context["_hierarchy"]>["rejectPendingHierarchy"]>
    ) => {
      this.calls.push({ name: "hierarchyRejection", args });
      return true;
    },
  };
  certificates: Context["certificates"] = { handleCaCertRemovalResult: () => false };
  focus: Context["focus"] = { convertAccessibilityNodeToElement: () => null };
  prototypes: Context["prototypes"] = {
    handlePrototypeRequest: async () => {},
    handlePrototypeRequestCancel: () => {},
    handlePrototypeEvent: (...args) => {
      this.calls.push({ name: "prototype", args });
    },
  };
  storage: Context["storage"] = {
    notifyStorageChangeListeners: (...args) => {
      this.calls.push({ name: "storage", args });
    },
  };
  readonly ingestor: ReturnType<Context["getSdkEventIngestor"]> = {
    recordStorageEvent: (...args) => {
      this.calls.push({ name: "storageTelemetry", args });
    },
  };

  refreshObservationStreamHierarchyCadence(): void {
    this.calls.push({ name: "cadence", args: [] });
  }
  settleUnattributedFocusedClickRejection(
    ...args: Parameters<Context["settleUnattributedFocusedClickRejection"]>
  ): void {
    this.calls.push({ name: "focusedClick", args });
  }
  handleHierarchyUpdate(...args: Parameters<Context["handleHierarchyUpdate"]>): void {
    this.calls.push({ name: "hierarchy", args });
  }
  pushScreenshotToObservationStream(
    ...args: Parameters<Context["pushScreenshotToObservationStream"]>
  ): void {
    this.calls.push({ name: "screenshot", args });
  }
  recordSdkScreenIdentity(...args: Parameters<Context["recordSdkScreenIdentity"]>): void {
    this.calls.push({ name: "identity", args });
  }
  clearSdkScreenIdentity(...args: Parameters<Context["clearSdkScreenIdentity"]>): void {
    this.calls.push({ name: "clearIdentity", args });
  }
  ensureBuildContext(...args: Parameters<Context["ensureBuildContext"]>): void {
    this.calls.push({ name: "build", args });
  }
  attachRecentInteraction(...args: Parameters<Context["attachRecentInteraction"]>): void {
    this.calls.push({ name: "attachInteraction", args });
  }
  async enqueueNavigationGraphWrite(
    ...args: Parameters<Context["enqueueNavigationGraphWrite"]>
  ): Promise<void> {
    this.calls.push({ name: "navigation", args });
  }
  getNavigationGraphManager(): ReturnType<Context["getNavigationGraphManager"]> {
    throw new Error("Unexpected navigation screenshot");
  }
  pruneStaleInteractions(...args: Parameters<Context["pruneStaleInteractions"]>): void {
    this.calls.push({ name: "prune", args });
  }
  notifyInteractionListeners(...args: Parameters<Context["notifyInteractionListeners"]>): void {
    this.calls.push({ name: "interaction", args });
  }
  async handlePackageEvent(...args: Parameters<Context["handlePackageEvent"]>): Promise<void> {
    this.calls.push({ name: "package", args });
  }
  async handleHandledExceptionEvent(
    ...args: Parameters<Context["handleHandledExceptionEvent"]>
  ): Promise<void> {
    this.calls.push({ name: "handled", args });
  }
  async handleCrashEvent(...args: Parameters<Context["handleCrashEvent"]>): Promise<void> {
    this.calls.push({ name: "crash", args });
  }
  async handleAnrEvent(...args: Parameters<Context["handleAnrEvent"]>): Promise<void> {
    this.calls.push({ name: "anr", args });
  }
  handleFrameMetricsEvent(...args: Parameters<Context["handleFrameMetricsEvent"]>): void {
    this.calls.push({ name: "frames", args });
  }
  getSdkEventIngestor(): ReturnType<Context["getSdkEventIngestor"]> {
    return this.ingestor;
  }
  async recordSdkTelemetryEvent(
    ...args: Parameters<Context["recordSdkTelemetryEvent"]>
  ): Promise<void> {
    this.calls.push({ name: "telemetry", args });
  }
  resolvePendingResponse<Message extends { requestId?: string | null }, Payload>(
    message: Message,
    buildPayload: (message: Message & { requestId: string }) => Payload,
  ): void {
    if (message.requestId) {
      this.requestManager.resolve(
        message.requestId,
        buildPayload({ ...message, requestId: message.requestId }),
      );
    }
  }
}

function harness() {
  const ctx = new RecordingContext();
  const router = new AndroidInboundMessageRouter(ctx);
  const receive = (frame: object) => router.handleWebSocketMessage(JSON.stringify(frame));
  return { ctx, router, receive };
}

afterEach(() => {
  mock.restore();
});

describe("AndroidInboundMessageRouter without a client", () => {
  test("connected replaces capabilities, clears rejections and marks advertised echo", async () => {
    const h = harness();
    h.ctx.rejectedCommands.add("old");
    await h.receive({ type: "connected", supportedCommands: [ANDROID_REQUEST_ID_ECHO_CAPABILITY] });
    expect(h.ctx.rejectedCommands.size).toBe(0);
    expect(h.ctx.supportedCommands).toEqual(new Set([ANDROID_REQUEST_ID_ECHO_CAPABILITY]));
    expect(h.ctx.echoMarks).toBe(1);
    expect(h.ctx.calls).toEqual([{ name: "cadence", args: [] }]);
    await h.receive({ type: "connected" });
    expect(h.ctx.supportedCommands).toBeNull();
    expect(h.ctx.echoMarks).toBe(1);
  });

  test("transient connected leaves capabilities and rejections alone", async () => {
    const h = harness();
    h.ctx.transientObserver = true;
    h.ctx.rejectedCommands.add("old");
    await h.receive({ type: "connected", supportedCommands: [ANDROID_REQUEST_ID_ECHO_CAPABILITY] });
    expect(h.ctx.supportedCommands).toBeNull();
    expect([...h.ctx.rejectedCommands]).toEqual(["old"]);
    expect(h.ctx.echoMarks).toBe(0);
    expect(h.ctx.calls).toEqual([]);
  });

  test("unknown-command error settles the request, focused click and existing hierarchy", async () => {
    const h = harness();
    const id = h.ctx.requestManager.generateId("focused-click");
    const pending = h.ctx.requestManager.register(
      id,
      "focused-click",
      1000,
      () => "timeout",
      (error) => error,
    );
    h.ctx.lateCancelledScreenshotRequestIds.add(id);
    const error = "Unknown command type: request_click_focused_input";
    await h.receive({ type: "error", requestId: id, error });
    expect(await pending).toBe(error);
    expect([...h.ctx.rejectedCommands]).toEqual(["request_click_focused_input"]);
    expect(h.ctx.lateCancelledScreenshotRequestIds.size).toBe(0);
    expect(h.ctx.calls).toEqual([
      { name: "focusedClick", args: [id, "request_click_focused_input", error] },
      { name: "hierarchyRejection", args: [id, error] },
    ]);
    expect(h.ctx.timer.getPendingTimeoutCount()).toBe(0);
  });

  test("forwards hierarchy payload and correlation unchanged", async () => {
    const h = harness();
    // Same display-identity frame asserted in AndroidCtrlProxyMessageDispatch.test.ts.
    const data = {
      updatedAt: 10,
      packageName: "example.app",
      displayId: 5,
      panelUniqueId: "panel-rear",
    };
    await h.receive({
      type: "hierarchy_update",
      data,
      requestId: "hierarchy-1",
      frameContext: "frame-1",
      perfTiming: [],
    });
    expect(h.ctx.calls).toEqual([
      { name: "hierarchy", args: [data, [], "frame-1", "hierarchy-1"] },
    ]);
  });

  test("advertised echo drops absent and empty request IDs without settling a request", async () => {
    const h = harness();
    const warn = spyOn(logger, "warn").mockImplementation(() => {});
    h.ctx.supportedCommands = new Set([ANDROID_REQUEST_ID_ECHO_CAPABILITY]);
    const id = h.ctx.requestManager.generateId("swipe");
    const pending = h.ctx.requestManager.register(id, "swipe", 1000, () => ({ success: false }));
    // Frames already asserted by CtrlProxyRequestIdEcho.test.ts.
    for (const requestId of [undefined, ""]) {
      await h.receive({ type: "swipe_result", requestId, success: true, totalTimeMs: 999 });
    }
    expect(h.ctx.requestManager.getPendingCount()).toBe(1);
    expect(warn.mock.calls.map(([message]) => message)).toEqual([
      ctrlProxyMissingRequestIdError("swipe_result"),
      ctrlProxyMissingRequestIdError("swipe_result"),
    ]);
    await h.receive({ type: "swipe_result", requestId: id, success: true, totalTimeMs: 7 });
    expect(await pending).toMatchObject({ success: true, totalTimeMs: 7 });
  });

  test("transient filter allows hierarchy and errors but drops responses and SDK events", async () => {
    const h = harness();
    h.ctx.transientObserver = true;
    await h.receive({ type: "custom_event", event: { applicationId: "app" } });
    await h.receive({ type: "settings_get_result", requestId: "ignored", success: true });
    expect(h.ctx.calls).toEqual([]);
    await h.receive({ type: "hierarchy_update", data: { updatedAt: 10 } });
    await h.receive({ type: "error", error: "Malformed request" });
    expect(h.ctx.calls.map((call) => call.name)).toEqual(["hierarchy", "focusedClick"]);
  });

  test("unknown types including inherited object keys are ignored", async () => {
    const h = harness();
    for (const type of ["bogus_type", "toString", "constructor", "__proto__"]) {
      await expect(h.receive({ type })).resolves.toBeUndefined();
    }
    expect(h.ctx.calls).toEqual([]);
  });

  test("runtime-only custom_event falls back to SDK telemetry", async () => {
    const h = harness();
    const frame = {
      type: "custom_event",
      timestamp: 12,
      event: { applicationId: "app", name: "checkout" },
    };
    await h.receive(frame);
    expect(h.ctx.calls).toEqual([{ name: "telemetry", args: [frame] }]);
  });

  test("handler exceptions and invalid JSON are swallowed with a warning", async () => {
    const h = harness();
    const warn = spyOn(logger, "warn").mockImplementation(() => {});
    h.ctx.handleHierarchyUpdate = () => {
      throw new Error("handler failed");
    };
    await expect(h.receive({ type: "hierarchy_update", data: {} })).resolves.toBeUndefined();
    await expect(h.router.handleWebSocketMessage("{")).resolves.toBeUndefined();
    expect(warn.mock.calls).toHaveLength(2);
    expect(warn.mock.calls[0][0]).toContain(
      "Error handling WebSocket message: Error: handler failed",
    );
    expect(warn.mock.calls[1][0]).toContain("Error handling WebSocket message:");
  });
});

// Reuse response shapes asserted by existing Android wire/dispatch tests; only requestId is
// rebound to this manager's CountingIdGenerator. These families have no recorded Android JSON
// response corpus in test/fixtures (android-contract contains serializer descriptors).
const responseCases = [
  {
    // AndroidCtrlProxyMessageDispatch.test.ts: optional display identity.
    frame: { type: "screenshot", data: "AA==", displayId: 5, panelUniqueId: "panel-rear" },
    expected: {
      success: true,
      data: "AA==",
      format: "jpeg",
      displayId: 5,
      panelUniqueId: "panel-rear",
    },
  },
  {
    // AndroidCtrlProxyMessageDispatch.test.ts: shared settings response helper.
    frame: {
      type: "settings_get_result",
      success: true,
      value: "enabled",
      found: true,
      totalTimeMs: 2,
    },
    expected: { success: true, value: "enabled", found: true, totalTimeMs: 2 },
  },
  {
    // AndroidCtrlProxyClientSendCommand.test.ts: clipboard success result; add its wire envelope.
    frame: { type: "clipboard_result", success: true, totalTimeMs: 7 },
    expected: { success: true, totalTimeMs: 7 },
  },
  {
    // CtrlProxyStorage.test.ts: StorageResponse.FileList used by DataStore descriptors.
    frame: {
      type: "preference_files",
      success: true,
      packageName: "com.example",
      files: [{ name: "user_prefs", path: "", entryCount: 2 }],
      totalTimeMs: 4,
    },
    expected: {
      success: true,
      files: [{ name: "user_prefs", path: "", entryCount: 2 }],
      totalTimeMs: 4,
    },
  },
  {
    // CtrlProxyPackages.test.ts: requestInstalledPackages response.
    frame: {
      type: "installed_packages_result",
      success: true,
      userId: 0,
      packages: [
        { packageName: "com.example.app", isSystem: false, versionName: "1.0", versionCode: 1 },
        { packageName: "com.android.systemui", isSystem: true },
      ],
      totalTimeMs: 10,
    },
    expected: {
      success: true,
      userId: 0,
      packages: [
        { packageName: "com.example.app", isSystem: false, versionName: "1.0", versionCode: 1 },
        { packageName: "com.android.systemui", isSystem: true },
      ],
      totalTimeMs: 10,
    },
  },
];

for (const { frame, expected } of responseCases) {
  test(`${frame.type} resolves its own pending request through live context`, async () => {
    const h = harness();
    // Replacing state after router construction proves the map does not capture it.
    h.ctx.requestManager = new RequestManager(h.ctx.timer, new CountingIdGenerator("replacement"));
    const id = h.ctx.requestManager.generateId(frame.type);
    const pending = h.ctx.requestManager.register<unknown>(id, frame.type, 1000, () => "timeout");
    await h.receive({ ...frame, requestId: id });
    expect(await pending).toMatchObject(expected);
    expect(h.ctx.requestManager.getPendingCount()).toBe(0);
    expect(h.ctx.timer.getPendingTimeoutCount()).toBe(0);
  });
}
