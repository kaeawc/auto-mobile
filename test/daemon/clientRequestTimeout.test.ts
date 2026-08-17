import { describe, expect, test, beforeEach } from "bun:test";
import { Duplex } from "node:stream";
import { DaemonClient } from "../../src/daemon/client";
import { McpTimeoutError } from "../../src/daemon/McpTimeoutError";
import {
  DEFAULT_MCP_REQUEST_TIMEOUT_MS,
  MIN_START_DEVICE_MCP_TIMEOUT_MS,
  MIN_UNINSTALL_APP_MCP_TIMEOUT_MS,
} from "../../src/daemon/mcpRequestTimeout";
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
});
