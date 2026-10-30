import { createExecResult } from "../../../../src/utils/execResult";
import { describe, expect, test } from "bun:test";
import { AndroidCtrlProxyClient } from "../../../../src/features/observe/android/AndroidCtrlProxyClient";
import { AndroidCtrlProxyDelegatingFacade } from "../../../../src/features/observe/android/AndroidCtrlProxyDelegatingFacade";
import { CountingIdGenerator } from "../../../../src/utils/IdGenerator";
import { NoOpPerformanceTracker } from "../../../../src/utils/PerformanceTracker";
import { FakeAdbExecutor } from "../../../fakes/FakeAdbExecutor";
import { FakeInstalledAppsRepository } from "../../../fakes/FakeInstalledAppsRepository";
import { FakeTimer } from "../../../fakes/FakeTimer";
import { FakeWebSocket } from "../../../fakes/FakeWebSocket";

/**
 * Issue #11844: every AndroidCtrlProxyClient request method that sends a frame over the CtrlProxy
 * socket must settle (resolve or reject, never hang) when the caller's AbortSignal aborts and when
 * the socket closes, and must leave no pending request or timeout behind. The timeout is long and
 * FakeTimer is never advanced, so only the abort or the close can settle the request.
 */
class RecordingSocket extends FakeWebSocket {
  readonly frames: string[] = [];
  override send(data: string): void {
    super.send(data);
    this.frames.push(data);
  }
}

const LONG_TIMEOUT_MS = 60_000;
const perf = new NoOpPerformanceTracker();

async function harness() {
  const timer = new FakeTimer();
  const socket = new RecordingSocket("ws://fake", "none", 0, timer);
  const adb = new FakeAdbExecutor();
  const client = AndroidCtrlProxyClient.createForTesting(
    { deviceId: "client-settlement", platform: "android", name: "Android" },
    adb,
    {
      webSocketFactory: () => socket,
      timer,
      installedAppsRepository: new FakeInstalledAppsRepository(),
      idGenerator: new CountingIdGenerator("settle"),
    },
  );
  await Promise.resolve();
  client.connectionTestHooks.socket = socket;
  client.connectionTestHooks.supportedCommands = new Set([
    "full_command_set_v1",
    "request_id_echo_v1",
    "tap_double_v1",
    "request_activate_accessibility_link",
    "request_tap_coordinates",
    "request_swipe",
    "request_drag",
    "request_pinch",
    "request_gesture_start",
    "request_gesture_move",
    "request_gesture_end",
    "request_set_text",
    "request_ime_action",
    "request_two_finger_swipe",
    "get_current_focus",
    "multi_finger_gesture_v1",
    "get_traversal_order",
    "request_hierarchy",
    "request_select_all",
    "request_insert_text",
    "request_insert_text_state",
    "set_recomposition_tracking",
    "subscribe_storage",
    "request_commit_text",
    "request_set_keyboard_profile",
    "request_list_keyboard_profiles",
    "prototype_saved_v1",
    "prototype_storage_v1",
    "prototype_timers_v1",
    "prototype_patch_v1",
    "prototype_persistence_replay_v1",
    "show_prototype",
    "dismiss_prototype",
    "patch_prototype",
    "save_prototype",
    "pin_saved_prototype",
    "list_saved_prototypes",
    "inspect_prototypes",
    "delete_saved_prototype",
    "clear_prototype_storage",
    "advance_prototype_clock",
    "put_prototype_asset",
    "remove_prototype_asset",
  ]);
  client.ensureConnected = async () => true;
  client.testHooks.overrideConnectWebSocket(async () => true);
  client.testHooks.overrideCancelScreenshotBackoff(() => {});
  // A lost connection otherwise arms a reconnect timer, which is not a request leak.
  client.connectionTestHooks.autoReconnectEnabled = false;
  adb.setCommandResponse("pidof", createExecResult("1234", ""));
  return { client, timer, socket, manager: client.connectionTestHooks.requestManager };
}
type Harness = Awaited<ReturnType<typeof harness>>;

async function flush() {
  for (let i = 0; i < 32; i++) {
    await Promise.resolve();
  }
}

interface RequestMethod {
  name: string;
  /** Starts the request. Methods without a signal parameter ignore `signal`. */
  invoke: (h: Harness, signal: AbortSignal) => Promise<unknown>;
  /** False when the method intentionally has no caller cancellation (settles on close only). */
  abortable?: boolean;
}

const selector = { resourceId: "res/id" };
const prototypeSpec = {
  id: "panel",
  window: { placement: { type: "fullscreen" as const }, opacity: 90 },
  root: { type: "text" as const, text: "Hello" },
};
const pngBytes = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const methods: RequestMethod[] = [
  {
    name: "requestAction",
    invoke: (h, s) => h.client.requestAction("click", "id", LONG_TIMEOUT_MS, perf, { signal: s }),
  },
  {
    name: "requestClickFocusedInput",
    invoke: (h, s) => h.client.requestClickFocusedInput(LONG_TIMEOUT_MS, perf, s),
  },
  {
    name: "requestNodeAction",
    invoke: (h, s) => h.client.requestNodeAction("click", selector, LONG_TIMEOUT_MS, perf, s),
  },
  {
    name: "requestActivateAccessibilityLink",
    invoke: (h, s) =>
      h.client.requestActivateAccessibilityLink({
        text: "link",
        occurrence: 1,
        timeoutMs: LONG_TIMEOUT_MS,
        perf,
        signal: s,
      }),
  },
  {
    name: "requestAccessibilityAction",
    invoke: (h, s) =>
      h.client.requestAccessibilityAction({
        action: "expand",
        resourceId: "com.example:id/row",
        timeoutMs: LONG_TIMEOUT_MS,
        signal: s,
      }),
  },
  {
    name: "requestClipboard",
    invoke: (h, s) =>
      h.client.requestClipboard("get", undefined, LONG_TIMEOUT_MS, perf, { signal: s }),
  },
  {
    name: "requestSettingsGet",
    invoke: (h, s) => h.client.requestSettingsGet("global", "key", LONG_TIMEOUT_MS, perf, s),
  },
  {
    name: "requestSettingsPut",
    invoke: (h, s) =>
      h.client.requestSettingsPut("global", "key", "1", undefined, {
        timeoutMs: LONG_TIMEOUT_MS,
        perf,
        signal: s,
      }),
  },
  {
    name: "requestSettingsList",
    invoke: (h, s) => h.client.requestSettingsList("global", LONG_TIMEOUT_MS, perf, s),
  },
  {
    name: "requestGlobalAction",
    invoke: (h, s) => h.client.requestGlobalAction("back", LONG_TIMEOUT_MS, perf, { signal: s }),
  },
  {
    name: "validateFrameContext",
    invoke: (h, s) => h.client.validateFrameContext("frame", LONG_TIMEOUT_MS, s),
  },
  {
    name: "requestDeviceInfo",
    abortable: false,
    invoke: (h) => h.client.requestDeviceInfo(LONG_TIMEOUT_MS, perf),
  },
  {
    name: "requestSwipe",
    invoke: (h, s) =>
      h.client.requestSwipe({
        x1: 1,
        y1: 2,
        x2: 3,
        y2: 4,
        duration: 100,
        timeoutMs: LONG_TIMEOUT_MS,
        perf,
        signal: s,
      }),
  },
  {
    name: "requestTapCoordinates",
    invoke: (h, s) =>
      h.client.requestTapCoordinates({
        x: 1,
        y: 2,
        duration: 50,
        timeoutMs: LONG_TIMEOUT_MS,
        perf,
        signal: s,
      }),
  },
  {
    name: "requestDoubleTapCoordinates",
    invoke: (h, s) => h.client.requestDoubleTapCoordinates(1, 2, undefined, { signal: s }),
  },
  {
    name: "requestDrag",
    invoke: (h, s) =>
      h.client.requestDrag({
        x1: 1,
        y1: 2,
        x2: 3,
        y2: 4,
        pressDurationMs: 10,
        dragDurationMs: 100,
        holdDurationMs: 10,
        timeoutMs: LONG_TIMEOUT_MS,
        signal: s,
      }),
  },
  {
    name: "requestPinch",
    invoke: (h, s) =>
      h.client.requestPinch({
        centerX: 5,
        centerY: 5,
        distanceStart: 10,
        distanceEnd: 20,
        rotationDegrees: 0,
        duration: 100,
        timeoutMs: LONG_TIMEOUT_MS,
        perf,
        signal: s,
      }),
  },
  {
    name: "requestGestureStart",
    abortable: false,
    invoke: (h) =>
      h.client.requestGestureStart({
        gestureId: "g",
        x: 1,
        y: 2,
        timeoutMs: LONG_TIMEOUT_MS,
        perf,
      }),
  },
  {
    name: "requestGestureMove",
    abortable: false,
    invoke: (h) => h.client.requestGestureMove("g", 1, 2, LONG_TIMEOUT_MS, perf),
  },
  {
    name: "requestGestureEnd",
    abortable: false,
    invoke: (h) =>
      h.client.requestGestureEnd("g", 1, 2, false, { timeoutMs: LONG_TIMEOUT_MS, perf }),
  },
  {
    name: "requestSetText",
    invoke: (h, s) => h.client.requestSetText("hi", { timeoutMs: LONG_TIMEOUT_MS, abortSignal: s }),
  },
  {
    name: "requestInsertText",
    invoke: (h, s) =>
      h.client.requestInsertText("hi", LONG_TIMEOUT_MS, perf, undefined, { abortSignal: s }),
  },
  {
    name: "commitViaIme",
    invoke: (h, s) => h.client.commitViaIme("hi", undefined, LONG_TIMEOUT_MS, perf, { signal: s }),
  },
  {
    name: "requestImeAction",
    invoke: (h, s) => h.client.requestImeAction("done", LONG_TIMEOUT_MS, perf, s),
  },
  {
    name: "requestClearText",
    abortable: false,
    invoke: (h) => h.client.requestClearText("id", LONG_TIMEOUT_MS, perf),
  },
  {
    name: "requestSelectAll",
    abortable: false,
    invoke: (h) => h.client.requestSelectAll(LONG_TIMEOUT_MS, perf),
  },
  {
    name: "setKeyboardProfile",
    abortable: false,
    invoke: (h) => h.client.setKeyboardProfile("p", LONG_TIMEOUT_MS, perf),
  },
  {
    name: "listKeyboardProfiles",
    abortable: false,
    invoke: (h) => h.client.listKeyboardProfiles(LONG_TIMEOUT_MS, perf),
  },
  {
    name: "requestAddHighlight",
    abortable: false,
    invoke: (h) =>
      h.client.requestAddHighlight(
        "h",
        { type: "circle", bounds: { x: 0, y: 0, width: 1, height: 1 } },
        LONG_TIMEOUT_MS,
        perf,
      ),
  },
  {
    name: "requestInstalledPackages",
    abortable: false,
    invoke: (h) => h.client.requestInstalledPackages(true, undefined, LONG_TIMEOUT_MS),
  },
  {
    name: "requestPackageInfo",
    abortable: false,
    invoke: (h) => h.client.requestPackageInfo("com.example", {}, LONG_TIMEOUT_MS),
  },
  {
    name: "requestLaunchIntent",
    abortable: false,
    invoke: (h) => h.client.requestLaunchIntent("com.example", LONG_TIMEOUT_MS),
  },
  {
    name: "requestInstallCaCertificate",
    abortable: false,
    invoke: (h) =>
      h.client.requestInstallCaCertificate(
        "-----BEGIN CERTIFICATE-----\nAAAA\n-----END CERTIFICATE-----",
        LONG_TIMEOUT_MS,
        perf,
      ),
  },
  {
    name: "requestRemoveCaCertificate",
    abortable: false,
    invoke: (h) => h.client.requestRemoveCaCertificate("alias", LONG_TIMEOUT_MS, perf),
  },
  {
    name: "requestDeviceOwnerStatus",
    abortable: false,
    invoke: (h) => h.client.requestDeviceOwnerStatus(LONG_TIMEOUT_MS, perf),
  },
  {
    name: "requestPermission",
    abortable: false,
    invoke: (h) =>
      h.client.requestPermission("android.permission.CAMERA", false, LONG_TIMEOUT_MS, perf),
  },
  {
    name: "requestListSavedPrototypes",
    abortable: false,
    invoke: (h) => h.client.requestListSavedPrototypes(LONG_TIMEOUT_MS, perf),
  },
  {
    name: "requestInspectPrototypes",
    abortable: false,
    invoke: (h) => h.client.requestInspectPrototypes(LONG_TIMEOUT_MS, perf),
  },
  {
    name: "requestDeleteSavedPrototype",
    abortable: false,
    invoke: (h) => h.client.requestDeleteSavedPrototype("p", LONG_TIMEOUT_MS, perf),
  },
  {
    name: "requestShowPrototype",
    abortable: false,
    invoke: (h) => h.client.requestShowPrototype(prototypeSpec, LONG_TIMEOUT_MS, perf),
  },
  {
    name: "requestDismissPrototype",
    abortable: false,
    invoke: (h) => h.client.requestDismissPrototype({ all: true }, LONG_TIMEOUT_MS, perf),
  },
  {
    name: "requestPatchPrototype",
    abortable: false,
    invoke: (h) =>
      h.client.requestPatchPrototype(
        { id: "panel", ops: [{ op: "replace", path: "/data/count", value: 2 }] },
        LONG_TIMEOUT_MS,
        perf,
      ),
  },
  {
    name: "requestSavePrototype",
    abortable: false,
    invoke: (h) =>
      h.client.requestSavePrototype({ spec: prototypeSpec, label: "Panel" }, LONG_TIMEOUT_MS, perf),
  },
  {
    name: "requestPinSavedPrototype",
    abortable: false,
    invoke: (h) => h.client.requestPinSavedPrototype("p", undefined, LONG_TIMEOUT_MS, perf),
  },
  {
    name: "requestClearPrototypeStorage",
    abortable: false,
    invoke: (h) => h.client.requestClearPrototypeStorage("p", LONG_TIMEOUT_MS, perf),
  },
  {
    name: "requestAdvancePrototypeClock",
    abortable: false,
    invoke: (h) => h.client.requestAdvancePrototypeClock("p", 1000, LONG_TIMEOUT_MS, perf),
  },
  {
    name: "requestPutPrototypeAsset",
    invoke: (h, s) =>
      h.client.requestPutPrototypeAsset(
        { id: "a", mimeType: "image/png", bytes: pngBytes },
        { timeoutMs: LONG_TIMEOUT_MS, abortSignal: s },
      ),
  },
  {
    name: "requestRemovePrototypeAsset",
    invoke: (h, s) =>
      h.client.requestRemovePrototypeAsset("a", { timeoutMs: LONG_TIMEOUT_MS, abortSignal: s }),
  },
  {
    name: "requestInsertTextState",
    abortable: false,
    invoke: (h) => h.client.requestInsertTextState(),
  },
  {
    name: "setRecompositionTrackingEnabled",
    invoke: (h, s) => h.client.setRecompositionTrackingEnabled(true, perf, s),
  },
  {
    name: "requestScreenshotWithoutObservationStreamPush",
    abortable: false,
    invoke: (h) => h.client.requestScreenshotWithoutObservationStreamPush(LONG_TIMEOUT_MS, perf),
  },
  {
    name: "requestHierarchySyncWithoutObservationStreamPush",
    invoke: (h, s) =>
      h.client.requestHierarchySyncWithoutObservationStreamPush(perf, false, s, LONG_TIMEOUT_MS),
  },
  {
    name: "subscribeStorage",
    abortable: false,
    invoke: (h) => h.client.subscribeStorage("com.example", "prefs.xml", LONG_TIMEOUT_MS),
  },
  {
    name: "requestCurrentFocus",
    abortable: false,
    invoke: (h) => h.client.requestCurrentFocus(LONG_TIMEOUT_MS, perf),
  },
  {
    name: "requestTraversalOrder",
    abortable: false,
    invoke: (h) => h.client.requestTraversalOrder(LONG_TIMEOUT_MS, perf),
  },
  {
    name: "requestTwoFingerSwipe",
    abortable: false,
    invoke: (h) =>
      h.client.requestTwoFingerSwipe({
        x1: 1,
        y1: 2,
        x2: 3,
        y2: 4,
        duration: 100,
        offset: 50,
        timeoutMs: LONG_TIMEOUT_MS,
        perf,
      }),
  },
  {
    name: "requestMultiFingerSwipe",
    invoke: (h, s) =>
      h.client.requestMultiFingerSwipe({
        x1: 1,
        y1: 2,
        x2: 3,
        y2: 4,
        fingerCount: 3,
        duration: 100,
        fingerSpacing: 20,
        timeoutMs: LONG_TIMEOUT_MS,
        perf,
        signal: s,
      }),
  },
  {
    name: "requestHierarchySyncForObserver",
    invoke: (h, s) => h.client.requestHierarchySyncForObserver(perf, false, s, LONG_TIMEOUT_MS),
  },
  {
    name: "requestScreenshot",
    invoke: (h, s) => h.client.requestScreenshot(LONG_TIMEOUT_MS, perf, { signal: s }),
  },
  {
    name: "requestHierarchySync",
    invoke: (h, s) => h.client.requestHierarchySync(perf, false, s, LONG_TIMEOUT_MS),
  },
  {
    name: "listPreferenceFiles",
    abortable: false,
    invoke: (h) => h.client.listPreferenceFiles("pkg", LONG_TIMEOUT_MS),
  },
  {
    name: "getPreferenceEntries",
    abortable: false,
    invoke: (h) => h.client.getPreferenceEntries("pkg", "file", LONG_TIMEOUT_MS),
  },
  {
    name: "getPreference",
    abortable: false,
    invoke: (h) => h.client.getPreference("pkg", "file", "key", LONG_TIMEOUT_MS),
  },
  {
    name: "setPreference",
    abortable: false,
    invoke: (h) =>
      h.client.setPreference(
        "pkg",
        "file",
        { key: "key", value: "1", type: "STRING" },
        LONG_TIMEOUT_MS,
      ),
  },
  {
    name: "removePreference",
    abortable: false,
    invoke: (h) => h.client.removePreference("pkg", "file", "key", LONG_TIMEOUT_MS),
  },
  {
    name: "clearPreferenceStore",
    abortable: false,
    invoke: (h) => h.client.clearPreferenceStore("pkg", "file", LONG_TIMEOUT_MS),
  },
  {
    name: "listDataStores",
    abortable: false,
    invoke: (h) => h.client.listDataStores("pkg", "adapter", LONG_TIMEOUT_MS),
  },
  {
    name: "getDataStore",
    abortable: false,
    invoke: (h) => h.client.getDataStore("pkg", "adapter", "store", LONG_TIMEOUT_MS),
  },
  {
    name: "unsubscribeStorage",
    abortable: false,
    invoke: (h) => h.client.unsubscribeStorage("sub", LONG_TIMEOUT_MS),
  },
  {
    name: "setAccessibilityFocus",
    abortable: false,
    invoke: (h) => h.client.setAccessibilityFocus("id", LONG_TIMEOUT_MS, perf),
  },
  {
    name: "clearAccessibilityFocus",
    abortable: false,
    invoke: (h) => h.client.clearAccessibilityFocus("id", LONG_TIMEOUT_MS, perf),
  },
];

type Trigger = "abort" | "socket close";

async function settle(
  h: Harness,
  method: RequestMethod,
  trigger: Trigger,
): Promise<{ outcome: "settled" | "hung"; framesSent: number }> {
  const controller = new AbortController();
  let settled = false;
  const pending = method.invoke(h, controller.signal).then(
    () => {
      settled = true;
    },
    () => {
      settled = true;
    },
  );
  await flush();
  const framesSent = h.socket.frames.length;
  if (trigger === "abort") {
    controller.abort(new Error("caller cancelled"));
  } else {
    h.client.testHooks.finishEstablishedConnection(h.socket);
  }
  await flush();
  if (!settled) {
    // Unblock the test runner without hiding the hang: fail the leaked request explicitly.
    h.manager.cancelAll(new Error("test cleanup"));
    await pending;
    return { outcome: "hung", framesSent };
  }
  return { outcome: "settled", framesSent };
}

describe("AndroidCtrlProxyClient request settlement (#11844)", () => {
  for (const method of methods) {
    test(`${method.name} settles and cleans up when the socket closes`, async () => {
      const h = await harness();
      const { outcome, framesSent } = await settle(h, method, "socket close");
      expect(framesSent).toBeGreaterThan(0);
      expect(outcome).toBe("settled");
      expect(h.manager.getPendingCount()).toBe(0);
      expect(h.timer.getPendingTimeoutCount()).toBe(0);
      await h.client.close();
    });

    if (method.abortable !== false) {
      test(`${method.name} settles and cleans up when the signal aborts`, async () => {
        const h = await harness();
        const { outcome, framesSent } = await settle(h, method, "abort");
        expect(framesSent).toBeGreaterThan(0);
        expect(outcome).toBe("settled");
        expect(h.manager.getPendingCount()).toBe(0);
        expect(h.timer.getPendingTimeoutCount()).toBe(0);
        await h.client.close();
      });
    }
  }
});

/** Request-shaped public methods with a reason they are not driven over the socket here. */
const EXCLUDED: Record<string, string> = {
  awaitCancellableRequest:
    "protected transport helper; exercised through the public request methods in this table",
  sendClientCommand:
    "protected transport helper; exercised through the public request methods in this table",
  handleHierarchyUpdate:
    "inbound hierarchy delivery; resolves waiters rather than creating an outbound request",
  handleWebSocketMessage:
    "protected inbound dispatch; resolves waiters rather than creating an outbound request",
  getAccessibilityHierarchy:
    "uses the hierarchy delegate covered by requestHierarchySync and hierarchy-specific tests",
  getLatestHierarchy:
    "uses the hierarchy delegate covered by requestHierarchySync and hierarchy-specific tests",
  hasCachedHierarchy: "reads the in-process hierarchy cache; it sends nothing",
  invalidateCache: "invalidates the in-process hierarchy cache; it sends nothing",
  supportsAccessibilityLinkActivation:
    "capability query before dispatch, covered by accessibility-link tests",
  supportsCommand: "capability query before dispatch, covered by command-capability tests",
  supportsNodeActionSelectors: "capability query before dispatch, covered by node-action tests",
  verifyServiceReady:
    "bounded retry wrapper around requestHierarchySync, covered by service-readiness tests",
  requestInstallCaCertificateFromFile:
    "reads the certificate on the host, then sends the same frame as requestInstallCaCertificate",
  getSdkCapabilities:
    "sends only when the device advertises the optional command, which this harness does not",
  discoverKeystore:
    "sends only when the device advertises the optional command, which this harness does not",
  addStorageChangeListener: "registers an in-process listener; it sends nothing",
  attachPrototypeRequestHost: "wires an in-process host; it sends nothing",
  attachPrototypeChannelHost: "wires an in-process host; it sends nothing",
  onPrototypeEvent: "registers an in-process listener; it sends nothing",
  requestIdFromWireData: "decodes an inbound frame's id; it sends nothing",
};

/**
 * Every method the delegating facade declares. The universe is the facade's own method list
 * (not a name-prefix regex), so a newly added request method must be driven or excluded with a
 * reason; it cannot slip past by not matching a pattern.
 */
function facadeMethodNames(): string[] {
  const proto = AndroidCtrlProxyDelegatingFacade.prototype;
  return Object.getOwnPropertyNames(proto)
    .filter(
      (name) =>
        name !== "constructor" &&
        typeof Object.getOwnPropertyDescriptor(proto, name)?.value === "function",
    )
    .sort();
}

test("the settlement table covers every public facade method", () => {
  const covered = new Set([...methods.map((m) => m.name), ...Object.keys(EXCLUDED)]);
  expect(facadeMethodNames().filter((name) => !covered.has(name))).toEqual([]);
});
