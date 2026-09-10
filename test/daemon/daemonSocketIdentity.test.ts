import { describe, expect, spyOn, test } from "bun:test";
import { Duplex } from "node:stream";
import {
  DaemonClient,
  DaemonHandshakeMismatchError,
  DaemonUnavailableError,
} from "../../src/daemon/client";
import { DaemonMcpProxy, DaemonVersionMismatchError } from "../../src/daemon/daemonMcpProxy";
import type { DaemonStatus, DaemonResponse } from "../../src/daemon/types";
import { FakeDaemonClient } from "../fakes/FakeDaemonClient";
import { FakeDaemonManager } from "../fakes/FakeDaemonManager";
import { FakeTimer } from "../fakes/FakeTimer";

describe("socket-owner daemon preflight", () => {
  for (const actualIdentity of [
    {},
    { pid: 101, buildId: "unknown", entryScript: "/current" },
    { pid: 101, buildId: "current" },
    { pid: 101, buildId: "current", entryScript: "/different" },
    { buildId: "current", entryScript: "/current" },
    { pid: 202, buildId: "current", entryScript: "/current" },
  ]) {
    test(`does not trust PID startup flags without verified socket identity ${JSON.stringify(actualIdentity)}`, async () => {
      const manager = new FakeDaemonManager();
      manager.statusResult = {
        running: true,
        pid: 101,
        version: "0.0.70",
        buildId: "current",
        entryScript: "/current",
        options: { debug: true },
      };
      const client = new FakeDaemonClient();
      const available = spyOn(DaemonClient, "isAvailable").mockResolvedValue(true);
      const proxy = new DaemonMcpProxy({
        clientFactory: () => client,
        daemonManager: manager,
        clientVersion: "0.0.70",
        buildIdentity: { buildId: "current", entryScript: "/current" },
        autoStartDaemon: false,
        daemonOptions: { debug: true },
        timer: new FakeTimer(),
        daemonStatusProbe: async () => ({ running: true, version: "0.0.70", ...actualIdentity }),
      });
      try {
        await expect(proxy.callTool("provisionDevice", {})).rejects.toBeInstanceOf(
          DaemonUnavailableError,
        );
        expect(client.callToolCalls).toHaveLength(0);
        expect(manager.restartCallCount).toBe(0);
      } finally {
        available.mockRestore();
        await proxy.close();
      }
    });
  }

  test("a version-only socket does not borrow a conflicting PID build", async () => {
    const manager = new FakeDaemonManager();
    manager.statusResult = {
      running: true,
      version: "0.0.70",
      buildId: "unrelated",
      entryScript: "/other",
    };
    const client = new FakeDaemonClient();
    const available = spyOn(DaemonClient, "isAvailable").mockResolvedValue(true);
    const proxy = new DaemonMcpProxy({
      clientFactory: () => client,
      daemonManager: manager,
      clientVersion: "0.0.70",
      buildIdentity: { buildId: "current", entryScript: "/current" },
      autoStartDaemon: false,
      timer: new FakeTimer(),
      daemonStatusProbe: async () => ({ running: true, version: "0.0.70" }),
    });
    try {
      await proxy.callTool("provisionDevice", {});
      expect(client.callToolCalls).toHaveLength(1);
      expect(manager.restartCallCount).toBe(0);
    } finally {
      available.mockRestore();
      await proxy.close();
    }
  });

  test("retains startup flags when the socket identifies the recorded process and build", async () => {
    const manager = new FakeDaemonManager();
    const identity = { pid: 101, version: "0.0.70", buildId: "current", entryScript: "/current" };
    manager.statusResult = { running: true, ...identity, options: { debug: true } };
    const client = new FakeDaemonClient();
    const available = spyOn(DaemonClient, "isAvailable").mockResolvedValue(true);
    const proxy = new DaemonMcpProxy({
      clientFactory: () => client,
      daemonManager: manager,
      clientVersion: "0.0.70",
      buildIdentity: identity,
      autoStartDaemon: false,
      daemonOptions: { debug: true },
      timer: new FakeTimer(),
      daemonStatusProbe: async () => ({ running: true, ...identity }),
    });
    try {
      await proxy.callTool("provisionDevice", {});
      expect(client.callToolCalls).toHaveLength(1);
      expect(manager.restartCallCount).toBe(0);
    } finally {
      available.mockRestore();
      await proxy.close();
    }
  });

  test("a structured pre-dispatch rejection reconciles once without duplicating execution", async () => {
    const manager = new FakeDaemonManager();
    manager.statusResult = { running: false };
    let rejected = false;
    let executions = 0;
    const client = new FakeDaemonClient({
      onCallTool: () => {
        if (!rejected) {
          rejected = true;
          throw new DaemonHandshakeMismatchError(
            {
              code: "daemon_identity_mismatch",
              phase: "daemon-preflight",
              executionStarted: false,
              reason: "version",
              daemon: { version: "0.0.68", build: { buildId: "old", entryScript: "/old" } },
              client: { clientVersion: "0.0.70" },
            },
            "daemon changed before dispatch",
          );
        }
        executions++;
      },
    });
    const available = spyOn(DaemonClient, "isAvailable").mockResolvedValue(true);
    const proxy = new DaemonMcpProxy({
      clientFactory: () => client,
      daemonManager: manager,
      clientVersion: "0.0.70",
      timer: new FakeTimer(),
      daemonStatusProbe: async () => ({
        running: true,
        version: rejected && !manager.restartCalled ? "0.0.68" : "0.0.70",
      }),
    });
    try {
      await proxy.callTool("provisionDevice", {});
      expect(manager.restartCallCount).toBe(1);
      expect(executions).toBe(1);
      expect(client.callToolCalls).toHaveLength(2);
    } finally {
      available.mockRestore();
      await proxy.close();
    }
  });
  test("socket build identity overrides a matching-version PID record", async () => {
    const manager = new FakeDaemonManager();
    manager.statusResult = { running: true, version: "0.0.70", buildId: "current" };
    const client = new FakeDaemonClient();
    const available = spyOn(DaemonClient, "isAvailable").mockResolvedValue(true);
    const proxy = new DaemonMcpProxy({
      clientFactory: () => client,
      daemonManager: manager,
      clientVersion: "0.0.70",
      buildIdentity: { buildId: "current", entryScript: "/new" },
      timer: new FakeTimer(),
      daemonStatusProbe: async () => ({
        running: true,
        version: "0.0.70",
        buildId: manager.restartCalled ? "current" : "old",
        entryScript: manager.restartCalled ? "/new" : "/old",
      }),
    });
    try {
      await proxy.callTool("provisionDevice", {});
      expect(manager.restartCallCount).toBe(1);
      expect(client.callToolCalls).toHaveLength(1);
    } finally {
      available.mockRestore();
      await proxy.close();
    }
  });
  for (const recorded of [
    { running: false },
    { running: true, version: "0.0.70", buildId: "current" },
  ]) {
    test(`reconciles old socket owner despite PID record ${JSON.stringify(recorded)}`, async () => {
      const manager = new FakeDaemonManager();
      manager.statusResult = recorded;
      const client = new FakeDaemonClient();
      let probes = 0;
      const available = spyOn(DaemonClient, "isAvailable").mockResolvedValue(true);
      const proxy = new DaemonMcpProxy({
        clientFactory: () => client,
        daemonManager: manager,
        clientVersion: "0.0.70",
        buildIdentity: { buildId: "current", entryScript: "/new/index.js" },
        timer: new FakeTimer(),
        daemonStatusProbe: async () => {
          probes++;
          return {
            running: true,
            version: manager.restartCalled ? "0.0.70" : "0.0.68",
          };
        },
      });
      try {
        await proxy.callTool("provisionDevice", {});
        expect(manager.restartCallCount).toBe(1);
        expect(client.callToolCalls).toHaveLength(1);
        expect(probes).toBe(2);
      } finally {
        available.mockRestore();
        await proxy.close();
      }
    });
  }

  for (const scenario of ["newer", "disabled", "cooldown", "replacement-mismatch"] as const) {
    test(`${scenario} rejects before device dispatch`, async () => {
      const manager = new FakeDaemonManager();
      manager.statusResult = { running: false };
      const client = new FakeDaemonClient();
      const timer = new FakeTimer();
      timer.advanceTime(100_000);
      const available = spyOn(DaemonClient, "isAvailable").mockResolvedValue(true);
      const actual: DaemonStatus = {
        running: true,
        version: scenario === "newer" ? "0.0.71" : "0.0.68",
        ...(scenario === "cooldown" ? { startedAt: timer.now() } : {}),
      };
      const proxy = new DaemonMcpProxy({
        clientFactory: () => client,
        daemonManager: manager,
        daemonStatusProbe: async () => actual,
        clientVersion: "0.0.70",
        timer,
        autoStartDaemon: scenario !== "disabled",
      });
      try {
        await expect(proxy.callTool("provisionDevice", {})).rejects.toBeInstanceOf(
          DaemonVersionMismatchError,
        );
        expect(client.callToolCalls).toHaveLength(0);
        expect(manager.restartCallCount).toBe(scenario === "replacement-mismatch" ? 1 : 0);
      } finally {
        available.mockRestore();
        await proxy.close();
      }
    });
  }

  test("legacy status probe is ungated and closes its diagnostic connection", async () => {
    const closed = spyOn(DaemonClient.prototype, "close").mockResolvedValue();
    let declaredIdentity: unknown = "unset";
    const method = spyOn(DaemonClient.prototype, "callDaemonMethod").mockImplementation(
      async function (name) {
        expect(name).toBe("ide/status");
        declaredIdentity = (this as unknown as { clientIdentity: unknown }).clientIdentity;
        return { version: "0.0.68", releaseVersion: "0.0.68" };
      },
    );
    try {
      const status = await new DaemonClient("/fake.sock").getDaemonStatus();
      expect(status).toEqual({
        running: true,
        version: "0.0.68",
        assetVersion: "0.0.68",
        socketPath: "/fake.sock",
      });
      expect(declaredIdentity).toBeNull();
      expect(closed).toHaveBeenCalledTimes(1);
    } finally {
      method.mockRestore();
      closed.mockRestore();
    }
  });

  for (const pid of [101, 0, -1, 1.5, "101"]) {
    test(`socket status validates process identity ${JSON.stringify(pid)}`, async () => {
      const closed = spyOn(DaemonClient.prototype, "close").mockResolvedValue();
      const method = spyOn(DaemonClient.prototype, "callDaemonMethod").mockResolvedValue({
        version: "0.0.70",
        pid,
      });
      try {
        const result = new DaemonClient("/fake.sock").getDaemonStatus();
        if (pid === 101) {
          expect((await result).pid).toBe(101);
        } else {
          await expect(result).rejects.toThrow("Daemon preflight failed");
        }
        expect(closed).toHaveBeenCalledTimes(1);
      } finally {
        method.mockRestore();
        closed.mockRestore();
      }
    });
  }

  test("wire mismatch decodes into a typed preflight rejection", async () => {
    const failure = {
      code: "daemon_identity_mismatch",
      phase: "daemon-preflight",
      executionStarted: false,
      reason: "version",
      daemon: { version: "0.0.68", build: { buildId: "old", entryScript: "/old" } },
      client: { clientVersion: "0.0.70" },
    } as const;
    const client = new DaemonClient("/fake.sock", 1000, new FakeTimer());
    const internals = client as unknown as {
      connected: boolean;
      socket: Duplex;
      handleResponse(response: DaemonResponse): void;
    };
    internals.connected = true;
    internals.socket = new Duplex({
      read() {},
      write(chunk, _encoding, done) {
        const request = JSON.parse(chunk.toString());
        internals.handleResponse({
          id: request.id,
          type: "mcp_response",
          success: false,
          error: "daemon=0.0.68, client=0.0.70",
          handshakeFailure: failure,
        });
        done();
      },
    });
    try {
      await client.callTool("provisionDevice", {});
      expect.unreachable("Expected rejection");
    } catch (error) {
      expect(error).toBeInstanceOf(DaemonHandshakeMismatchError);
      expect((error as DaemonHandshakeMismatchError).failure).toEqual(failure);
      expect((error as Error).message).toContain("no device operation started");
    } finally {
      await client.close();
    }
  });
});
