import { describe, expect, test } from "bun:test";
import { DaemonRequestNotDeliveredError } from "../../../src/daemon/DaemonRequestNotDeliveredError";
import { DaemonShuttingDownError } from "../../../src/daemon/DaemonShuttingDownError";
import { DaemonUnavailableError, type DaemonClientLike } from "../../../src/daemon/client/client";
import {
  ConnectionRecovery,
  type ConnectionRecoveryPort,
} from "../../../src/daemon/proxy/ConnectionRecovery";
import { DaemonErrorClassifier } from "../../../src/daemon/proxy/DaemonErrorClassifier";
import { DaemonToolOutcomeUnknownError } from "../../../src/daemon/proxy/DaemonToolOutcomeUnknownError";

function harness() {
  const events: string[] = [];
  const client = {} as DaemonClientLike;
  const state = { closing: false, inFlight: 0, handoff: false };
  const port: ConnectionRecoveryPort = {
    isClosing: () => state.closing,
    isConnected: () => true,
    client: () => client,
    isDeadSocket: () => false,
    toolCallsInFlight: () => state.inFlight,
    toolCallsSettled: () => undefined,
    setToolCallsSettled: () => undefined,
    daemonShutdownDisconnect: () => null,
    boundSessionUuid: () => "bound",
    ensureConnected: async () => {
      events.push("connect");
    },
    resetConnection: async () => {
      events.push("reset");
    },
    waitForDaemonShutdownDisconnect: () => {
      events.push("wait-shutdown");
    },
    throwIfBoundSessionFenced: () => undefined,
    boundSessionExpiredError: () => {
      throw new Error("expired");
    },
    fenceBoundSessionUuid: () => undefined,
    hasRecoverableBoundSessionHandoff: () => state.handoff,
    clearRecoverableBoundSessionHandoff: () => {
      state.handoff = false;
      events.push("clear-handoff");
    },
    releaseKeepsBinding: () => false,
  };
  const classifier = new DaemonErrorClassifier({
    structuredSessionNotFound: () => false,
    structuredToolErrorCodes: () => false,
    frontendRegistersTool: () => false,
  });
  return { events, state, recovery: new ConnectionRecovery(port, classifier) };
}

describe("ConnectionRecovery", () => {
  test("runs the operation once on a healthy connection", async () => {
    const { recovery, events } = harness();
    expect(await recovery.withRecoverableReconnect(async () => "ok")).toBe("ok");
    expect(events).toEqual(["connect"]);
  });

  test("refuses while the proxy is closing", async () => {
    const { recovery, state } = harness();
    state.closing = true;
    await expect(recovery.withRecoverableReconnect(async () => "ok")).rejects.toBeInstanceOf(
      DaemonUnavailableError,
    );
  });

  test("reconnects and retries once after a not-delivered failure", async () => {
    const { recovery, events } = harness();
    let calls = 0;
    const result = await recovery.withRecoverableReconnect(
      async () => {
        calls += 1;
        if (calls === 1) {
          throw new DaemonRequestNotDeliveredError("not written");
        }
        return "second";
      },
      undefined,
      false,
      true,
      "tapOn",
    );
    expect(result).toBe("second");
    expect(events).toEqual(["connect", "reset", "connect"]);
  });

  test("never replays a non-idempotent tool that may have run", async () => {
    const { recovery, events } = harness();
    let calls = 0;
    const attempt = recovery.withRecoverableReconnect(
      async () => {
        calls += 1;
        throw new DaemonUnavailableError("socket closed");
      },
      undefined,
      false,
      true,
      "tapOn",
    );
    await expect(attempt).rejects.toBeInstanceOf(DaemonToolOutcomeUnknownError);
    expect(calls).toBe(1);
    expect(events).toEqual(["connect", "reset"]);
  });

  test("keeps the shared connection when calls are in flight and the session is answered not-found", async () => {
    const { recovery, events, state } = harness();
    state.inFlight = 2;
    let calls = 0;
    const result = await recovery.withRecoverableReconnect(async () => {
      calls += 1;
      if (calls === 1) {
        throw new Error("Session not found: abc");
      }
      return "again";
    });
    expect(result).toBe("again");
    expect(events).not.toContain("reset");
  });

  test("a daemon shutdown arms the successor barrier before the retry", async () => {
    const { recovery, events } = harness();
    let calls = 0;
    await recovery.withRecoverableReconnect(async () => {
      calls += 1;
      if (calls === 1) {
        throw new DaemonShuttingDownError(false);
      }
      return "ok";
    });
    expect(events[1]).toBe("wait-shutdown");
  });

  test("clears a recoverable handoff marker once the connection is reset for it", async () => {
    const { recovery, events, state } = harness();
    state.handoff = true;
    await recovery.withRecoverableReconnect(async () => "ok");
    expect(events).toEqual(["reset", "clear-handoff", "connect"]);
  });
});
