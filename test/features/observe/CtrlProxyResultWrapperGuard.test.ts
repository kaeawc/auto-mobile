import { createExecResult } from "../../../src/utils/execResult";
import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { AndroidCtrlProxyClient } from "../../../src/features/observe/android/AndroidCtrlProxyClient";
import { IOSCtrlProxyClient } from "../../../src/features/observe/ios";
import { defaultWebSocketFactory } from "../../../src/features/observe/DeviceServiceClient";
import { RealCtrlProxyWebSocketInTestError } from "../../../src/features/observe/RealCtrlProxyWebSocketInTestError";
import { AndroidCtrlProxyManager } from "../../../src/ctrlProxy/CtrlProxyManager";
import { ForcedRestartBudget } from "../../../src/ctrlProxy/ForcedRestartBudget";
import type { CtrlProxyIosManager } from "../../../src/ctrlProxy/IOSCtrlProxyManager";
import type { BootedDevice } from "../../../src/models";
import { FakeAdbExecutor } from "../../fakes/FakeAdbExecutor";
import { FakeTimer } from "../../fakes/FakeTimer";
import { maskRealCtrlProxyWebSocketOptIn } from "../../helpers/maskRealCtrlProxyWebSocketOptIn";

/**
 * Every CtrlProxy client method that wraps its transport in a typed result must
 * reject with the unit-test WebSocket guard (#10470) rather than resolve a
 * `success: false`/`null` answer, so a leaking unit test fails loudly instead of
 * passing on a degraded result.
 */

const androidDevice: BootedDevice = {
  deviceId: "guard-android",
  platform: "android",
  name: "Guard Android",
};

const iosDevice: BootedDevice = {
  deviceId: "guard-ios",
  platform: "ios",
  name: "Guard iPhone",
};

function createIosManager(timer: FakeTimer): CtrlProxyIosManager {
  const budget = new ForcedRestartBudget(timer);
  return {
    getForcedRestartBudget: () => budget,
    async setup() {
      return { success: false as const, message: "guard test" };
    },
    async isInstalled() {
      return false;
    },
    async isRunning() {
      return false;
    },
    async isAvailable() {
      return false;
    },
    async start() {},
    async stop() {},
    resetSetupState() {},
    async getReportedRunnerPort() {
      return null;
    },
    getServicePort() {
      return 0;
    },
    setAutoRestart() {},
    isAutoRestartEnabled() {
      return false;
    },
    async forceRestart() {},
  };
}

type AndroidCase = [string, (client: AndroidCtrlProxyClient) => Promise<unknown>];
type IosCase = [string, (client: IOSCtrlProxyClient) => Promise<unknown>];

const androidCases: AndroidCase[] = [
  ["requestClipboard", (c) => c.requestClipboard("get")],
  ["requestDeviceInfo", (c) => c.requestDeviceInfo()],
  ["requestScreenshot", (c) => c.requestScreenshot()],
  ["requestImeAction", (c) => c.requestImeAction("done")],
  ["requestInsertText", (c) => c.requestInsertText("hello")],
  ["requestInstallCaCertificate", (c) => c.requestInstallCaCertificate("PEM")],
  ["requestRemoveCaCertificate", (c) => c.requestRemoveCaCertificate("alias")],
  ["requestDeviceOwnerStatus", (c) => c.requestDeviceOwnerStatus()],
  ["requestPermission", (c) => c.requestPermission("android.permission.CAMERA")],
  ["requestCurrentFocus", (c) => c.requestCurrentFocus()],
  ["requestTraversalOrder", (c) => c.requestTraversalOrder()],
  [
    "requestAddHighlight",
    (c) =>
      c.requestAddHighlight("guard", {
        type: "circle",
        bounds: { x: 0, y: 0, width: 10, height: 10 },
      }),
  ],
  ["getLatestHierarchy", (c) => c.getLatestHierarchy(false)],
  ["requestHierarchySync", (c) => c.requestHierarchySync()],
  [
    "getAccessibilityHierarchy",
    async (c) => {
      // Past the availability probe, so the read reaches the connect path.
      const available = spyOn(AndroidCtrlProxyManager.prototype, "isAvailable").mockResolvedValue(
        true,
      );
      try {
        return await c.getAccessibilityHierarchy();
      } finally {
        available.mockRestore();
      }
    },
  ],
];

const iosCases: IosCase[] = [
  ["requestSetText", (c) => c.requestSetText("hello")],
  ["requestClipboard", (c) => c.requestClipboard("get")],
  ["requestVoiceOverActivate", (c) => c.requestVoiceOverActivate("OK", "activate")],
  [
    "requestActivateAccessibilityLink",
    (c) => c.requestActivateAccessibilityLink({ text: "Terms", occurrence: 0 }),
  ],
  ["requestHierarchySync", (c) => c.requestHierarchySync()],
];

describe("CtrlProxy result wrappers rethrow the unit-test WebSocket guard (#10470)", () => {
  maskRealCtrlProxyWebSocketOptIn();

  let android: AndroidCtrlProxyClient | null = null;
  let ios: IOSCtrlProxyClient | null = null;

  afterEach(async () => {
    await android?.close();
    android = null;
    await ios?.close();
    ios = null;
    IOSCtrlProxyClient.resetInstances();
  });

  test.each(androidCases)("Android %s rejects with the guard error", async (_name, call) => {
    const timer = new FakeTimer();
    timer.enableAutoAdvance();
    const adb = new FakeAdbExecutor();
    adb.setCommandResponse("forward", createExecResult("8765", ""));
    adb.setDeviceStates([{ deviceId: androidDevice.deviceId, state: "device" }]);
    android = AndroidCtrlProxyClient.createForTesting(androidDevice, adb, {
      webSocketFactory: (url) => defaultWebSocketFactory(url),
      timer,
    });
    await expect(call(android)).rejects.toBeInstanceOf(RealCtrlProxyWebSocketInTestError);
  });

  test.each(iosCases)("iOS %s rejects with the guard error", async (_name, call) => {
    const timer = new FakeTimer();
    timer.enableAutoAdvance();
    ios = IOSCtrlProxyClient.createForTesting(iosDevice, 8765, {
      wsFactory: (url) => defaultWebSocketFactory(url),
      timer,
      serviceManagerFactory: () => createIosManager(timer),
    });
    await expect(call(ios)).rejects.toBeInstanceOf(RealCtrlProxyWebSocketInTestError);
  });
});
