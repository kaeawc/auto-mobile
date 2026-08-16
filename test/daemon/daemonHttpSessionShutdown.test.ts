import { afterEach, describe, expect, test } from "bun:test";
import { Daemon } from "../../src/daemon/daemon";
import { DaemonState } from "../../src/daemon/daemonState";

interface ClosableTransport {
  close(): Promise<void>;
}

interface DaemonHttpSessionInternals {
  acceptingHttpSessions: boolean;
  transports: Map<string, ClosableTransport>;
  registerHttpTransport(sessionId: string, transport: ClosableTransport): boolean;
}

class FakeTransport implements ClosableTransport {
  closeCalls = 0;

  async close(): Promise<void> {
    this.closeCalls += 1;
  }
}

describe("Daemon HTTP session shutdown", () => {
  afterEach(() => {
    if (DaemonState.getInstance().isInitialized()) {
      DaemonState.getInstance().reset();
    }
  });

  test("rejects and closes a transport initialized after HTTP admission is quiesced", async () => {
    const daemon = new Daemon({});
    const internals = daemon as unknown as DaemonHttpSessionInternals;
    const transport = new FakeTransport();
    internals.acceptingHttpSessions = false;

    expect(internals.registerHttpTransport("late-session", transport)).toBeFalse();
    await Promise.resolve();

    expect(transport.closeCalls).toBe(1);
    expect(internals.transports.has("late-session")).toBeFalse();
  });

  test("keeps an admitted transport available for shutdown cleanup", () => {
    const daemon = new Daemon({});
    const internals = daemon as unknown as DaemonHttpSessionInternals;
    const transport = new FakeTransport();
    internals.acceptingHttpSessions = true;

    expect(internals.registerHttpTransport("active-session", transport)).toBeTrue();
    expect(internals.transports.get("active-session")).toBe(transport);
    expect(transport.closeCalls).toBe(0);
  });
});
