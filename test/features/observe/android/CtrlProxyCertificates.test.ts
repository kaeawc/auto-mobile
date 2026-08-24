/**
 * Wire-driven tests for the CtrlProxyCertificates delegate, exercised through AndroidCtrlProxyClient.
 *
 * The delegate owns CA certificate install/remove (device-owner only), device-owner status, and
 * permission queries. Each public method: (1) validates its input, (2) ensures a WebSocket
 * connection, (3) sends a typed request and awaits the runner's result frame. These tests drive the
 * real socket — asserting the request that goes out AND the result that comes back — so a cert
 * installed under the wrong alias, a permission reported granted on a timeout, or a cert pushed for a
 * nonexistent host file fails a test rather than silently shipping.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { AndroidCtrlProxyClient } from "../../../../src/features/observe/android";
import { NavigationGraphManager } from "../../../../src/features/navigation/NavigationGraphManager";
import { FakeAdbExecutor } from "../../../fakes/FakeAdbExecutor";
import { AndroidCtrlProxyManager } from "../../../../src/utils/CtrlProxyManager";
import { FakeAdbClientFactory } from "../../../fakes/FakeAdbClientFactory";
import { BootedDevice } from "../../../../src/models";
import {
  FakeWebSocket,
  WebSocketState,
  createInstantFailureWebSocketFactory,
} from "../../../fakes/FakeWebSocket";
import { FakeTimer } from "../../../fakes/FakeTimer";
import { PortManager } from "../../../../src/utils/PortManager";
import { DAEMON_LAUNCH_CWD_ENV } from "../../../../src/utils/workingDirectory";

describe("CtrlProxyCertificates (Android)", function () {
  let fakeAdb: FakeAdbExecutor;
  let testDevice: BootedDevice;
  // Manual (non-auto-advance) timer: request timeouts must NOT auto-fire and preempt the wire result
  // frames we emit. Timeout tests advance the clock explicitly.
  let fakeTimer: FakeTimer;
  const serverPort: number = 8765;

  beforeEach(function () {
    fakeTimer = new FakeTimer();
    PortManager.setPortAvailabilityCheckerForTesting({ isPortAvailable: () => true });

    fakeAdb = new FakeAdbExecutor();
    fakeAdb.setCommandResponse("forward", { stdout: `${serverPort}`, stderr: "" });
    fakeAdb.setScreenState(true);

    testDevice = {
      deviceId: "test-device-certs",
      platform: "android",
      isEmulator: true,
      name: "Test Device",
    };

    AndroidCtrlProxyManager.resetInstances();
    AndroidCtrlProxyClient.resetInstances();
    AndroidCtrlProxyManager.getInstance(
      testDevice,
      new FakeAdbClientFactory(),
    ).clearAvailabilityCache();
  });

  afterEach(function () {
    NavigationGraphManager.getInstance();
    PortManager.setPortAvailabilityCheckerForTesting(null);
  });

  class CapturingWebSocket extends FakeWebSocket {
    sentMessages: string[] = [];
    send(data: any): void {
      this.sentMessages.push(data.toString());
      super.send(data);
    }
  }

  class FakeCertificateFileSystem {
    readonly statCalls: string[] = [];
    private readonly files = new Map<string, { size: number; isFile: boolean }>();

    setFile(filePath: string, size: number, isFile = true): void {
      this.files.set(filePath, { size, isFile });
    }

    async stat(filePath: string): Promise<{ size: number; isFile(): boolean }> {
      this.statCalls.push(filePath);
      const file = this.files.get(filePath);
      if (!file) {
        throw new Error(`File not found: ${filePath}`);
      }
      return {
        size: file.size,
        isFile: () => file.isFile,
      };
    }
  }

  const createCapturingFactory = (
    timer: FakeTimer,
  ): {
    factory: (url: string) => CapturingWebSocket;
    getSocket: () => CapturingWebSocket | null;
  } => {
    let socket: CapturingWebSocket | null = null;
    return {
      factory: (url: string) => {
        socket = new CapturingWebSocket(url, "none", 0, timer);
        return socket;
      },
      getSocket: () => socket,
    };
  };

  const waitForSocketOpen = async (socket: FakeWebSocket | null): Promise<void> => {
    if (!socket || socket.readyState === WebSocketState.OPEN) {
      return;
    }
    await new Promise<void>((resolve) => socket.once("open", () => resolve()));
  };

  const waitForSocket = async (
    getSocket: () => CapturingWebSocket | null,
  ): Promise<CapturingWebSocket | null> => {
    for (let i = 0; i < 5; i++) {
      const s = getSocket();
      if (s) {
        return s;
      }
      await new Promise((r) => setImmediate(r));
    }
    return getSocket();
  };

  const waitForSentMessages = async (
    socket: CapturingWebSocket | null,
    minCount = 1,
  ): Promise<void> => {
    if (!socket) {
      return;
    }
    for (let i = 0; i < 10; i++) {
      if (socket.sentMessages.length >= minCount) {
        return;
      }
      await new Promise((r) => setImmediate(r));
    }
  };

  const flushPromises = async (iterations = 5): Promise<void> => {
    for (let i = 0; i < iterations; i++) {
      await new Promise((r) => setImmediate(r));
    }
  };

  const findSentMessage = (socket: CapturingWebSocket, type: string): any => {
    for (let i = socket.sentMessages.length - 1; i >= 0; i--) {
      try {
        const parsed = JSON.parse(socket.sentMessages[i]);
        if (parsed.type === type) {
          return parsed;
        }
      } catch {
        // skip non-JSON control frames
      }
    }
    throw new Error(`No message of type ${type} in: ${socket.sentMessages.join(", ")}`);
  };

  const hasSentMessage = (socket: CapturingWebSocket, type: string): boolean =>
    socket.sentMessages.some((raw) => {
      try {
        return JSON.parse(raw).type === type;
      } catch {
        return false;
      }
    });

  /** Connect a capturing client and return the client + its socket. */
  const connectClient = async (
    certificateFileSystem?: FakeCertificateFileSystem,
  ): Promise<{
    client: AndroidCtrlProxyClient;
    socket: CapturingWebSocket;
  }> => {
    const { factory, getSocket } = createCapturingFactory(fakeTimer);
    const client = AndroidCtrlProxyClient.createForTesting(
      testDevice,
      fakeAdb,
      factory,
      fakeTimer,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      certificateFileSystem,
    );
    await client.ensureConnected();
    const socket = await waitForSocket(getSocket);
    await waitForSocketOpen(socket);
    if (!socket) {
      throw new Error("Expected capturing CtrlProxy socket");
    }
    return { client, socket };
  };

  const failingClient = (): AndroidCtrlProxyClient =>
    AndroidCtrlProxyClient.createForTesting(
      testDevice,
      fakeAdb,
      createInstantFailureWebSocketFactory(fakeTimer),
      fakeTimer,
    );

  // ===========================================================================
  // requestInstallCaCertificate
  // ===========================================================================

  describe("requestInstallCaCertificate", function () {
    test("sends install_ca_cert and resolves with the installed alias on success", async function () {
      const { client, socket } = await connectClient();
      try {
        const baseCount = socket.sentMessages.length;
        const resultPromise = client.requestInstallCaCertificate("PEMDATA");
        await waitForSentMessages(socket, baseCount + 1);

        const sent = findSentMessage(socket, "install_ca_cert");
        expect(sent.certificate).toBe("PEMDATA");

        socket.simulateMessage(
          JSON.stringify({
            type: "ca_cert_result",
            requestId: sent.requestId,
            success: true,
            action: "install",
            alias: "user-alias-123",
            totalTimeMs: 5,
          }),
        );

        const result = await resultPromise;
        expect(result.success).toBe(true);
        expect(result.action).toBe("install");
        expect(result.alias).toBe("user-alias-123");
      } finally {
        await client.close();
      }
    });

    test("rejects an empty certificate payload without sending a request", async function () {
      const { client, socket } = await connectClient();
      try {
        const result = await client.requestInstallCaCertificate("");
        expect(result.success).toBe(false);
        expect(result.error).toContain("Certificate payload is required");
        expect(hasSentMessage(socket, "install_ca_cert")).toBe(false);
      } finally {
        await client.close();
      }
    });

    test("rejects a whitespace-only certificate payload", async function () {
      const { client, socket } = await connectClient();
      try {
        const result = await client.requestInstallCaCertificate("   \n  ");
        expect(result.success).toBe(false);
        expect(result.error).toContain("Certificate payload is required");
        expect(hasSentMessage(socket, "install_ca_cert")).toBe(false);
      } finally {
        await client.close();
      }
    });

    test("surfaces the device error when installation fails", async function () {
      const { client, socket } = await connectClient();
      try {
        const baseCount = socket.sentMessages.length;
        const resultPromise = client.requestInstallCaCertificate("PEMDATA");
        await waitForSentMessages(socket, baseCount + 1);
        const sent = findSentMessage(socket, "install_ca_cert");

        socket.simulateMessage(
          JSON.stringify({
            type: "ca_cert_result",
            requestId: sent.requestId,
            success: false,
            action: "install",
            error: "Device is not a device owner",
            totalTimeMs: 2,
          }),
        );

        const result = await resultPromise;
        expect(result.success).toBe(false);
        expect(result.error).toContain("device owner");
        expect(result.alias).toBeUndefined();
      } finally {
        await client.close();
      }
    });

    test("returns a connection error when the socket cannot connect", async function () {
      const client = failingClient();
      try {
        const result = await client.requestInstallCaCertificate("PEMDATA");
        expect(result.success).toBe(false);
        expect(result.error).toMatch(/connect/i);
      } finally {
        await client.close();
      }
    });
  });

  // ===========================================================================
  // requestInstallCaCertificateFromFile
  // ===========================================================================

  describe("requestInstallCaCertificateFromFile", function () {
    const relativeCertificatePath = path.join("fixtures", "certs", "relative ca.crt");
    const daemonLaunchCwd = path.join(process.cwd(), "tmp", "automobile-launch");
    const relativeResolvedPath = path.join(daemonLaunchCwd, relativeCertificatePath);
    const fileUrlResolvedPath = path.join(process.cwd(), "tmp", "automobile ca.crt");

    test("rejects an empty path without touching the device", async function () {
      const { client, socket } = await connectClient();
      try {
        const result = await client.requestInstallCaCertificateFromFile("   ");
        expect(result.success).toBe(false);
        expect(result.error).toContain("valid host file path");
        expect(fakeAdb.getExecutedCommands().some((c) => c.startsWith("push"))).toBe(false);
        expect(hasSentMessage(socket, "install_ca_cert_from_path")).toBe(false);
      } finally {
        await client.close();
      }
    });

    test("rejects an on-device sdcard path (not a host file)", async function () {
      const { client } = await connectClient();
      try {
        const result = await client.requestInstallCaCertificateFromFile("/sdcard/Download/ca.crt");
        expect(result.success).toBe(false);
        expect(result.error).toContain("valid host file path");
        expect(fakeAdb.getExecutedCommands().some((c) => c.startsWith("push"))).toBe(false);
      } finally {
        await client.close();
      }
    });

    test("rejects a content:// path", async function () {
      const { client } = await connectClient();
      try {
        const result = await client.requestInstallCaCertificateFromFile(
          "content://downloads/ca.crt",
        );
        expect(result.success).toBe(false);
        expect(result.error).toContain("valid host file path");
        expect(fakeAdb.getExecutedCommands().some((c) => c.startsWith("push"))).toBe(false);
      } finally {
        await client.close();
      }
    });

    test("does not push a certificate for a nonexistent host file", async function () {
      const { client, socket } = await connectClient();
      try {
        const missing = `/tmp/automobile-cert-does-not-exist-${Date.now()}.crt`;
        const result = await client.requestInstallCaCertificateFromFile(missing);
        expect(result.success).toBe(false);
        // Never pushed the file and never asked the runner to install it.
        expect(fakeAdb.getExecutedCommands().some((c) => c.startsWith("push"))).toBe(false);
        expect(hasSentMessage(socket, "install_ca_cert_from_path")).toBe(false);
      } finally {
        await client.close();
      }
    });

    test.each([
      {
        name: "a relative path from the daemon launch directory",
        certificatePath: relativeCertificatePath,
        resolvedPath: relativeResolvedPath,
        daemonLaunchCwd,
      },
      {
        name: "a file URL",
        certificatePath: pathToFileURL(fileUrlResolvedPath).href,
        resolvedPath: fileUrlResolvedPath,
        daemonLaunchCwd: undefined,
      },
    ])(
      "pushes $name and resolves the install result over the wire",
      async function ({ certificatePath, resolvedPath, daemonLaunchCwd }) {
        const previousLaunchCwd = process.env[DAEMON_LAUNCH_CWD_ENV];
        if (daemonLaunchCwd !== undefined) {
          process.env[DAEMON_LAUNCH_CWD_ENV] = daemonLaunchCwd;
        }

        try {
          const fakeFileSystem = new FakeCertificateFileSystem();
          fakeFileSystem.setFile(resolvedPath, 128);
          const { client, socket } = await connectClient(fakeFileSystem);
          try {
            const baseCount = socket.sentMessages.length;
            const resultPromise = client.requestInstallCaCertificateFromFile(certificatePath);
            await waitForSentMessages(socket, baseCount + 1);

            const sent = findSentMessage(socket, "install_ca_cert_from_path");
            expect(fakeFileSystem.statCalls).toEqual([resolvedPath]);

            const push = fakeAdb
              .getExecutedCommands()
              .find((command) => command.startsWith("push "));
            expect(push?.replace(/\\\\/g, "\\")).toContain(`"${resolvedPath}"`);
            expect(push).toEndWith(`"${sent.devicePath}"`);

            socket.simulateMessage(
              JSON.stringify({
                type: "ca_cert_result",
                requestId: sent.requestId,
                success: true,
                action: "install",
                alias: "user-ca-cert",
                totalTimeMs: 3,
              }),
            );

            const result = await resultPromise;
            expect(result).toMatchObject({
              success: true,
              action: "install",
              alias: "user-ca-cert",
            });
          } finally {
            await client.close();
          }
        } finally {
          if (previousLaunchCwd === undefined) {
            delete process.env[DAEMON_LAUNCH_CWD_ENV];
          } else {
            process.env[DAEMON_LAUNCH_CWD_ENV] = previousLaunchCwd;
          }
        }
      },
    );

    test("rejects an empty certificate file before pushing or sending a wire request", async function () {
      const resolvedPath = "/tmp/empty-ca.crt";
      const fakeFileSystem = new FakeCertificateFileSystem();
      fakeFileSystem.setFile(resolvedPath, 0);
      const { client, socket } = await connectClient(fakeFileSystem);
      try {
        const result = await client.requestInstallCaCertificateFromFile(resolvedPath);

        expect(result.success).toBe(false);
        expect(result.error).toContain("Certificate file is empty");
        expect(fakeFileSystem.statCalls).toEqual([resolvedPath]);
        expect(fakeAdb.getExecutedCommands().some((command) => command.startsWith("push "))).toBe(
          false,
        );
        expect(hasSentMessage(socket, "install_ca_cert_from_path")).toBe(false);
      } finally {
        await client.close();
      }
    });
  });

  // ===========================================================================
  // requestRemoveCaCertificate
  // ===========================================================================

  describe("requestRemoveCaCertificate", function () {
    test("sends remove_ca_cert and resolves via the delegate handler on success", async function () {
      const { client, socket } = await connectClient();
      try {
        const baseCount = socket.sentMessages.length;
        const resultPromise = client.requestRemoveCaCertificate("user-alias-123");
        await waitForSentMessages(socket, baseCount + 1);

        const sent = findSentMessage(socket, "remove_ca_cert");
        expect(sent.alias).toBe("user-alias-123");

        socket.simulateMessage(
          JSON.stringify({
            type: "ca_cert_result",
            requestId: sent.requestId,
            success: true,
            action: "remove",
            alias: "user-alias-123",
            totalTimeMs: 4,
          }),
        );

        const result = await resultPromise;
        expect(result.success).toBe(true);
        expect(result.action).toBe("remove");
      } finally {
        await client.close();
      }
    });

    test("rejects an empty alias without sending a request", async function () {
      const { client, socket } = await connectClient();
      try {
        const result = await client.requestRemoveCaCertificate("  ");
        expect(result.success).toBe(false);
        expect(result.error).toContain("alias is required");
        expect(hasSentMessage(socket, "remove_ca_cert")).toBe(false);
      } finally {
        await client.close();
      }
    });

    test("surfaces the device error when removal fails", async function () {
      const { client, socket } = await connectClient();
      try {
        const baseCount = socket.sentMessages.length;
        const resultPromise = client.requestRemoveCaCertificate("user-alias-123");
        await waitForSentMessages(socket, baseCount + 1);
        const sent = findSentMessage(socket, "remove_ca_cert");

        socket.simulateMessage(
          JSON.stringify({
            type: "ca_cert_result",
            requestId: sent.requestId,
            success: false,
            action: "remove",
            error: "Alias not found",
            totalTimeMs: 1,
          }),
        );

        const result = await resultPromise;
        expect(result.success).toBe(false);
        expect(result.error).toContain("Alias not found");
      } finally {
        await client.close();
      }
    });

    test("returns a connection error when the socket cannot connect", async function () {
      const client = failingClient();
      try {
        const result = await client.requestRemoveCaCertificate("user-alias-123");
        expect(result.success).toBe(false);
        expect(result.error).toMatch(/connect/i);
      } finally {
        await client.close();
      }
    });
  });

  // ===========================================================================
  // requestDeviceOwnerStatus
  // ===========================================================================

  describe("requestDeviceOwnerStatus", function () {
    test("sends get_device_owner_status and resolves with owner/admin flags", async function () {
      const { client, socket } = await connectClient();
      try {
        const baseCount = socket.sentMessages.length;
        const resultPromise = client.requestDeviceOwnerStatus();
        await waitForSentMessages(socket, baseCount + 1);
        const sent = findSentMessage(socket, "get_device_owner_status");

        socket.simulateMessage(
          JSON.stringify({
            type: "device_owner_status_result",
            requestId: sent.requestId,
            success: true,
            isDeviceOwner: true,
            isAdminActive: true,
            packageName: "com.example.owner",
            totalTimeMs: 3,
          }),
        );

        const result = await resultPromise;
        expect(result.success).toBe(true);
        expect(result.isDeviceOwner).toBe(true);
        expect(result.isAdminActive).toBe(true);
        expect(result.packageName).toBe("com.example.owner");
      } finally {
        await client.close();
      }
    });

    test("reports a non-owner device", async function () {
      const { client, socket } = await connectClient();
      try {
        const baseCount = socket.sentMessages.length;
        const resultPromise = client.requestDeviceOwnerStatus();
        await waitForSentMessages(socket, baseCount + 1);
        const sent = findSentMessage(socket, "get_device_owner_status");

        socket.simulateMessage(
          JSON.stringify({
            type: "device_owner_status_result",
            requestId: sent.requestId,
            success: true,
            isDeviceOwner: false,
            isAdminActive: false,
            totalTimeMs: 3,
          }),
        );

        const result = await resultPromise;
        expect(result.success).toBe(true);
        expect(result.isDeviceOwner).toBe(false);
        expect(result.isAdminActive).toBe(false);
      } finally {
        await client.close();
      }
    });

    test("returns a connection error when the socket cannot connect", async function () {
      const client = failingClient();
      try {
        const result = await client.requestDeviceOwnerStatus();
        expect(result.success).toBe(false);
        expect(result.isDeviceOwner).toBe(false);
        expect(result.error).toMatch(/connect/i);
      } finally {
        await client.close();
      }
    });
  });

  // ===========================================================================
  // requestPermission
  // ===========================================================================

  describe("requestPermission", function () {
    test("sends get_permission and resolves granted", async function () {
      const { client, socket } = await connectClient();
      try {
        const baseCount = socket.sentMessages.length;
        const resultPromise = client.requestPermission("android.permission.CAMERA", true);
        await waitForSentMessages(socket, baseCount + 1);

        const sent = findSentMessage(socket, "get_permission");
        expect(sent.permission).toBe("android.permission.CAMERA");
        expect(sent.requestPermission).toBe(true);

        socket.simulateMessage(
          JSON.stringify({
            type: "permission_result",
            requestId: sent.requestId,
            success: true,
            permission: "android.permission.CAMERA",
            granted: true,
            requestLaunched: true,
            canRequest: true,
            requiresSettings: false,
            totalTimeMs: 6,
          }),
        );

        const result = await resultPromise;
        expect(result.success).toBe(true);
        expect(result.granted).toBe(true);
        expect(result.permission).toBe("android.permission.CAMERA");
      } finally {
        await client.close();
      }
    });

    test("rejects an empty permission name without sending a request", async function () {
      const { client, socket } = await connectClient();
      try {
        const result = await client.requestPermission("   ");
        expect(result.success).toBe(false);
        expect(result.granted).toBe(false);
        expect(result.error).toContain("Permission name is required");
        expect(hasSentMessage(socket, "get_permission")).toBe(false);
      } finally {
        await client.close();
      }
    });

    test("reports a not-granted permission that requires settings", async function () {
      const { client, socket } = await connectClient();
      try {
        const baseCount = socket.sentMessages.length;
        const resultPromise = client.requestPermission("android.permission.SYSTEM_ALERT_WINDOW");
        await waitForSentMessages(socket, baseCount + 1);
        const sent = findSentMessage(socket, "get_permission");

        socket.simulateMessage(
          JSON.stringify({
            type: "permission_result",
            requestId: sent.requestId,
            success: true,
            permission: "android.permission.SYSTEM_ALERT_WINDOW",
            granted: false,
            requestLaunched: false,
            canRequest: false,
            requiresSettings: true,
            totalTimeMs: 6,
          }),
        );

        const result = await resultPromise;
        expect(result.success).toBe(true);
        expect(result.granted).toBe(false);
        expect(result.requiresSettings).toBe(true);
      } finally {
        await client.close();
      }
    });

    test("returns success:false (not a granted permission) when the request times out", async function () {
      const { client, socket } = await connectClient();
      try {
        const baseCount = socket.sentMessages.length;
        const resultPromise = client.requestPermission("android.permission.CAMERA", true, 50);
        await waitForSentMessages(socket, baseCount + 1);

        // Never answer; advance past the request timeout so the RequestManager resolves the failure.
        await fakeTimer.advanceTimersByTimeAsync(60);
        await flushPromises();

        const result = await resultPromise;
        expect(result.success).toBe(false);
        expect(result.granted).toBe(false);
        expect(result.error).toMatch(/timeout/i);
      } finally {
        await client.close();
      }
    });

    test("returns a connection error when the socket cannot connect", async function () {
      const client = failingClient();
      try {
        const result = await client.requestPermission("android.permission.CAMERA");
        expect(result.success).toBe(false);
        expect(result.granted).toBe(false);
        expect(result.error).toMatch(/connect/i);
      } finally {
        await client.close();
      }
    });
  });
});
