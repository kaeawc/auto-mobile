import { afterEach, describe, expect, test } from "bun:test";
import { createServer, type Server, type Socket } from "node:net";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir, platform } from "node:os";
import {
  DaemonClient,
  DaemonUnavailableError,
  toDaemonTransportError,
} from "../../src/daemon/client";
import { DeviceControlTransportError } from "../../src/daemon/deviceControlTransportFailure";

const isWindows = platform() === "win32";

describe("toDaemonTransportError", () => {
  test("wraps a raw transport error as a recoverable DaemonUnavailableError", () => {
    const raw = new Error("read ECONNRESET");
    (raw as NodeJS.ErrnoException).code = "ECONNRESET";

    const wrapped = toDaemonTransportError(raw);

    expect(wrapped).toBeInstanceOf(DaemonUnavailableError);
    // The original transport detail is preserved for diagnostics.
    expect(wrapped.message).toContain("ECONNRESET");
  });

  test("wraps EPIPE and 'socket hang up' the same way", () => {
    for (const message of ["write EPIPE", "socket hang up"]) {
      const wrapped = toDaemonTransportError(new Error(message));
      expect(wrapped).toBeInstanceOf(DaemonUnavailableError);
      expect(wrapped.message).toContain(message);
    }
  });

  test("passes an already-typed DaemonUnavailableError through unchanged", () => {
    const original = new DaemonUnavailableError("Socket connection lost");
    expect(toDaemonTransportError(original)).toBe(original);
  });
});

describe("DaemonClient in-flight request on connection reset (#2737)", () => {
  const tempDirs: string[] = [];
  let server: Server | null = null;

  afterEach(async () => {
    if (server) {
      await new Promise<void>(resolve => server!.close(() => resolve()));
      server = null;
    }
    for (const dir of tempDirs) {
      rmSync(dir, { recursive: true, force: true });
    }
    tempDirs.length = 0;
  });

  // A daemon restart resets every sibling session's live socket. The sibling's
  // in-flight request must reject with a recoverable DaemonUnavailableError (so
  // the proxy reconnects and retries), not a raw ECONNRESET that wedges it.
  (isWindows ? test.skip : test)(
    "rejects the pending request with DaemonUnavailableError when the daemon drops the connection",
    async () => {
      const dir = mkdtempSync(join(tmpdir(), "daemon-transport-test-"));
      tempDirs.push(dir);
      const socketPath = join(dir, "daemon.sock");

      // Server accepts the connection, then drops it the moment the client sends
      // its request — exactly what a dying/restarting daemon does to a sibling's
      // live socket. Over a Unix domain socket this delivers EOF -> "close".
      server = createServer((connection: Socket) => {
        connection.once("data", () => {
          connection.destroy();
        });
      });
      await new Promise<void>(resolve => server!.listen(socketPath, resolve));

      const client = new DaemonClient(socketPath, 2000);
      await client.connect();

      // Must reject promptly with a recoverable DaemonUnavailableError — not hang
      // until the request timeout, and not a raw transport error.
      await expect(client.callDaemonMethod("tools/list", {})).rejects.toBeInstanceOf(
        DaemonUnavailableError
      );

      await client.close();
    }
  );
});

describe("DaemonClient device-control transport response", () => {
  const tempDirs: string[] = [];
  let server: Server | null = null;

  afterEach(async () => {
    if (server) {
      await new Promise<void>(resolve => server!.close(() => resolve()));
      server = null;
    }
    for (const dir of tempDirs) {
      rmSync(dir, { recursive: true, force: true });
    }
    tempDirs.length = 0;
  });

  (isWindows ? test.skip : test)(
    "rehydrates safe transport metadata as a typed error",
    async () => {
      const dir = mkdtempSync(join(tmpdir(), "daemon-transport-payload-test-"));
      tempDirs.push(dir);
      const socketPath = join(dir, "daemon.sock");
      const failure = {
        code: "device_control_transport_failure" as const,
        transport: "daemon_loopback_http" as const,
        toolName: "launchApp",
        deviceId: "emulator-5554",
        deviceSessionUuid: "device-epoch-a",
        sessionUuid: "session-a",
        sessionValid: true,
        phase: "response" as const,
        retryable: false,
        reconnectAttempted: true,
        replayAttempted: false,
      };

      server = createServer((connection: Socket) => {
        connection.once("data", data => {
          const request = JSON.parse(data.toString().trim()) as { id: string };
          connection.write(`${JSON.stringify({
            id: request.id,
            type: "mcp_response",
            success: false,
            error: "Device-control transport closed while handling launchApp",
            transportFailure: failure,
          })}\n`);
        });
      });
      await new Promise<void>(resolve => server!.listen(socketPath, resolve));

      const client = new DaemonClient(socketPath, 2000);
      await client.connect();

      try {
        await client.callTool("launchApp", {
          sessionUuid: "session-a",
          appId: "dev.example",
        });
        throw new Error("Expected launchApp to reject");
      } catch (error) {
        expect(error).toBeInstanceOf(DeviceControlTransportError);
        expect((error as DeviceControlTransportError).failure).toEqual(failure);
      } finally {
        await client.close();
      }
    },
  );
});
