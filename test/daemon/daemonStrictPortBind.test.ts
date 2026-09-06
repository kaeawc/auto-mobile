import { afterEach, describe, expect, test } from "bun:test";
import { createServer, type Server } from "node:http";
import { Daemon } from "../../src/daemon/daemon";
import { DaemonState } from "../../src/daemon/daemonState";
import { ActionableError } from "../../src/models/ActionableError";

/**
 * Issue #6260 (PRRT ft82d): `restart()`'s port-availability preflight is a
 * non-atomic probe-then-release check with a window between releasing the
 * probe socket and the child actually binding. `strictPort` closes that
 * TOCTOU by making the child's own `listen()` call — inside
 * `startHttpServer()` — the single, atomic bind-or-fail attempt: no
 * findAvailablePort() fallback to `port + 1..3`, and a genuine EADDRINUSE at
 * bind time must throw an actionable error instead of ever reporting success
 * on a different port.
 */

interface DaemonHttpBindInternals {
  startHttpServer(): Promise<void>;
}

function bindInternals(daemon: Daemon): DaemonHttpBindInternals {
  return daemon as unknown as DaemonHttpBindInternals;
}

async function listenOnEphemeralPort(): Promise<{ server: Server; port: number }> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("Expected an AddressInfo from an ephemeral port bind");
  }
  return { server, port: address.port };
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve) => server.close(() => resolve()));
}

describe("Daemon strict-port bind (issue #6260)", () => {
  afterEach(() => {
    if (DaemonState.getInstance().isInitialized()) {
      DaemonState.getInstance().reset();
    }
  });

  test("strictPort fails loudly with an actionable error when the requested port is taken at bind time", async () => {
    const { server: competitor, port } = await listenOnEphemeralPort();
    const daemon = new Daemon({ port, host: "127.0.0.1", strictPort: true });

    try {
      await expect(bindInternals(daemon).startHttpServer()).rejects.toThrow(ActionableError);
      await expect(bindInternals(daemon).startHttpServer()).rejects.toThrow(
        new RegExp(`Port ${port}.*already in use`),
      );
    } finally {
      await closeServer(competitor);
    }
  });

  test("without strictPort, the same EADDRINUSE surfaces the raw (non-actionable) HTTP server error", async () => {
    const { server: competitor, port } = await listenOnEphemeralPort();
    const daemon = new Daemon({ port, host: "127.0.0.1" });

    try {
      let caught: unknown;
      try {
        await bindInternals(daemon).startHttpServer();
      } catch (error) {
        caught = error;
      }
      expect(caught).toBeDefined();
      expect(caught).not.toBeInstanceOf(ActionableError);
    } finally {
      await closeServer(competitor);
    }
  });

  test("strictPort binds successfully when the requested port is actually free", async () => {
    const { server: probe, port } = await listenOnEphemeralPort();
    await closeServer(probe);
    const daemon = new Daemon({ port, host: "127.0.0.1", strictPort: true });

    await bindInternals(daemon).startHttpServer();

    // Clean up the real listener this test bound.
    await (daemon as unknown as { closeHttpListener(): Promise<void> }).closeHttpListener();
  });
});
