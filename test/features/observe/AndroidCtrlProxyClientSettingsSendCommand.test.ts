import { createObserveResultForTest } from "./flatHierarchyBuilders";
import { describe, expect, test } from "bun:test";
import { Rotate } from "../../../src/features/action/Rotate";
import { AndroidCtrlProxyClient } from "../../../src/features/observe/android/AndroidCtrlProxyClient";
import {
  ANDROID_FULL_COMMAND_SET_CAPABILITY,
  ctrlProxyRequests,
  serializeCtrlProxyRequest,
} from "../../../src/features/observe/android/ctrlProxyProtocol";
import type { BaseResult } from "../../../src/features/observe/shared/types";
import { CountingIdGenerator } from "../../../src/utils/IdGenerator";
import { runWithAbortSignal } from "../../../src/utils/AbortContext";
import { NoOpPerformanceTracker } from "../../../src/utils/PerformanceTracker";
import { createExecResult } from "../../../src/utils/execResult";
import { FakeAdbExecutor } from "../../fakes/FakeAdbExecutor";
import { FakeAwaitIdle } from "../../fakes/FakeAwaitIdle";
import { FakeInstalledAppsRepository } from "../../fakes/FakeInstalledAppsRepository";
import { FakeObserveScreen } from "../../fakes/FakeObserveScreen";
import { FakeTimer } from "../../fakes/FakeTimer";
import { FakeWebSocket } from "../../fakes/FakeWebSocket";
import { FakeWindow } from "../../fakes/FakeWindow";

class RecordingSocket extends FakeWebSocket {
  readonly frames: string[] = [];
  sendError?: Error;
  onFrame?: (data: string) => void;

  override send(data: string): void {
    if (this.sendError) {
      throw this.sendError;
    }
    super.send(data);
    this.frames.push(data);
    this.onFrame?.(data);
  }
}

async function harness() {
  const timer = new FakeTimer();
  const socket = new RecordingSocket("ws://fake", "none", 0, timer);
  const ids = new CountingIdGenerator("delegate");
  const device = {
    deviceId: "settings-send-command",
    platform: "android" as const,
    name: "Android",
    isEmulator: true,
  };
  const adb = new FakeAdbExecutor();
  const client = AndroidCtrlProxyClient.createForTesting(device, adb, {
    webSocketFactory: () => socket,
    timer,
    installedAppsRepository: new FakeInstalledAppsRepository(),
    idGenerator: ids,
  });
  await Promise.resolve();
  client.connectionTestHooks.socket = socket;
  const requestIds = new CountingIdGenerator("wire");
  const manager = client.connectionTestHooks.requestManager;
  manager.generateId = (prefix) => `${prefix}_${requestIds.next()}`;
  let connects = 0;
  let backoffCancels = 0;
  client.ensureConnected = async () => {
    connects++;
    return true;
  };
  client["cancelScreenshotBackoff"] = () => {
    backoffCancels++;
  };
  return {
    device,
    adb,
    client,
    timer,
    socket,
    manager,
    connects: () => connects,
    cancels: () => backoffCancels,
  };
}

test("cancelled Rotate sends the auto-rotate restore put through the real settings client", async () => {
  const h = await harness();
  const controller = new AbortController();
  let autoRotate = "1";
  h.socket.onFrame = (data) => {
    const frame: { type: string; requestId: string; key: string; value?: string } =
      JSON.parse(data);
    if (frame.type === "request_settings_put" && frame.key === "accelerometer_rotation") {
      autoRotate = frame.value ?? "";
      if (autoRotate === "0") {
        controller.abort(new Error("Rotation cancelled"));
      }
    }
    queueMicrotask(() => {
      void h.client["handleWebSocketMessage"](
        JSON.stringify({
          type: frame.type.replace("request_", "") + "_result",
          requestId: frame.requestId,
          success: true,
          found: frame.key === "accelerometer_rotation",
          value: frame.key === "accelerometer_rotation" ? autoRotate : undefined,
          totalTimeMs: 0,
        }),
      );
    });
  };
  h.adb.setCommandResponse("shell wm size", createExecResult("Physical size: 1080x1920", ""));
  h.adb.setCommandResponse("shell dumpsys window displays", createExecResult("mRotation=0", ""));
  const rotate = new Rotate(h.device, h.adb, h.timer);
  const observeScreen = new FakeObserveScreen();
  observeScreen.setObserveResult(() =>
    createObserveResultForTest({
      observationId: "settings",
      display: { key: "default", role: "unknown", posture: "unknown", generation: 0 },
      updatedAt: h.timer.now(),
      screenSize: { width: 1080, height: 1920 },
      systemInsets: { top: 0, bottom: 0, left: 0, right: 0 },
      viewHierarchy: { hierarchy: { node: {} } },
    }),
  );
  const window = new FakeWindow();
  window.configureCachedActiveWindow(null);
  window.configureActiveWindow({ appId: "com.test.app", activityName: "Main", layoutSeqSum: 1 });
  Object.assign(rotate, { awaitIdle: new FakeAwaitIdle(), observeScreen, window });
  AndroidCtrlProxyClient.registerForTesting(h.client, h.device.deviceId);
  try {
    await expect(
      runWithAbortSignal(controller.signal, () =>
        rotate.execute("landscape", { signal: controller.signal }),
      ),
    ).rejects.toThrow("Rotation cancelled");
    expect(controller.signal.aborted).toBe(true);
    expect(
      h.socket.frames
        .map((data): { type: string; key: string; value?: string } => JSON.parse(data))
        .filter((frame) => frame.type === "request_settings_put")
        .map(({ key, value }) => ({ key, value })),
    ).toEqual([
      { key: "accelerometer_rotation", value: "0" },
      { key: "accelerometer_rotation", value: "1" },
    ]);
    expect(autoRotate).toBe("1");
    expect(h.manager.getPendingCount()).toBe(0);
    expect(h.adb.getExecutedCommands().some((command) => command.includes("settings put"))).toBe(
      false,
    );
  } finally {
    AndroidCtrlProxyClient.clearInstanceRegistryForTesting();
  }
});

const perf = new NoOpPerformanceTracker();
const methods = [
  {
    operation: "get",
    invoke: (client: AndroidCtrlProxyClient, signal?: AbortSignal) =>
      client.requestSettingsGet("secure", "key", 50, perf, signal),
    oldFrame: (requestId: string) =>
      serializeCtrlProxyRequest(
        ctrlProxyRequests.requestSettingsGet({ requestId, namespace: "secure", key: "key" }),
      ),
    literal:
      '{"type":"request_settings_get","requestId":"settings_get_wire-1","namespace":"secure","key":"key"}',
    failureFields: { found: false },
  },
  {
    operation: "put",
    invoke: (client: AndroidCtrlProxyClient, signal?: AbortSignal) =>
      client.requestSettingsPut("secure", "key", null, "string", 50, perf, signal),
    oldFrame: (requestId: string) =>
      serializeCtrlProxyRequest(
        ctrlProxyRequests.requestSettingsPut({
          requestId,
          namespace: "secure",
          key: "key",
          value: null,
          valueType: "string",
        }),
      ),
    literal:
      '{"type":"request_settings_put","requestId":"settings_put_wire-1","namespace":"secure","key":"key","value":null,"valueType":"string"}',
    failureFields: {},
  },
  {
    operation: "list",
    invoke: (client: AndroidCtrlProxyClient, signal?: AbortSignal) =>
      client.requestSettingsList("secure", 50, perf, signal),
    oldFrame: (requestId: string) =>
      serializeCtrlProxyRequest(
        ctrlProxyRequests.requestSettingsList({ requestId, namespace: "secure" }),
      ),
    literal:
      '{"type":"request_settings_list","requestId":"settings_list_wire-1","namespace":"secure"}',
    failureFields: {},
  },
];

for (const method of methods) {
  describe(`settings ${method.operation} sendCommand`, () => {
    const id = `settings_${method.operation}_wire-1`;
    const failure = (error: string, totalTimeMs = 0) => ({
      success: false,
      ...method.failureFields,
      totalTimeMs,
      error,
    });

    test("preserves the exact old frame, support bypass, and response correlation", async () => {
      const h = await harness();
      h.client.connectionTestHooks.supportedCommands = new Set([
        ANDROID_FULL_COMMAND_SET_CAPABILITY,
      ]);
      h.client["rejectedCommands"].add(`request_settings_${method.operation}`);
      const pending = method.invoke(h.client);
      expect(h.socket.frames).toEqual([method.literal]);
      expect(h.socket.frames[0]).toBe(method.oldFrame(id));
      expect(h.connects()).toBe(0);
      expect(h.cancels()).toBe(0);
      await h.client["handleWebSocketMessage"](
        JSON.stringify({
          type: `settings_${method.operation}_result`,
          requestId: id,
          success: true,
          found: true,
          value: "v",
          entries: { key: "v" },
          totalTimeMs: 7,
        }),
      );
      expect(await pending).toMatchObject({ success: true, totalTimeMs: 7 });
      expect(h.manager.getPendingCount()).toBe(0);
    });

    test("returns the original disconnected shape without connecting or registering", async () => {
      const h = await harness();
      h.client.connectionTestHooks.socket = null;
      expect(await method.invoke(h.client)).toEqual(failure("WebSocket not connected"));
      expect(h.connects()).toBe(0);
      expect(h.cancels()).toBe(0);
      expect(h.manager.getPendingCount()).toBe(0);
      expect(h.socket.frames).toEqual([]);
    });

    test("returns the original timeout shape and removes the request", async () => {
      const h = await harness();
      const pending = method.invoke(h.client);
      expect(h.manager.getPendingCount()).toBe(1);
      h.timer.advanceTime(50);
      expect(await pending).toEqual(failure(`Settings ${method.operation} timeout after 50ms`, 50));
      expect(h.manager.getPendingCount()).toBe(0);
    });

    for (const alreadyAborted of [true, false]) {
      for (const explicitSignal of [undefined, new AbortController().signal]) {
        test(`ignores ${alreadyAborted ? "pre-aborted" : "in-flight"} ambient cancellation ${explicitSignal ? "with" : "without"} an explicit live signal`, async () => {
          const h = await harness();
          const controller = new AbortController();
          if (alreadyAborted) {
            controller.abort(new Error("cancelled"));
          }
          const pending = runWithAbortSignal(controller.signal, () =>
            method.invoke(h.client, explicitSignal),
          );
          expect(h.manager.getPendingCount()).toBe(1);
          if (!alreadyAborted) {
            h.timer.advanceTime(3);
            controller.abort(new Error("cancelled"));
          }
          expect(h.socket.frames).toEqual([method.literal]);
          expect(h.manager.getPendingCount()).toBe(1);
          await h.client["handleWebSocketMessage"](
            JSON.stringify({
              type: `settings_${method.operation}_result`,
              requestId: id,
              success: true,
              totalTimeMs: 7,
            }),
          );
          expect(await pending).toMatchObject({ success: true, totalTimeMs: 7 });
          expect(h.manager.getPendingCount()).toBe(0);
        });
      }

      test(`settles ${alreadyAborted ? "pre-aborted" : "in-flight"} explicit cancellation without pending work`, async () => {
        const h = await harness();
        const controller = new AbortController();
        if (alreadyAborted) {
          controller.abort(new Error("cancelled"));
        }
        const pending = method.invoke(h.client, controller.signal);
        expect(h.manager.getPendingCount()).toBe(alreadyAborted ? 0 : 1);
        if (!alreadyAborted) {
          h.timer.advanceTime(3);
          controller.abort(new Error("cancelled"));
        }
        expect(await pending).toEqual(failure("Error: cancelled", alreadyAborted ? 0 : 3));
        expect(h.manager.getPendingCount()).toBe(0);
        expect(h.socket.frames).toHaveLength(alreadyAborted ? 0 : 1);
      });
    }

    test("turns a send exception into a typed failure and removes the request", async () => {
      const h = await harness();
      h.socket.sendError = new Error("send failed");
      expect(await method.invoke(h.client)).toEqual(failure("Error: send failed"));
      expect(h.manager.getPendingCount()).toBe(0);
    });
  });
}

describe("Android delegate timestamped IDs", () => {
  test("shares the injected generator across storage, packages, hierarchy, and certificate paths", async () => {
    const h = await harness();
    h.timer.advanceTime(123);
    const storage = h.client.testHooks.storage().listPreferenceFiles("example.app");
    await Promise.resolve();
    expect(JSON.parse(h.socket.frames[0]).requestId).toBe("list_preference_files_123_delegate-1");
    h.manager.resolve("list_preference_files_123_delegate-1", {
      success: true,
      totalTimeMs: 0,
      files: [],
    });
    await storage;
    const packages = h.client.testHooks.packages().requestInstalledPackages();
    expect(JSON.parse(h.socket.frames[1]).requestId).toBe("installed_packages_123_delegate-2");
    h.manager.resolve<BaseResult>("installed_packages_123_delegate-2", {
      success: true,
      totalTimeMs: 0,
    });
    await packages;
    const hierarchy = h.client["hierarchy"];
    expect(
      hierarchy["sendHierarchyRequest"]({ disableAllFiltering: false, observerMode: false }),
    ).toBe("req_123_delegate-3");
    expect(hierarchy["sendHierarchyIfStaleRequest"](0)).toBe("stale_123_delegate-4");
    expect(hierarchy["sendRecompositionTrackingRequest"](true)).toBe(true);
    expect(JSON.parse(h.socket.frames[4]).requestId).toBe("recomp_123_delegate-5");
    expect(h.client.testHooks.certificates()["buildDeviceCertificatePath"]("/tmp/root.crt")).toBe(
      "/sdcard/Download/automobile/ca_certs/root_123_delegate-6.crt",
    );
    expect(h.manager.getPendingCount()).toBe(0);
  });
});
