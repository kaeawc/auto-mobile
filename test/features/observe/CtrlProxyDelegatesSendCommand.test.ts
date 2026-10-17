import { describe, expect, test } from "bun:test";
import type WebSocket from "ws";
import { AndroidCtrlProxyClient } from "../../../src/features/observe/android/AndroidCtrlProxyClient";
import { CtrlProxyCertificates } from "../../../src/features/observe/android/CtrlProxyCertificates";
import {
  ctrlProxyRequests,
  serializeCtrlProxyRequest,
  type CtrlProxyRequest,
} from "../../../src/features/observe/android/ctrlProxyProtocol";
import { runWithAbortSignal } from "../../../src/utils/AbortContext";
import { NoOpPerformanceTracker } from "../../../src/utils/PerformanceTracker";
import { CountingIdGenerator } from "../../../src/utils/IdGenerator";
import { FakeAdbExecutor } from "../../fakes/FakeAdbExecutor";
import { FakeInstalledAppsRepository } from "../../fakes/FakeInstalledAppsRepository";
import { FakeTimer } from "../../fakes/FakeTimer";
import { FakeWebSocket } from "../../fakes/FakeWebSocket";

class RecordingSocket extends FakeWebSocket {
  readonly frames: string[] = [];
  sendError?: Error;
  override send(data: string): void {
    if (this.sendError) {
      throw this.sendError;
    }
    super.send(data);
    this.frames.push(data);
  }
}

async function harness() {
  const timer = new FakeTimer();
  const socket = new RecordingSocket("ws://fake", "none", 0, timer);
  const client = AndroidCtrlProxyClient.createForTesting(
    { deviceId: "delegates-send-command", platform: "android", name: "Android", isEmulator: true },
    new FakeAdbExecutor(),
    {
      webSocketFactory: () => socket as unknown as WebSocket,
      timer,
      installedAppsRepository: new FakeInstalledAppsRepository(),
      idGenerator: new CountingIdGenerator("delegate"),
    },
  );
  await Promise.resolve();
  timer.advanceTime(123);
  client["ws"] = socket as unknown as WebSocket;
  const manager = client["requestManager"];
  const ids = new CountingIdGenerator("wire");
  manager.generateId = (prefix) => `${prefix}_${ids.next()}`;
  let connects = 0;
  let cancels = 0;
  client.ensureConnected = async () => {
    connects++;
    return true;
  };
  client["cancelScreenshotBackoff"] = () => {
    cancels++;
  };
  return { client, timer, socket, manager, connects: () => connects, cancels: () => cancels };
}

type Harness = Awaited<ReturnType<typeof harness>>;

async function flushDispatch() {
  for (let i = 0; i < 8; i++) {
    await Promise.resolve();
  }
}

interface Method {
  name: string;
  /** Packages never auto-connect; every other delegate does. */
  autoConnect: boolean;
  invoke: (h: Harness) => Promise<unknown>;
  frame: (requestId: string) => CtrlProxyRequest;
  literal: string;
  response: Record<string, unknown>;
  timeoutMessage: string;
  notConnectedError: string;
}

const certResponse = { type: "ca_cert_result", action: "install", alias: "a" };
const methods: Method[] = [
  {
    name: "requestInstallCaCertificate",
    autoConnect: true,
    invoke: (h) => h.client["certificates"].requestInstallCaCertificate(" PEM ", 50),
    frame: (requestId) => ctrlProxyRequests.installCaCert({ requestId, certificate: "PEM" }),
    literal: '{"type":"install_ca_cert","requestId":"caCertInstall_wire-1","certificate":"PEM"}',
    response: certResponse,
    timeoutMessage: "CA cert install timeout after 50ms",
    notConnectedError: "Failed to connect to accessibility service",
  },
  {
    name: "requestInstallCaCertificateFromFile",
    autoConnect: true,
    invoke: (h) => {
      const certs = new CtrlProxyCertificates(h.client["createCertificatesDelegateContext"](), {
        stat: async () => ({ size: 1, isFile: () => true }),
      });
      certs["pushCertificateToDevice"] = async () => "/sdcard/ca.pem";
      return certs.requestInstallCaCertificateFromFile("/tmp/ca.pem", 50);
    },
    frame: (requestId) =>
      ctrlProxyRequests.installCaCertFromPath({ requestId, devicePath: "/sdcard/ca.pem" }),
    literal:
      '{"type":"install_ca_cert_from_path","requestId":"caCertInstallFromPath_wire-1","devicePath":"/sdcard/ca.pem"}',
    response: certResponse,
    timeoutMessage: "CA cert install timeout after 50ms",
    notConnectedError: "Failed to connect to accessibility service",
  },
  {
    name: "requestRemoveCaCertificate",
    autoConnect: true,
    invoke: (h) => h.client["certificates"].requestRemoveCaCertificate(" alias ", 50),
    frame: (requestId) => ctrlProxyRequests.removeCaCert({ requestId, alias: "alias" }),
    literal: '{"type":"remove_ca_cert","requestId":"caCertRemove_wire-1","alias":"alias"}',
    response: { type: "ca_cert_result", action: "remove" },
    timeoutMessage: "CA cert removal timeout after 50ms",
    notConnectedError: "Failed to connect to accessibility service",
  },
  {
    name: "requestDeviceOwnerStatus",
    autoConnect: true,
    invoke: (h) => h.client["certificates"].requestDeviceOwnerStatus(50),
    frame: (requestId) => ctrlProxyRequests.getDeviceOwnerStatus({ requestId }),
    literal: '{"type":"get_device_owner_status","requestId":"deviceOwnerStatus_wire-1"}',
    response: { type: "device_owner_status_result", isDeviceOwner: false, isAdminActive: false },
    timeoutMessage: "Device owner status timeout after 50ms",
    notConnectedError: "Failed to connect to accessibility service",
  },
  {
    name: "requestPermission",
    autoConnect: true,
    invoke: (h) => h.client["certificates"].requestPermission(" perm ", false, 50),
    frame: (requestId) =>
      ctrlProxyRequests.getPermission({ requestId, permission: "perm", requestPermission: false }),
    literal:
      '{"type":"get_permission","requestId":"permission_wire-1","permission":"perm","requestPermission":false}',
    response: { type: "permission_result", permission: "perm", granted: true },
    timeoutMessage: "Permission request timeout after 50ms",
    notConnectedError: "Failed to connect to accessibility service",
  },
  {
    name: "focus sendAction",
    autoConnect: true,
    invoke: (h) =>
      h.client["focus"]["sendAction"]("focus", "res/id", 50, new NoOpPerformanceTracker()),
    frame: (requestId) =>
      ctrlProxyRequests.requestAction({ requestId, action: "focus", resourceId: "res/id" }),
    literal:
      '{"type":"request_action","requestId":"action_wire-1","action":"focus","resourceId":"res/id"}',
    response: { type: "action_result", action: "focus" },
    timeoutMessage: "Action timeout after 50ms",
    notConnectedError: "Failed to connect to accessibility service",
  },
  {
    name: "requestCurrentFocus",
    autoConnect: true,
    invoke: (h) => h.client["focus"].requestCurrentFocus(50),
    frame: (requestId) => ctrlProxyRequests.getCurrentFocus({ requestId }),
    literal: '{"type":"get_current_focus","requestId":"currentFocus_wire-1"}',
    response: { type: "current_focus_result" },
    timeoutMessage: "Current focus timeout after 50ms",
    notConnectedError: "Failed to connect to accessibility service",
  },
  {
    name: "requestTraversalOrder",
    autoConnect: true,
    invoke: (h) => h.client["focus"].requestTraversalOrder(50),
    frame: (requestId) => ctrlProxyRequests.getTraversalOrder({ requestId }),
    literal: '{"type":"get_traversal_order","requestId":"traversalOrder_wire-1"}',
    response: {
      type: "traversal_order_result",
      result: { elements: [], focusedIndex: null, totalCount: 0 },
    },
    timeoutMessage: "Traversal order timeout after 50ms",
    notConnectedError: "Failed to connect to accessibility service",
  },
  {
    name: "requestInstalledPackages",
    autoConnect: false,
    invoke: (h) => h.client["packages"].requestInstalledPackages(false, 3, 50),
    frame: (requestId) =>
      ctrlProxyRequests.requestInstalledPackages({ requestId, includeSystem: false, userId: 3 }),
    literal:
      '{"type":"request_installed_packages","requestId":"installed_packages_123_delegate-1","includeSystem":false,"userId":3}',
    response: { type: "installed_packages_result", packages: [] },
    timeoutMessage: "Installed packages timeout after 50ms",
    notConnectedError: "WebSocket not connected",
  },
  {
    name: "requestPackageInfo",
    autoConnect: false,
    invoke: (h) => h.client["packages"].requestPackageInfo("pkg", {}, 50),
    frame: (requestId) =>
      ctrlProxyRequests.requestPackageInfo({
        requestId,
        packageName: "pkg",
        includePermissions: true,
      }),
    literal:
      '{"type":"request_package_info","requestId":"package_info_123_delegate-1","packageName":"pkg","includePermissions":true}',
    response: { type: "package_info_result", packageName: "pkg" },
    timeoutMessage: "Package info timeout after 50ms",
    notConnectedError: "WebSocket not connected",
  },
  {
    name: "requestLaunchIntent",
    autoConnect: false,
    invoke: (h) => h.client["packages"].requestLaunchIntent("pkg", 50),
    frame: (requestId) => ctrlProxyRequests.requestLaunchIntent({ requestId, packageName: "pkg" }),
    literal:
      '{"type":"request_launch_intent","requestId":"launch_intent_123_delegate-1","packageName":"pkg"}',
    response: { type: "launch_intent_result", packageName: "pkg" },
    timeoutMessage: "Launch intent timeout after 50ms",
    notConnectedError: "WebSocket not connected",
  },
  {
    name: "requestAddHighlight",
    autoConnect: true,
    invoke: (h) =>
      h.client["highlights"].requestAddHighlight(
        "h1",
        {
          type: "box",
          bounds: { x: 1.4, y: 2.6, width: 3, height: 4, sourceWidth: null, sourceHeight: 5.5 },
        } as never,
        50,
      ),
    frame: (requestId) =>
      ctrlProxyRequests.addHighlight({
        requestId,
        id: "h1",
        shape: {
          type: "box",
          bounds: { x: 1, y: 3, width: 3, height: 4, sourceWidth: null, sourceHeight: 6 },
        } as never,
      }),
    literal:
      '{"type":"add_highlight","requestId":"highlight_wire-1","id":"h1","shape":{"type":"box","bounds":{"x":1,"y":3,"width":3,"height":4,"sourceWidth":null,"sourceHeight":6}}}',
    response: { type: "highlight_response", success: true },
    timeoutMessage: "Highlight request timeout after 50ms",
    notConnectedError: "Failed to connect to accessibility service",
  },
];

for (const method of methods) {
  describe(`${method.name} sendCommand`, () => {
    const id: string = JSON.parse(method.literal).requestId;

    test("sends the literal and builder frame and correlates the reply", async () => {
      const h = await harness();
      h.client["rejectedCommands"].add(JSON.parse(method.literal).type);
      const pending = method.invoke(h);
      await flushDispatch();
      expect(h.socket.frames).toEqual([method.literal]);
      expect(h.socket.frames[0]).toBe(serializeCtrlProxyRequest(method.frame(id)));
      expect(h.connects()).toBe(method.autoConnect ? 1 : 0);
      expect(h.cancels()).toBe(0);
      await h.client["handleWebSocketMessage"](
        JSON.stringify({ ...method.response, requestId: id, success: true, totalTimeMs: 7 }),
      );
      await pending;
      expect(h.manager.getPendingCount()).toBe(0);
      expect(h.timer.getPendingTimeoutCount()).toBe(0);
    });

    test("resolves the typed timeout result", async () => {
      const h = await harness();
      const pending = method.invoke(h);
      await flushDispatch();
      expect(h.manager.getPendingCount()).toBe(1);
      h.timer.advanceTime(50);
      expect(await pending).toMatchObject({ error: method.timeoutMessage });
      expect(h.manager.getPendingCount()).toBe(0);
    });

    test("resolves a typed not-connected result without sending", async () => {
      const h = await harness();
      if (method.autoConnect) {
        h.client.ensureConnected = async () => false;
      } else {
        h.client["ws"] = null;
      }
      expect(await method.invoke(h)).toMatchObject({ error: method.notConnectedError });
      expect(h.socket.frames).toEqual([]);
      expect(h.manager.getPendingCount()).toBe(0);
    });

    test("settles a send failure and a socket close without a pending request", async () => {
      const failed = await harness();
      failed.socket.sendError = new Error("send failed");
      expect(await method.invoke(failed)).toMatchObject({
        error: expect.stringContaining("send failed"),
      });
      expect(failed.manager.getPendingCount()).toBe(0);

      const closed = await harness();
      const pending = method.invoke(closed);
      await flushDispatch();
      await closed.client.close();
      await pending;
      expect(closed.manager.getPendingCount()).toBe(0);
    });

    test("is not cancelled by an ambient abort (cleanup paths stay uncancellable)", async () => {
      const h = await harness();
      const controller = new AbortController();
      controller.abort(new Error("cancelled"));
      const pending = runWithAbortSignal(controller.signal, () => method.invoke(h));
      await flushDispatch();
      expect(h.socket.frames).toEqual([method.literal]);
      await h.client["handleWebSocketMessage"](
        JSON.stringify({ ...method.response, requestId: id, success: true, totalTimeMs: 7 }),
      );
      await pending;
      expect(h.manager.getPendingCount()).toBe(0);
    });
  });
}
