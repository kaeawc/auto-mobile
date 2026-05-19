import { describe, expect, test, beforeEach } from "bun:test";
import { Duplex } from "node:stream";
import { DaemonClient } from "../../src/daemon/client";
import { McpTimeoutError } from "../../src/daemon/McpTimeoutError";
import { MIN_START_DEVICE_MCP_TIMEOUT_MS, DEFAULT_MCP_REQUEST_TIMEOUT_MS } from "../../src/daemon/mcpRequestTimeout";
import { FakeTimer } from "../fakes/FakeTimer";

function createBlackHoleSocket(): Duplex {
  return new Duplex({
    read() {},
    write(_chunk, _encoding, callback) { callback(); },
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

  test("regular tool uses DEFAULT_MCP_REQUEST_TIMEOUT_MS", async () => {
    const client = createConnectedClient(fakeTimer);

    const promise = client.callTool("observe", {});
    fakeTimer.advanceTime(DEFAULT_MCP_REQUEST_TIMEOUT_MS);

    try {
      await promise;
      expect.unreachable("should have timed out");
    } catch (err) {
      expect(err).toBeInstanceOf(McpTimeoutError);
      const timeoutErr = err as McpTimeoutError;
      expect(timeoutErr.toolName).toBe("observe");
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
    promise.then(() => { resolved = true; }).catch(() => { resolved = true; });
    await new Promise(r => setImmediate(r));
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

  test("regular tool honors connectionTimeout when larger than default", async () => {
    const client = createConnectedClient(fakeTimer, 300_000);

    const promise = client.callTool("observe", {});
    // Should NOT time out at the default 30s
    fakeTimer.advanceTime(DEFAULT_MCP_REQUEST_TIMEOUT_MS);

    let resolved = false;
    promise.then(() => { resolved = true; }).catch(() => { resolved = true; });
    await new Promise(r => setImmediate(r));
    expect(resolved).toBe(false);

    // Should time out at the configured connectionTimeout (300s)
    fakeTimer.advanceTime(300_000 - DEFAULT_MCP_REQUEST_TIMEOUT_MS);

    try {
      await promise;
      expect.unreachable("should have timed out");
    } catch (err) {
      expect(err).toBeInstanceOf(McpTimeoutError);
      const timeoutErr = err as McpTimeoutError;
      expect(timeoutErr.toolName).toBe("observe");
      expect(timeoutErr.timeoutMs).toBe(300_000);
    } finally {
      await client.close();
    }
  });

  test("connect timeout cleared via timer does not fire after successful connect", async () => {
    const client = new DaemonClient("/fake/socket", 5000, fakeTimer);

    // Simulate a successful connect by directly setting connected state
    // This mirrors what happens when createConnection callback fires
    (client as any).connected = true;
    (client as any).socket = createBlackHoleSocket();

    // The connect timeout was scheduled on fakeTimer; after clearing it,
    // advancing past the timeout duration should NOT reject/destroy anything
    const promise = client.callTool("observe", {});
    // Advance well past what would have been the connect timeout
    fakeTimer.advanceTime(5000);

    // The request should still be pending (not errored from connect timeout)
    let settled = false;
    promise.then(() => { settled = true; }).catch(() => { settled = true; });
    await new Promise(r => setImmediate(r));

    // Since we used a connectionTimeout of 5000 and DEFAULT is 30000,
    // the tool timeout is max(30000, 5000) = 30000 - so at 5000ms it's still pending
    expect(settled).toBe(false);

    await client.close();
  });
});
