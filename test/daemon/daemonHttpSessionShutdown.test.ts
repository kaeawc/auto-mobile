import { afterEach, describe, expect, test } from "bun:test";
import { Daemon } from "../../src/daemon/daemon";
import { DaemonHandoffInterruptionError } from "../../src/daemon/daemonHandoffInterruption";
import { DaemonState } from "../../src/daemon/daemonState";
import { executionTracker } from "../../src/server/executionTracker";

interface ClosableTransport {
  close(): Promise<void>;
}

interface DaemonHttpSessionInternals {
  acceptingHttpSessions: boolean;
  transports: Map<string, ClosableTransport>;
  registerHttpTransport(sessionId: string, transport: ClosableTransport): boolean;
  socketServer: { quiesce(): Promise<void> } | null;
  quiesceProvisioningIngress(): Promise<void>;
  interruptProvisioningForShutdown(): Promise<void>;
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

  test("interrupts and drains provisioning before the sequential shutdown stages", async () => {
    const daemon = new Daemon({});
    const internals = daemon as unknown as DaemonHttpSessionInternals;
    const execution = executionTracker.startExecution("provisionDevice", "provision-session");
    execution.abortController.signal.addEventListener(
      "abort",
      () => executionTracker.endExecution(execution.id),
      { once: true },
    );

    await internals.interruptProvisioningForShutdown();

    expect(execution.abortController.signal.reason).toBeInstanceOf(DaemonHandoffInterruptionError);
    expect(
      executionTracker.hasActiveToolExecution("provisionDevice", { scope: "global" }),
    ).toBeFalse();
  });

  test("closes HTTP and control-socket provisioning ingress before cancellation", async () => {
    const daemon = new Daemon({});
    const internals = daemon as unknown as DaemonHttpSessionInternals;
    let quiesced = false;
    internals.acceptingHttpSessions = true;
    internals.socketServer = {
      async quiesce() {
        quiesced = true;
      },
    };

    await internals.quiesceProvisioningIngress();

    expect(internals.acceptingHttpSessions).toBeFalse();
    expect(quiesced).toBeTrue();
  });
});
