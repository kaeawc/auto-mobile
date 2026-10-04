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
import { AndroidCtrlProxyManager } from "../../../../src/ctrlProxy/CtrlProxyManager";
import { FakeAdbClientFactory } from "../../../fakes/FakeAdbClientFactory";
import { BootedDevice } from "../../../../src/models";
import {
  FakeWebSocket,
  WebSocketState,
  createInstantFailureWebSocketFactory,
} from "../../../fakes/FakeWebSocket";
import { FakeTimer } from "../../../fakes/FakeTimer";
import { PortManager } from "../../../../src/utils/PortManager";
import { shellQuote } from "../../../../src/utils/shellQuote";
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

  class CleanupAdbExecutor extends FakeAdbExecutor {
    finishCleanup?: () => void;
    cleanupFinished = false;

    constructor(private readonly cleanupMode: "pending" | "throw") {
      super();
    }

    override executeCommand(
      ...args: Parameters<FakeAdbExecutor["executeCommand"]>
    ): ReturnType<FakeAdbExecutor["executeCommand"]> {
      const result = super.executeCommand(...args);
      if (!args[0].startsWith("shell rm -f ")) {
        return result;
      }
      if (this.cleanupMode === "throw") {
        throw new Error("Synchronous cleanup failure");
      }
      return result.then(async (response) => {
        await new Promise<void>((resolve) => {
          this.finishCleanup = resolve;
        });
        this.cleanupFinished = true;
        return response;
      });
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

  const failingClient = (
    certificateFileSystem?: FakeCertificateFileSystem,
  ): AndroidCtrlProxyClient =>
    AndroidCtrlProxyClient.createForTesting(
      testDevice,
      fakeAdb,
      createInstantFailureWebSocketFactory(fakeTimer),
      fakeTimer,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      certificateFileSystem,
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
    const fileUrlResolvedPath = path.join(process.cwd(), "tmp", "my ca's cert.crt");

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
        name: "a file URL with a space and single quote",
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

            expect(fakeAdb.wasCommandExecuted("shell rm -f ")).toBe(false);

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
            const commands = fakeAdb.getExecutedCommands();
            const cleanupCommand = `shell rm -f ${shellQuote(sent.devicePath)}`;
            expect(commands).toContain(cleanupCommand);
            expect(commands.indexOf(cleanupCommand)).toBeGreaterThan(commands.indexOf(push!));
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

    const beginFileInstall = async (timeoutMs = 10000) => {
      const resolvedPath = "/tmp/ca.crt";
      const fakeFileSystem = new FakeCertificateFileSystem();
      fakeFileSystem.setFile(resolvedPath, 128);
      const { client, socket } = await connectClient(fakeFileSystem);
      const baseCount = socket.sentMessages.length;
      const resultPromise = client.requestInstallCaCertificateFromFile(resolvedPath, timeoutMs);
      await waitForSentMessages(socket, baseCount + 1);
      const sent: { devicePath: string; requestId: string } = findSentMessage(
        socket,
        "install_ca_cert_from_path",
      );
      return { client, socket, sent, resultPromise };
    };

    test.each(["timeout", "cancellation"] as const)(
      "cleans up on %s without waiting for a pending removal",
      async function (exit) {
        const cleanupAdb = new CleanupAdbExecutor("pending");
        fakeAdb = cleanupAdb;
        const { client, sent, resultPromise } = await beginFileInstall(25);
        try {
          const observed = resultPromise.then((result) => ({ result }));
          if (exit === "timeout") {
            fakeTimer.advanceTime(26);
          } else {
            await client.close();
          }
          // Observe completion without awaiting a promise that a regressed cleanup might block.
          let completed: Awaited<typeof observed> | undefined;
          const observation = observed.then((value) => {
            completed = value;
          });
          await flushPromises();
          expect(completed?.result.success).toBe(false);
          expect(completed?.result.error).toContain(
            exit === "timeout" ? "timeout after 25ms" : "closed",
          );
          expect(fakeAdb.getExecutedCommands()).toContain(
            `shell rm -f ${shellQuote(sent.devicePath)}`,
          );
          const call = fakeAdb
            .getCommandCalls()
            .find((call) => call.command.startsWith("shell rm -f "));
          expect(call?.timeoutMs).toBe(1500);
          expect(call?.maxBuffer).toBeUndefined();
          expect(call?.noRetry).toBe(true);
          expect(call?.signal?.aborted).toBe(false);
          expect(cleanupAdb.cleanupFinished).toBe(false);
          cleanupAdb.finishCleanup?.();
          await observation;
        } finally {
          cleanupAdb.finishCleanup?.();
          await client.close();
        }
      },
    );

    test("cleans up when connection fails after a successful push", async function () {
      const resolvedPath = "/tmp/ca.crt";
      const fakeFileSystem = new FakeCertificateFileSystem();
      fakeFileSystem.setFile(resolvedPath, 128);
      const client = failingClient(fakeFileSystem);
      try {
        const result = await client.requestInstallCaCertificateFromFile(resolvedPath);
        expect(result.error).toBe("Failed to connect to accessibility service");
        const commands = fakeAdb.getExecutedCommands();
        const push = commands.find((command) => command.startsWith("push "));
        expect(push).toBeDefined();
        const devicePath = push!.slice(push!.lastIndexOf(' "') + 2, -1);
        expect(commands).toContain(`shell rm -f ${shellQuote(devicePath)}`);
      } finally {
        await client.close();
      }
    });

    test("cleans up after an unsuccessful install reply", async function () {
      const { client, socket, sent, resultPromise } = await beginFileInstall();
      try {
        expect(fakeAdb.wasCommandExecuted("shell rm -f ")).toBe(false);
        socket.simulateMessage(
          JSON.stringify({
            type: "ca_cert_result",
            requestId: sent.requestId,
            success: false,
            action: "install",
            totalTimeMs: 3,
            error: "Device owner required",
          }),
        );
        expect(await resultPromise).toMatchObject({
          success: false,
          error: "Device owner required",
        });
        expect(fakeAdb.getExecutedCommands()).toContain(
          `shell rm -f ${shellQuote(sent.devicePath)}`,
        );
      } finally {
        await client.close();
      }
    });

    test.each(["rejection", "synchronous throw"] as const)(
      "cleanup %s preserves the success result with no unhandled rejection",
      async function (failure) {
        if (failure === "synchronous throw") {
          fakeAdb = new CleanupAdbExecutor("throw");
        } else {
          fakeAdb.setCommandError("rm -f", new Error("Cleanup rejected"));
        }
        const unhandled: unknown[] = [];
        const onUnhandled = (error: unknown): void => {
          unhandled.push(error);
        };
        process.on("unhandledRejection", onUnhandled);
        const { client, socket, sent, resultPromise } = await beginFileInstall();
        try {
          const success = {
            success: true,
            action: "install",
            alias: "user-ca-cert",
            totalTimeMs: 3,
          };
          socket.simulateMessage(
            JSON.stringify({ type: "ca_cert_result", requestId: sent.requestId, ...success }),
          );
          const result = await resultPromise;
          await flushPromises();
          expect(result).toEqual({ ...success, error: undefined, perfTiming: undefined });
          expect(fakeAdb.getExecutedCommands()).toContain(
            `shell rm -f ${shellQuote(sent.devicePath)}`,
          );
          expect(unhandled).toEqual([]);
        } finally {
          process.off("unhandledRejection", onUnhandled);
          await client.close();
        }
      },
    );

    test("does not remove a device file when pushing fails", async function () {
      fakeAdb.setCommandError("push ", new Error("Push failed"));
      const resolvedPath = "/tmp/ca.crt";
      const fakeFileSystem = new FakeCertificateFileSystem();
      fakeFileSystem.setFile(resolvedPath, 128);
      const { client, socket } = await connectClient(fakeFileSystem);
      try {
        const result = await client.requestInstallCaCertificateFromFile(resolvedPath);
        expect(result).toMatchObject({ success: false, error: "Push failed" });
        expect(fakeAdb.wasCommandExecuted("push ")).toBe(true);
        expect(fakeAdb.wasCommandExecuted("shell rm ")).toBe(false);
        expect(hasSentMessage(socket, "install_ca_cert_from_path")).toBe(false);
      } finally {
        await client.close();
      }
    });

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

    test("resolves overlapping removals by requestId and clears both pending entries", async function () {
      const { client, socket } = await connectClient();
      try {
        const baseCount = socket.sentMessages.length;
        const firstPromise = client.requestRemoveCaCertificate("first-alias");
        const secondPromise = client.requestRemoveCaCertificate("second-alias");
        await waitForSentMessages(socket, baseCount + 2);

        const sent = socket.sentMessages
          .map((raw) => JSON.parse(raw) as { type?: string; alias?: string; requestId?: string })
          .filter((message) => message.type === "remove_ca_cert");
        const first = sent.find((message) => message.alias === "first-alias");
        const second = sent.find((message) => message.alias === "second-alias");
        expect(first?.requestId).toBeDefined();
        expect(second?.requestId).toBeDefined();
        expect(first?.requestId).not.toBe(second?.requestId);
        expect(client["requestManager"].getPendingCount()).toBe(2);

        socket.simulateMessage(
          JSON.stringify({
            type: "ca_cert_result",
            requestId: second?.requestId,
            success: true,
            action: "remove",
            alias: "second-alias",
            totalTimeMs: 2,
          }),
        );
        socket.simulateMessage(
          JSON.stringify({
            type: "ca_cert_result",
            requestId: first?.requestId,
            success: true,
            action: "remove",
            alias: "first-alias",
            totalTimeMs: 1,
          }),
        );

        const [firstResult, secondResult] = await Promise.all([firstPromise, secondPromise]);
        expect(firstResult.alias).toBe("first-alias");
        expect(secondResult.alias).toBe("second-alias");
        expect(client["requestManager"].getPendingCount()).toBe(0);
      } finally {
        await client.close();
      }
    });

    test("timing out one overlapping removal leaves the other request live", async function () {
      const { client, socket } = await connectClient();
      try {
        const baseCount = socket.sentMessages.length;
        const timedOutPromise = client.requestRemoveCaCertificate("short-timeout", 100);
        const livePromise = client.requestRemoveCaCertificate("long-timeout", 200);
        await waitForSentMessages(socket, baseCount + 2);

        const sent = socket.sentMessages
          .map((raw) => JSON.parse(raw) as { type?: string; alias?: string; requestId?: string })
          .filter((message) => message.type === "remove_ca_cert");
        const live = sent.find((message) => message.alias === "long-timeout");
        expect(client["requestManager"].getPendingCount()).toBe(2);

        fakeTimer.advanceTime(100);
        const timedOut = await timedOutPromise;
        expect(timedOut.success).toBe(false);
        expect(timedOut.error).toContain("timeout after 100ms");
        expect(client["requestManager"].getPendingCount()).toBe(1);

        socket.simulateMessage(
          JSON.stringify({
            type: "ca_cert_result",
            requestId: live?.requestId,
            success: true,
            action: "remove",
            alias: "long-timeout",
            totalTimeMs: 3,
          }),
        );
        const liveResult = await livePromise;
        expect(liveResult.success).toBe(true);
        expect(liveResult.alias).toBe("long-timeout");
        expect(client["requestManager"].getPendingCount()).toBe(0);
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
