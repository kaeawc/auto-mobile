import { describe, expect, test, beforeEach } from "bun:test";
import { Duplex } from "node:stream";
import { DaemonClient } from "../../src/daemon/client";
import { McpTimeoutError } from "../../src/daemon/McpTimeoutError";
import {
  DEFAULT_MCP_REQUEST_TIMEOUT_MS,
  MIN_START_DEVICE_MCP_TIMEOUT_MS,
  MIN_UNINSTALL_APP_MCP_TIMEOUT_MS,
  MAX_PROGRESS_EXTENDED_MCP_REQUEST_TIMEOUT_MS,
} from "../../src/daemon/mcpRequestTimeout";
import { PROGRESS_NOTIFICATION_METHOD } from "../../src/daemon/types";
import { FakeTimer } from "../fakes/FakeTimer";

function createBlackHoleSocket(): Duplex {
  return new Duplex({
    read() {},
    write(_chunk, _encoding, callback) {
      callback();
    },
  });
}

function createConnectedClient(fakeTimer: FakeTimer, connectionTimeout = 1000): DaemonClient {
  const client = new DaemonClient("/fake/socket", connectionTimeout, fakeTimer);
  (client as any).connected = true;
  (client as any).socket = createBlackHoleSocket();
  return client;
}

describe("DaemonClient per-request timeout", () => {
  let fakeTimer: FakeTimer;

  beforeEach(() => {
    fakeTimer = new FakeTimer();
  });

  test("startDevice uses MIN_START_DEVICE_MCP_TIMEOUT_MS", async () => {
    const client = createConnectedClient(fakeTimer);

    const promise = client.callTool("startDevice", {});
    fakeTimer.advanceTime(MIN_START_DEVICE_MCP_TIMEOUT_MS);

    try {
      await promise;
      expect.unreachable("should have timed out");
    } catch (err) {
      expect(err).toBeInstanceOf(McpTimeoutError);
      const timeoutErr = err as McpTimeoutError;
      expect(timeoutErr.toolName).toBe("startDevice");
      expect(timeoutErr.timeoutMs).toBe(MIN_START_DEVICE_MCP_TIMEOUT_MS);
      expect(timeoutErr.origin).toBe("DaemonClient.sendRequest");
    } finally {
      await client.close();
    }
  });

  test("uninstallApp uses MIN_UNINSTALL_APP_MCP_TIMEOUT_MS", async () => {
    const client = createConnectedClient(fakeTimer);

    const promise = client.callTool("uninstallApp", { appId: "com.example.app" });
    fakeTimer.advanceTime(MIN_UNINSTALL_APP_MCP_TIMEOUT_MS);

    try {
      await promise;
      expect.unreachable("should have timed out");
    } catch (err) {
      expect(err).toBeInstanceOf(McpTimeoutError);
      const timeoutErr = err as McpTimeoutError;
      expect(timeoutErr.toolName).toBe("uninstallApp");
      expect(timeoutErr.timeoutMs).toBe(MIN_UNINSTALL_APP_MCP_TIMEOUT_MS);
      expect(timeoutErr.origin).toBe("DaemonClient.sendRequest");
    } finally {
      await client.close();
    }
  });

  test("regular tool uses DEFAULT_MCP_REQUEST_TIMEOUT_MS", async () => {
    const client = createConnectedClient(fakeTimer);

    // tapOn has no per-tool floor, so it uses the standard default (unlike observe,
    // launchApp, etc. which carry generous CtrlProxy cold-start floors — #2834).
    const promise = client.callTool("tapOn", {});
    fakeTimer.advanceTime(DEFAULT_MCP_REQUEST_TIMEOUT_MS);

    try {
      await promise;
      expect.unreachable("should have timed out");
    } catch (err) {
      expect(err).toBeInstanceOf(McpTimeoutError);
      const timeoutErr = err as McpTimeoutError;
      expect(timeoutErr.toolName).toBe("tapOn");
      expect(timeoutErr.timeoutMs).toBe(DEFAULT_MCP_REQUEST_TIMEOUT_MS);
      expect(timeoutErr.origin).toBe("DaemonClient.sendRequest");
    } finally {
      await client.close();
    }
  });

  test("startDevice does NOT time out at the old connectionTimeout", async () => {
    const client = createConnectedClient(fakeTimer);

    const promise = client.callTool("startDevice", {});
    fakeTimer.advanceTime(1000);

    let resolved = false;
    promise
      .then(() => {
        resolved = true;
      })
      .catch(() => {
        resolved = true;
      });
    await new Promise((r) => setImmediate(r));
    expect(resolved).toBe(false);

    await client.close();
  });

  test("callDaemonMethod uses McpTimeoutError", async () => {
    const client = createConnectedClient(fakeTimer, 5000);

    const promise = client.callDaemonMethod("daemon/status");
    fakeTimer.advanceTime(5000);

    try {
      await promise;
      expect.unreachable("should have timed out");
    } catch (err) {
      expect(err).toBeInstanceOf(McpTimeoutError);
      const timeoutErr = err as McpTimeoutError;
      expect(timeoutErr.toolName).toBe("daemon/status");
      expect(timeoutErr.timeoutMs).toBe(5000);
      expect(timeoutErr.origin).toBe("DaemonClient.callDaemonMethod");
    } finally {
      await client.close();
    }
  });

  test("connectionTimeout overrides per-tool floor when larger", async () => {
    const client = createConnectedClient(fakeTimer, 300_000);

    const promise = client.callTool("startDevice", {});
    fakeTimer.advanceTime(300_000);

    try {
      await promise;
      expect.unreachable("should have timed out");
    } catch (err) {
      expect(err).toBeInstanceOf(McpTimeoutError);
      const timeoutErr = err as McpTimeoutError;
      expect(timeoutErr.toolName).toBe("startDevice");
      expect(timeoutErr.timeoutMs).toBe(300_000);
    } finally {
      await client.close();
    }
  });
});

/**
 * Transport-level regression for issue #6222 (P1 review): progress must
 * actually keep this client's OWN local pending-request timer alive past a
 * tool's normal deadline, bounded by MAX_PROGRESS_EXTENDED_MCP_REQUEST_TIMEOUT_MS
 * -- and a request that stops progressing, or never progressed at all, must
 * still time out exactly as before. This is independent of, and in addition
 * to, the daemon's own internal deadline/SDK-call extension (socketServer.ts).
 */
describe("DaemonClient per-request timeout is extended by progress, bounded (#6222)", () => {
  let fakeTimer: FakeTimer;

  beforeEach(() => {
    fakeTimer = new FakeTimer();
  });

  function deliverProgress(client: DaemonClient, progressToken: string | number): void {
    const frame =
      JSON.stringify({
        type: "daemon_notification",
        method: PROGRESS_NOTIFICATION_METHOD,
        progressToken,
        progress: 1,
        total: 1,
      }) + "\n";
    (client as any).handleData(Buffer.from(frame));
  }

  test("a request that emits periodic progress survives past its default 30s deadline", async () => {
    const client = createConnectedClient(fakeTimer);
    const progressToken = "progress-survives";

    const promise = client.callTool("setUIState", { fields: [] }, progressToken);
    let settled = false;
    promise.catch(() => {
      settled = true;
    });

    // Advance well past DEFAULT_MCP_REQUEST_TIMEOUT_MS (30s) in steps, feeding
    // a progress tick before each step would otherwise exceed the deadline.
    // Total elapsed: 100s, more than 3x the default.
    for (let i = 0; i < 5; i++) {
      deliverProgress(client, progressToken);
      fakeTimer.advanceTime(20_000);
      await Promise.resolve();
    }

    expect(settled).toBe(false);

    await client.close();
  });

  test("a request that emits progress forever is still killed at the bounded ceiling", async () => {
    const client = createConnectedClient(fakeTimer);
    const progressToken = "progress-forever";

    const promise = client.callTool("setUIState", { fields: [] }, progressToken);

    // Keep progressing indefinitely, well past the ceiling
    // (MAX_PROGRESS_EXTENDED_MCP_REQUEST_TIMEOUT_MS), advancing in steps
    // smaller than the reset window so the timer keeps getting pushed out --
    // but the hard ceiling must still cut it off.
    const stepMs = 20_000;
    const steps = Math.ceil((MAX_PROGRESS_EXTENDED_MCP_REQUEST_TIMEOUT_MS + 120_000) / stepMs);
    for (let i = 0; i < steps; i++) {
      deliverProgress(client, progressToken);
      fakeTimer.advanceTime(stepMs);
      await Promise.resolve();
    }

    try {
      await promise;
      expect.unreachable("a request that never stops progressing must still hit the ceiling");
    } catch (err) {
      expect(err).toBeInstanceOf(McpTimeoutError);
    } finally {
      await client.close();
    }
  });

  test("a non-progressing request still times out at the default -- unaffected by the extension mechanism", async () => {
    const client = createConnectedClient(fakeTimer);

    // No progressToken at all: this call never registers a deadline/progress
    // listener, so it must behave exactly as it did before #6222.
    const promise = client.callTool("tapOn", {});
    fakeTimer.advanceTime(DEFAULT_MCP_REQUEST_TIMEOUT_MS);

    try {
      await promise;
      expect.unreachable("should have timed out");
    } catch (err) {
      expect(err).toBeInstanceOf(McpTimeoutError);
      const timeoutErr = err as McpTimeoutError;
      expect(timeoutErr.timeoutMs).toBe(DEFAULT_MCP_REQUEST_TIMEOUT_MS);
    } finally {
      await client.close();
    }
  });

  test("a progress tick for a DIFFERENT token does not extend an unrelated pending request", async () => {
    const client = createConnectedClient(fakeTimer);

    const promise = client.callTool("tapOn", {}, "this-calls-own-token");
    deliverProgress(client, "some-other-request-token");
    fakeTimer.advanceTime(DEFAULT_MCP_REQUEST_TIMEOUT_MS);

    try {
      await promise;
      expect.unreachable("should have timed out -- the progress tick was for a different call");
    } catch (err) {
      expect(err).toBeInstanceOf(McpTimeoutError);
    } finally {
      await client.close();
    }
  });
});
