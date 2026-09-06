import { EventEmitter } from "node:events";
import type { Server as HttpServer } from "node:http";
import { afterEach, describe, expect, test } from "bun:test";
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
 *
 * These tests fake the bind/port-availability seam (an injected
 * `httpServerFactory`) instead of racing a real OS port: reclaiming an
 * ephemeral port after releasing it is inherently non-deterministic under
 * concurrent test runs (PRRT fuUIK), so the fake server's `listen()` decides
 * synchronously-via-microtask whether the bind succeeds or reports
 * EADDRINUSE, with no real socket involved.
 */

interface DaemonHttpBindInternals {
  startHttpServer(): Promise<void>;
  closeHttpListener(): Promise<void>;
}

function bindInternals(daemon: Daemon): DaemonHttpBindInternals {
  return daemon as unknown as DaemonHttpBindInternals;
}

/**
 * Minimal fake standing in for `node:http`'s `Server` at the one seam
 * `startHttpServer()` actually exercises: `listen()`, the `"error"` event,
 * and `close()`. `outcome` decides deterministically whether the fake bind
 * succeeds or reports the requested port as already in use — no real socket
 * is ever opened, so there is nothing for a competing process to race.
 */
class FakeBindServer extends EventEmitter {
  listening = false;
  requestTimeout = 0;
  headersTimeout = 0;
  timeout = 0;

  constructor(private readonly outcome: "bind-ok" | "bind-refused") {
    super();
  }

  listen(_port: number, _host: string, callback: () => void): this {
    queueMicrotask(() => {
      if (this.outcome === "bind-ok") {
        this.listening = true;
        callback();
      } else {
        const error = new Error("bind EADDRINUSE") as NodeJS.ErrnoException;
        error.code = "EADDRINUSE";
        this.emit("error", error);
      }
    });
    return this;
  }

  close(callback?: (error?: Error) => void): this {
    this.listening = false;
    callback?.();
    return this;
  }
}

function daemonWithFakeHttpServer(
  options: ConstructorParameters<typeof Daemon>[0],
  outcome: "bind-ok" | "bind-refused",
): Daemon {
  return new Daemon(
    options,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    () => new FakeBindServer(outcome) as unknown as HttpServer,
  );
}

describe("Daemon strict-port bind (issue #6260)", () => {
  afterEach(() => {
    if (DaemonState.getInstance().isInitialized()) {
      DaemonState.getInstance().reset();
    }
  });

  test("strictPort fails loudly with an actionable error when the fake bind reports the port is taken", async () => {
    const port = 54321;
    const daemon = daemonWithFakeHttpServer(
      { port, host: "127.0.0.1", strictPort: true },
      "bind-refused",
    );

    await expect(bindInternals(daemon).startHttpServer()).rejects.toThrow(ActionableError);

    const daemonAgain = daemonWithFakeHttpServer(
      { port, host: "127.0.0.1", strictPort: true },
      "bind-refused",
    );
    await expect(bindInternals(daemonAgain).startHttpServer()).rejects.toThrow(
      new RegExp(`Port ${port}.*already in use`),
    );
  });

  test("without strictPort, the same fake EADDRINUSE surfaces the raw (non-actionable) HTTP server error", async () => {
    const port = 54322;
    const daemon = daemonWithFakeHttpServer({ port, host: "127.0.0.1" }, "bind-refused");

    let caught: unknown;
    try {
      await bindInternals(daemon).startHttpServer();
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeDefined();
    expect(caught).not.toBeInstanceOf(ActionableError);
  });

  test("strictPort binds using exactly the requested port when the fake bind succeeds", async () => {
    const port = 54323;
    const daemon = daemonWithFakeHttpServer(
      { port, host: "127.0.0.1", strictPort: true },
      "bind-ok",
    );

    await bindInternals(daemon).startHttpServer();

    // No port+1..3 fallback: the daemon must still be configured for the
    // exact requested port, not a substitute one.
    expect((daemon as unknown as { port: number }).port).toBe(port);

    await bindInternals(daemon).closeHttpListener();
  });
});
