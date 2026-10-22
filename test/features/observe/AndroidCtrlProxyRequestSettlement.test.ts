import { describe, expect, test } from "bun:test";
import { CtrlProxyCertificates } from "../../../src/features/observe/android/CtrlProxyCertificates";
import { AndroidCtrlProxyClient } from "../../../src/features/observe/android/AndroidCtrlProxyClient";
import {
  ANDROID_CAPABILITY_GATED_COMMANDS,
  SDK_CAPABILITIES_USER_ID_CAPABILITY,
} from "../../../src/features/observe/android/ctrlProxyProtocol";
import { CountingIdGenerator } from "../../../src/utils/IdGenerator";
import { NoOpPerformanceTracker } from "../../../src/utils/PerformanceTracker";
import { FakeAdbExecutor } from "../../fakes/FakeAdbExecutor";
import { FakeInstalledAppsRepository } from "../../fakes/FakeInstalledAppsRepository";
import { FakeTimer } from "../../fakes/FakeTimer";
import { FakeWebSocket } from "../../fakes/FakeWebSocket";

class RecordingSocket extends FakeWebSocket {
  readonly frames: string[] = [];
  sendError?: Error;
  onFrame?: () => void;
  override send(data: string): void {
    if (this.sendError) {
      throw this.sendError;
    }
    super.send(data);
    this.frames.push(data);
    this.onFrame?.();
  }
}

async function harness() {
  const timer = new FakeTimer();
  const socket = new RecordingSocket("ws://fake", "none", 0, timer);
  const client = AndroidCtrlProxyClient.createForTesting(
    { deviceId: "client-send-command", platform: "android", name: "Android" },
    new FakeAdbExecutor(),
    {
      webSocketFactory: () => socket,
      timer,
      installedAppsRepository: new FakeInstalledAppsRepository(),
      idGenerator: new CountingIdGenerator("delegate"),
    },
  );
  await Promise.resolve();
  client.connectionTestHooks.socket = socket;
  client.connectionTestHooks.supportedCommands = new Set([
    ...ANDROID_CAPABILITY_GATED_COMMANDS,
    "request_activate_accessibility_link",
    "discover_keystore",
    "get_sdk_capabilities",
    SDK_CAPABILITIES_USER_ID_CAPABILITY,
    "tap_double_v1",
  ]);
  const manager = client.connectionTestHooks.requestManager;
  const ids = new CountingIdGenerator("wire");
  manager.generateId = (prefix) => `${prefix}_${ids.next()}`;
  client.ensureConnected = async () => true;
  client["connectWebSocket"] = async () => true;
  client["cancelScreenshotBackoff"] = () => {};
  return { client, timer, socket, manager };
}
type Harness = Awaited<ReturnType<typeof harness>>;
const perf = new NoOpPerformanceTracker();
async function flushDispatch() {
  for (let i = 0; i < 32; i++) {
    await Promise.resolve();
  }
}

interface Method {
  name: string;
  signal?: boolean;
  invoke: (h: Harness, signal?: AbortSignal) => Promise<unknown>;
}
const methods: Method[] = [
  {
    name: "settings get",
    signal: true,
    invoke: (h, signal) => h.client.requestSettingsGet("system", "key", 50, perf, signal),
  },
  {
    name: "settings put",
    signal: true,
    invoke: (h, signal) =>
      h.client.requestSettingsPut("system", "key", null, "string", 50, perf, signal),
  },
  {
    name: "settings list",
    signal: true,
    invoke: (h, signal) => h.client.requestSettingsList("system", 50, perf, signal),
  },
  {
    name: "action",
    signal: true,
    invoke: (h, signal) => h.client.requestAction("click", "id", 50, perf, undefined, signal),
  },
  {
    name: "node action",
    signal: true,
    invoke: (h, signal) =>
      h.client.requestNodeAction("click", { resourceId: "id" }, 50, perf, signal),
  },
  {
    name: "focused input click",
    signal: true,
    invoke: (h, signal) => h.client.requestClickFocusedInput(50, perf, signal),
  },
  {
    name: "accessibility link",
    signal: true,
    invoke: (h, signal) =>
      h.client.requestActivateAccessibilityLink({
        text: "link",
        occurrence: 0,
        timeoutMs: 50,
        perf,
        signal,
      }),
  },
  ...(["copy", "paste", "get", "clear"] as const).map((action): Method => ({
    name: `clipboard ${action}`,
    signal: true,
    invoke: (h, signal) =>
      h.client.requestClipboard(action, action === "copy" ? "text" : undefined, 50, perf, signal),
  })),
  {
    name: "global action",
    signal: true,
    invoke: (h, signal) => h.client.requestGlobalAction("back", 50, perf, undefined, signal),
  },
  {
    name: "frame validation",
    signal: true,
    invoke: (h, signal) => h.client.validateFrameContext("frame", 50, signal),
  },
  { name: "device info", invoke: (h) => h.client.requestDeviceInfo(50, perf) },
  {
    name: "tap",
    signal: true,
    invoke: (h, signal) =>
      h.client.testHooks.gestures().requestTapCoordinates({
        x: 1,
        y: 2,
        duration: 0,
        timeoutMs: 50,
        perf,
        signal,
      }),
  },
  {
    name: "double tap",
    signal: true,
    invoke: (h, signal) =>
      h.client.testHooks.gestures().requestDoubleTapCoordinates(1, 2, undefined, { signal }),
  },
  {
    name: "swipe",
    signal: true,
    invoke: (h, signal) =>
      h.client.testHooks.gestures().requestSwipe({
        x1: 1,
        y1: 2,
        x2: 3,
        y2: 4,
        duration: 50,
        timeoutMs: 50,
        perf,
        signal,
      }),
  },
  {
    name: "drag",
    signal: true,
    invoke: (h, signal) =>
      h.client.testHooks.gestures().requestDrag({
        x1: 1,
        y1: 2,
        x2: 3,
        y2: 4,
        pressDurationMs: 10,
        dragDurationMs: 20,
        holdDurationMs: 30,
        timeoutMs: 50,
        signal,
      }),
  },
  {
    name: "pinch",
    signal: true,
    invoke: (h, signal) =>
      h.client.testHooks.gestures().requestPinch({
        centerX: 1,
        centerY: 2,
        distanceStart: 3,
        distanceEnd: 4,
        rotationDegrees: 0,
        duration: 20,
        timeoutMs: 50,
        perf,
        signal,
      }),
  },
  {
    name: "two finger swipe",
    invoke: (h) =>
      h.client.testHooks.gestures().requestTwoFingerSwipe({
        x1: 1,
        y1: 2,
        x2: 3,
        y2: 4,
        duration: 20,
        offset: 10,
        timeoutMs: 50,
      }),
  },
  {
    name: "gesture start",
    invoke: (h) =>
      h.client.testHooks
        .gestures()
        .requestGestureStart({ gestureId: "g", x: 1, y: 2, timeoutMs: 50 }),
  },
  {
    name: "gesture move",
    invoke: (h) => h.client.testHooks.gestures().requestGestureMove("g", 1, 2, 50),
  },
  {
    name: "gesture end",
    invoke: (h) => h.client.testHooks.gestures().requestGestureEnd("g", 1, 2, false, 50),
  },
  {
    name: "set text",
    signal: true,
    invoke: (h, signal) =>
      h.client["text"].requestSetText("text", { timeoutMs: 50, abortSignal: signal }),
  },
  { name: "clear text", invoke: (h) => h.client["text"].requestClearText("id", 50) },
  {
    name: "ime action",
    signal: true,
    invoke: (h, signal) => h.client["text"].requestImeAction("done", 50, perf, signal),
  },
  { name: "select all", invoke: (h) => h.client["text"].requestSelectAll(50) },
  { name: "insert text state", invoke: (h) => h.client["text"].requestInsertTextState() },
  {
    name: "insert text",
    signal: true,
    invoke: (h, signal) =>
      h.client["text"].requestInsertText("text", 50, perf, undefined, { abortSignal: signal }),
  },
  {
    name: "commit via ime",
    signal: true,
    invoke: (h, signal) => {
      h.socket.onFrame = () => {
        const frame = JSON.parse(h.socket.frames.at(-1)!);
        if (frame.type === "request_cancel_ime_commit") {
          h.manager.resolve(frame.requestId, {
            success: true,
            targetRequestId: frame.targetRequestId,
          });
        }
      };
      return h.client["text"].commitViaIme("text", undefined, 50, perf, signal);
    },
  },
  { name: "set keyboard profile", invoke: (h) => h.client["text"].setKeyboardProfile("p", 50) },
  { name: "list keyboard profiles", invoke: (h) => h.client["text"].listKeyboardProfiles(50) },
  {
    name: "list preference files",
    invoke: (h) => h.client["storage"].listPreferenceFiles("pkg", 50),
  },
  {
    name: "get preference entries",
    invoke: (h) => h.client["storage"].getPreferenceEntries("pkg", "prefs", 50),
  },
  {
    name: "get preference",
    invoke: (h) => h.client["storage"].getPreference("pkg", "prefs", "key", 50),
  },
  { name: "discover keystore", invoke: (h) => h.client["storage"].discoverKeystore("pkg", 50) },
  {
    name: "get sdk capabilities",
    invoke: (h) => h.client["storage"].getSdkCapabilities("pkg", 0, 50),
  },
  {
    name: "list data stores",
    invoke: (h) => h.client["storage"].listDataStores("pkg", "adapter", 50),
  },
  {
    name: "get data store",
    invoke: (h) => h.client["storage"].getDataStore("pkg", "adapter", "store", 50),
  },
  {
    name: "subscribe storage",
    invoke: (h) => h.client["storage"].subscribeStorage("pkg", "prefs", 50),
  },
  {
    name: "unsubscribe storage",
    invoke: (h) => h.client["storage"].unsubscribeStorage("pkg:prefs", 50),
  },
  {
    name: "set preference",
    invoke: (h) => h.client["storage"].setPreference("pkg", "prefs", "key", null, "STRING", 50),
  },
  {
    name: "remove preference",
    invoke: (h) => h.client["storage"].removePreference("pkg", "prefs", "key", 50),
  },
  {
    name: "clear preferences",
    invoke: (h) => h.client["storage"].clearPreferenceStore("pkg", "prefs", 50),
  },
  {
    name: "install certificate",
    invoke: (h) => h.client["certificates"].requestInstallCaCertificate("PEM", 50),
  },
  {
    name: "install certificate from file",
    invoke: (h) => {
      const certificates = new CtrlProxyCertificates(
        h.client["createCertificatesDelegateContext"](),
        { stat: async () => ({ size: 1, isFile: () => true }) },
      );
      certificates["pushCertificateToDevice"] = async () => "/sdcard/ca.pem";
      return certificates.requestInstallCaCertificateFromFile("/tmp/ca.pem", 50);
    },
  },
  {
    name: "remove certificate",
    invoke: (h) => h.client["certificates"].requestRemoveCaCertificate("alias", 50),
  },
  { name: "device owner", invoke: (h) => h.client["certificates"].requestDeviceOwnerStatus(50) },
  {
    name: "permission",
    invoke: (h) => h.client["certificates"].requestPermission("perm", false, 50),
  },
  { name: "set focus", invoke: (h) => h.client["focus"].setAccessibilityFocus("id", 50) },
  { name: "clear focus", invoke: (h) => h.client["focus"].clearAccessibilityFocus("id", 50) },
  { name: "current focus", invoke: (h) => h.client["focus"].requestCurrentFocus(50) },
  { name: "traversal order", invoke: (h) => h.client["focus"].requestTraversalOrder(50) },
  {
    name: "installed packages",
    invoke: (h) => h.client["packages"].requestInstalledPackages(false, 0, 50),
  },
  { name: "package info", invoke: (h) => h.client["packages"].requestPackageInfo("pkg", {}, 50) },
  { name: "launch intent", invoke: (h) => h.client["packages"].requestLaunchIntent("pkg", 50) },
  {
    name: "add highlight",
    invoke: (h) =>
      h.client["highlights"].requestAddHighlight(
        "h",
        { type: "circle", bounds: { x: 1, y: 2, width: 3, height: 4 } },
        50,
      ),
  },
];

// Observe both fulfillment and rejection immediately. A bounded microtask drain
// detects hangs without advancing the request timeout or using wall-clock time.
function observe(promise: Promise<unknown>) {
  const outcome: { settled: boolean; rejected?: boolean; value?: unknown } = { settled: false };
  void promise.then(
    (value) => {
      Object.assign(outcome, { settled: true, rejected: false, value });
    },
    (value) => {
      Object.assign(outcome, { settled: true, rejected: true, value });
    },
  );
  return outcome;
}
function expectClean(h: Harness) {
  expect(h.manager.getPendingCount()).toBe(0);
  expect(h.timer.getPendingTimeoutCount()).toBe(0);
}

for (const method of methods) {
  describe(`${method.name} settlement`, () => {
    for (const failure of ["close", "send"] as const) {
      test(`settles on ${failure} without a pending request or timer`, async () => {
        const h = await harness();
        if (failure === "send") {
          h.socket.sendError = new Error("send failed");
        }
        const outcome = observe(method.invoke(h));
        await flushDispatch();
        if (failure === "close") {
          expect(h.manager.getPendingCount()).toBe(1);
          await h.client.close();
        }
        await flushDispatch();
        expect(outcome.settled).toBe(true);
        expectClean(h);
      });
    }
    if (method.signal) {
      for (const phase of ["pre-dispatch", "mid-flight"] as const) {
        test(`settles explicit abort ${phase}`, async () => {
          const h = await harness();
          const controller = new AbortController();
          if (phase === "pre-dispatch") {
            controller.abort(new Error("cancelled"));
          }
          const outcome = observe(method.invoke(h, controller.signal));
          await flushDispatch();
          if (phase === "mid-flight") {
            expect(h.manager.getPendingCount()).toBe(1);
            controller.abort(new Error("cancelled"));
            await flushDispatch();
          } else {
            expect(h.socket.frames).toEqual([]);
          }
          expect(outcome.settled).toBe(true);
          if (
            phase === "mid-flight" &&
            /clipboard|global action|frame validation/.test(method.name)
          ) {
            expect(outcome.rejected).toBe(false);
            expect(outcome.value).toMatchObject({ success: false, error: "Operation cancelled" });
            if (method.name !== "frame validation") {
              expect(outcome.value).toMatchObject({ acknowledged: false });
            }
          }
          if (
            phase === "mid-flight" &&
            /^(action|node action|focused input click|accessibility link)$/.test(method.name)
          ) {
            expect(outcome.rejected).toBe(false);
            expect(outcome.value).toMatchObject({
              success: false,
              acknowledged: false,
              dispatched: true,
            });
          }
          if (phase === "pre-dispatch" && method.name === "accessibility link") {
            // Preserve the existing pre-dispatch finally fence; in-flight cancellation is typed.
            expect(outcome.rejected).toBe(true);
            expect(outcome.value).toBe(controller.signal.reason);
          }
          expectClean(h);
        });
      }
    }
  });
}
