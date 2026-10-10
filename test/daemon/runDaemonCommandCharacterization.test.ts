import { describe, expect, spyOn, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  runDaemonCommand,
  daemonBuildIdentityStatusLines,
} from "../../src/daemon/cli/runDaemonCommand";
import { getCurrentBuildIdentity } from "../../src/daemon/buildIdentity";
import type { DaemonStateLike } from "../../src/daemon/daemonState";
import { DAEMON_LIVENESS_OWNER_IS_PROXY_CODE, type DaemonStatus } from "../../src/daemon/types";
import * as debugTools from "../../src/daemon/debugTools";
import { SafeDaemonManager } from "../fakes/SafeDaemonManager";
import { FakeDaemonClient } from "../fakes/FakeDaemonClient";

const unexpected = (): never => {
  throw new Error("Unexpected daemon operation");
};
const remoteState: DaemonStateLike = {
  isInitialized: () => false,
  getSessionManager: unexpected,
  getDevicePool: unexpected,
  getDeviceSessionRegistry: unexpected,
};

describe("daemon command characterization with fake I/O", () => {
  test.each(["unknown", "toString"])(
    "unknown command %s preserves output and exit handling",
    async (command) => {
      const output: unknown[] = [];
      const exited = new Error("fake exit");
      const log = spyOn(console, "log").mockImplementation((text) => {
        output.push(["stdout", text]);
      });
      const error = spyOn(console, "error").mockImplementation((text) => {
        output.push(["stderr", text]);
      });
      const exit = spyOn(process, "exit").mockImplementation((code) => {
        output.push(["exit", code]);
        throw exited;
      });
      try {
        await expect(runDaemonCommand(command, [], {}, SafeDaemonManager)).rejects.toBe(exited);
        expect(output).toEqual([
          ["stderr", `Unknown daemon command: ${command}`],
          ["stdout", "\nAvailable commands:"],
          ["stdout", "  start                 Start the daemon"],
          ["stdout", "  stop                  Stop the daemon"],
          ["stdout", "  status                Check daemon status"],
          ["stdout", "  restart               Restart the daemon"],
          ["stdout", "  health                Check daemon health"],
          ["stdout", "  diagnose              Run full diagnostics"],
          ["stdout", "  available-devices     Query device pool status"],
          ["stdout", "  active-sessions       List held sessions and why each holds its device"],
          ["stdout", "  session-info <id>     Get information about a session"],
          ["stdout", "  release-session <id>  Release a session and free its device"],
          [
            "stdout",
            "  release-liveness-ownership <id> --liveness-owner-token <token>  Hand off liveness; keep the device",
          ],
          [
            "stdout",
            "  heartbeat <id>        Heartbeat a session (one-shot CLI: no-op; proxy-owned: refused)",
          ],
          ["exit", 1],
          ["stderr", "Unexpected error: fake exit"],
          ["exit", 1],
        ]);
      } finally {
        exit.mockRestore();
        error.mockRestore();
        log.mockRestore();
      }
    },
  );

  test("available-devices keeps local pool reads and eligibility queries in order", async () => {
    const events: unknown[] = [];
    const state = {
      isInitialized: () => true,
      getDevicePool: () => ({
        getStats: () => {
          events.push("stats");
          return { idle: 1, assigned: 0, error: 0, total: 1 };
        },
        getRecoveryPolicy: () => {
          events.push("policy");
          return { onLoss: false, maxAttempts: 0 };
        },
        getAllDevices: () => {
          events.push("devices");
          return [{ id: "fake", platform: "ios" }];
        },
        getRecoveryEligibility: (id: string) => {
          events.push(["eligibility", id]);
          return "eligible";
        },
      }),
    } as unknown as DaemonStateLike;
    class Manager extends SafeDaemonManager {
      override getDaemonState() {
        return state;
      }
    }
    const log = spyOn(console, "log").mockImplementation((text) => {
      events.push(JSON.parse(text));
    });
    try {
      await runDaemonCommand("available-devices", [], {}, Manager);
      expect(events).toEqual([
        "stats",
        "policy",
        "devices",
        ["eligibility", "fake"],
        {
          availableDevices: 1,
          totalDevices: 1,
          assignedDevices: 0,
          errorDevices: 0,
          recoveryPolicy: { onLoss: false, maxAttempts: 0 },
          devices: [{ deviceId: "fake", platform: "ios", recoveryEligibility: "eligible" }],
        },
      ]);
    } finally {
      log.mockRestore();
    }
  });

  test.each([true, false])("health preserves exit handling (healthy=%s)", async (healthy) => {
    const output: unknown[] = [];
    const health = spyOn(debugTools, "getDaemonHealthReport").mockResolvedValue({
      timestamp: "fake",
      daemonRunning: healthy,
      socketExists: true,
      socketAccessible: true,
      socketConnectable: true,
      pidFileExists: true,
      pidFileValid: true,
      recommendations: [],
    });
    const format = spyOn(debugTools, "formatHealthReport").mockReturnValue("health output");
    const exited = new Error("fake exit");
    const log = spyOn(console, "log").mockImplementation((text) => {
      output.push(text);
    });
    const error = spyOn(console, "error").mockImplementation((text) => {
      output.push(text);
    });
    const exit = spyOn(process, "exit").mockImplementation((code) => {
      output.push(code);
      throw exited;
    });
    try {
      const command = runDaemonCommand("health", [], {}, SafeDaemonManager);
      if (healthy) {
        await command;
      } else {
        await expect(command).rejects.toBe(exited);
      }
      expect(output).toEqual(
        healthy ? ["health output"] : ["health output", 1, "Unexpected error: fake exit", 1],
      );
    } finally {
      exit.mockRestore();
      error.mockRestore();
      log.mockRestore();
      format.mockRestore();
      health.mockRestore();
    }
  });

  const acceptanceScopeArgs = [
    "--session-uuid",
    "session",
    "--platform",
    "ios",
    "--stable-device-id",
    "device",
    "--android-sibling-avd-name",
    "sibling",
    "--android-duplicate-serial",
    "serial",
    "--ios-same-name-sibling-uuid",
    "udid",
    "--expires-at",
    "1",
  ];
  test.each([
    ["start", []],
    ["stop", []],
    ["restart", []],
    ["restart-admitted", ["--maintenance-token", "fake"]],
    ["restart-acceptance-session", acceptanceScopeArgs],
  ])("%s dispatches only to the injected fake manager", async (command, args) => {
    const events: string[] = [];
    class Manager extends SafeDaemonManager {
      override async start() {
        events.push("start");
      }
      override async stop() {
        events.push("stop");
      }
      override async restart() {
        events.push("restart");
      }
      override async restartAdmitted() {
        events.push("restart-admitted");
      }
      override async restartAcceptanceSession() {
        events.push("restart-acceptance-session");
      }
    }
    await runDaemonCommand(command, args, {}, Manager);
    expect(events).toEqual([command]);
  });

  test("diagnose awaits the fake health report before fake socket diagnostics", async () => {
    const events: unknown[] = [];
    const health = spyOn(debugTools, "getDaemonHealthReport").mockImplementation(async () => {
      events.push("health");
      return {
        timestamp: "fake",
        daemonRunning: true,
        socketExists: true,
        socketAccessible: true,
        socketConnectable: true,
        pidFileExists: true,
        pidFileValid: true,
        recommendations: [],
      };
    });
    const socket = spyOn(debugTools, "runSocketDiagnostics").mockImplementation(async () => {
      events.push("socket");
      return {
        issues: [],
        socketExists: true,
        socketReadable: true,
        socketWritable: true,
        socketConnectable: true,
        lastTestTime: "fake",
      };
    });
    const formatHealth = spyOn(debugTools, "formatHealthReport").mockReturnValue("health output");
    const formatSocket = spyOn(debugTools, "formatSocketDiagnostics").mockReturnValue(
      "socket output",
    );
    const log = spyOn(console, "log").mockImplementation((text) => {
      events.push(text);
    });
    try {
      await runDaemonCommand("diagnose", [], {}, SafeDaemonManager);
      expect(events).toEqual([
        "Running daemon diagnostics...\n",
        "health",
        "health output",
        "socket",
        "socket output",
      ]);
    } finally {
      log.mockRestore();
      formatSocket.mockRestore();
      formatHealth.mockRestore();
      socket.mockRestore();
      health.mockRestore();
    }
  });

  test.each(["session-info", "release-session", "heartbeat"])(
    "%s rejects an unknown local session before any mutation",
    async (command) => {
      const events: unknown[] = [];
      const state = {
        isInitialized: () => true,
        getSessionManager: () => ({
          getSession: () => {
            events.push("get-session");
            return null;
          },
          getReleasingSession: () => {
            events.push("get-releasing");
            return null;
          },
          releaseSession: unexpected,
          recordHeartbeat: unexpected,
        }),
        getDevicePool: () => {
          events.push("get-pool");
          return { releaseDevice: unexpected };
        },
      } as unknown as DaemonStateLike;
      class Manager extends SafeDaemonManager {
        override getDaemonState() {
          return state;
        }
      }
      const exited = new Error("fake exit");
      const exit = spyOn(process, "exit").mockImplementation(() => {
        throw exited;
      });
      const error = spyOn(console, "error").mockImplementation((text) => {
        events.push(text);
      });
      try {
        await expect(runDaemonCommand(command, ["fake"], {}, Manager)).rejects.toBe(exited);
        expect(events).toEqual([
          ...(command === "release-session" ? ["get-pool"] : []),
          "get-session",
          ...(command === "heartbeat" ? ["get-releasing"] : []),
          "Error: Session not found: fake",
        ]);
        expect(exit.mock.calls).toEqual([[1]]);
      } finally {
        error.mockRestore();
        exit.mockRestore();
      }
    },
  );

  test("local session-info and heartbeat preserve field and mutation order", async () => {
    const events: unknown[] = [];
    const session = {
      sessionId: "fake",
      assignedDevice: "device",
      createdAt: 1,
      lastUsedAt: 2,
      expiresAt: 3,
      cacheData: { key: "value" },
    };
    const state = {
      isInitialized: () => true,
      getSessionManager: () => ({
        getSession: () => {
          events.push("get-session");
          return session;
        },
        getReleasingSession: () => {
          events.push("get-releasing");
          return null;
        },
        recordHeartbeat: (id: string) => {
          events.push(["heartbeat", id]);
        },
      }),
    } as unknown as DaemonStateLike;
    class Manager extends SafeDaemonManager {
      override getDaemonState() {
        return state;
      }
    }
    const log = spyOn(console, "log").mockImplementation((text) => {
      events.push(text);
    });
    try {
      await runDaemonCommand("session-info", ["fake"], {}, Manager);
      await runDaemonCommand("heartbeat", ["fake"], {}, Manager);
      expect(events).toEqual([
        "get-session",
        JSON.stringify({
          sessionId: "fake",
          assignedDevice: "device",
          createdAt: 1,
          lastUsedAt: 2,
          expiresAt: 3,
          cacheSize: 15,
        }),
        "get-session",
        "get-releasing",
        ["heartbeat", "fake"],
        "Session fake heartbeat recorded",
      ]);
    } finally {
      log.mockRestore();
    }
  });

  test.each([false, true])(
    "status preserves recovery, identity and warning output (running=%s)",
    async (running) => {
      const events: unknown[] = [];
      const identity = getCurrentBuildIdentity();
      const status: DaemonStatus = {
        running,
        pid: 123,
        port: 456,
        socketPath: "fake.socket",
        startedAt: 0,
        buildId: identity.buildId,
        entryScript: identity.entryScript,
        recovery: { state: "deferred", reason: "busy" },
      };
      class Manager extends SafeDaemonManager {
        override async status() {
          events.push("status");
          return status;
        }
        override findOtherDaemonProcesses(pid?: number) {
          events.push(["other", pid]);
          return [234, 345];
        }
      }
      const log = spyOn(console, "log").mockImplementation((...args) => {
        events.push(args);
      });
      // status also lists CtrlProxy forwarding leases from the coordination directory. In the
      // shared-process lane an earlier file can leave one there, so read an empty directory.
      const coordinationDir = mkdtempSync(join(tmpdir(), "daemon-status-coord-"));
      const previousCoordinationDir = process.env.AUTOMOBILE_COORDINATION_DIR;
      process.env.AUTOMOBILE_COORDINATION_DIR = coordinationDir;
      try {
        await runDaemonCommand("status", [], {}, Manager);
        if (!running) {
          expect(events).toEqual([
            "status",
            ["  Identity recovery: deferred (busy)"],
            ["Daemon is not running"],
          ]);
          return;
        }
        expect(events.slice(0, 10)).toEqual([
          "status",
          ["  Identity recovery: deferred (busy)"],
          ["Daemon is running"],
          ["  PID: 123"],
          ["  Port: 456"],
          ["  Socket: fake.socket"],
          ["  Database: unknown"],
          ["  Version: unknown"],
          ["  Started: unknown"],
          [daemonBuildIdentityStatusLines(status, identity)[0]],
        ]);
        expect(events.slice(10, 15)).toEqual([
          [daemonBuildIdentityStatusLines(status, identity)[1]],
          ["other", 123],
          ["\n⚠️  WARNING: Found 2 other daemon process(es) from other worktrees:"],
          ["  - PID 234"],
          ["  - PID 345"],
        ]);
        expect(String(events[15])).toContain("--daemon restart' to stop them.");
      } finally {
        log.mockRestore();
        if (previousCoordinationDir === undefined) {
          delete process.env.AUTOMOBILE_COORDINATION_DIR;
        } else {
          process.env.AUTOMOBILE_COORDINATION_DIR = previousCoordinationDir;
        }
        rmSync(coordinationDir, { recursive: true, force: true });
      }
    },
  );

  test.each([
    {
      content: "",
      expected: { availableDevices: 0, totalDevices: 0, assignedDevices: 0, errorDevices: 0 },
    },
    {
      content: JSON.stringify({
        poolStatus: {
          idle: 1,
          total: 3,
          assigned: 1,
          error: 1,
          recoveryPolicy: { onLoss: true, maxAttempts: 2 },
        },
        devices: [{ platform: "ios", runtime: {} }],
      }),
      expected: {
        availableDevices: 1,
        totalDevices: 3,
        assignedDevices: 1,
        errorDevices: 1,
        recoveryPolicy: { onLoss: true, maxAttempts: 2 },
        devices: [{ deviceId: "unknown", platform: "ios" }],
      },
    },
  ])(
    "available-devices prints resource data before closing: $content",
    async ({ content, expected }) => {
      const events: unknown[] = [];
      class Client extends FakeDaemonClient {
        override async connect() {
          events.push("connect");
        }
        override async readResource(uri: string) {
          events.push(uri);
          return { contents: [{ text: content }] };
        }
        override async close() {
          events.push("close");
        }
      }
      const client = new Client();
      class Manager extends SafeDaemonManager {
        override getDaemonState() {
          return remoteState;
        }
        override createClient() {
          return client;
        }
      }
      const log = spyOn(console, "log").mockImplementation((text) => {
        events.push(JSON.parse(text));
      });
      try {
        await runDaemonCommand("available-devices", [], {}, Manager);
        expect(events).toEqual(["connect", "automobile:devices/booted", expected, "close"]);
      } finally {
        log.mockRestore();
      }
    },
  );

  test("active-sessions asks the daemon for per-session hold diagnostics (#10671)", async () => {
    const events: unknown[] = [];
    class Client extends FakeDaemonClient {
      override async connect() {
        events.push("connect");
      }
      override async callDaemonMethod(method: string, params: Record<string, unknown>) {
        events.push([method, params]);
        return { activeSessions: 0, activeExecutions: 0, sessions: [] };
      }
      override async close() {
        events.push("close");
      }
    }
    const client = new Client();
    class Manager extends SafeDaemonManager {
      override getDaemonState() {
        return remoteState;
      }
      override createClient() {
        return client;
      }
    }
    const log = spyOn(console, "log").mockImplementation((text) => {
      events.push(text);
    });
    try {
      await runDaemonCommand("active-sessions", [], {}, Manager);
      expect(events).toEqual([
        "connect",
        ["daemon/activeSessions", { includeSessions: true }],
        '{"activeSessions":0,"activeExecutions":0,"sessions":[]}',
        "close",
      ]);
    } finally {
      log.mockRestore();
    }
  });

  test.each(["session-info", "heartbeat"])(
    "%s keeps remote call/close/output order",
    async (command) => {
      const events: unknown[] = [];
      class Client extends FakeDaemonClient {
        override async connect() {
          events.push("connect");
        }
        override async callDaemonMethod(method: string, params: Record<string, unknown>) {
          events.push([method, params.sessionId]);
          return { sessionId: "fake" };
        }
        override async close() {
          events.push("close");
        }
      }
      const client = new Client();
      class Manager extends SafeDaemonManager {
        override getDaemonState() {
          return remoteState;
        }
        override createClient() {
          return client;
        }
      }
      const log = spyOn(console, "log").mockImplementation((text) => {
        events.push(text);
      });
      try {
        await runDaemonCommand(command, ["fake"], {}, Manager);
        expect(events).toEqual(
          command === "heartbeat"
            ? ["connect", ["daemon/heartbeat", "fake"], "close", "Session fake heartbeat recorded"]
            : ["connect", ["daemon/sessionInfo", "fake"], '{"sessionId":"fake"}', "close"],
        );
      } finally {
        log.mockRestore();
      }
    },
  );
});

describe("heartbeat command against a proxy-owned session (#10054)", () => {
  const sessionId = "proxy-owned-session";

  class RefusingClient extends FakeDaemonClient {
    readonly calls: Array<{ method: string; params: Record<string, unknown> }> = [];
    override async connect() {}
    override async callDaemonMethod(method: string, params: Record<string, unknown>) {
      this.calls.push({ method, params });
      throw Object.assign(new Error(`Session ${sessionId} is owned by an MCP proxy.`), {
        code: DAEMON_LIVENESS_OWNER_IS_PROXY_CODE,
      });
    }
    override async close() {}
  }

  test("exits non-zero printing the daemon's actionable message and the structured code", async () => {
    const client = new RefusingClient();
    class Manager extends SafeDaemonManager {
      override getDaemonState() {
        return remoteState;
      }
      override createClient() {
        return client;
      }
    }
    const output: unknown[] = [];
    const log = spyOn(console, "log").mockImplementation((text) => {
      output.push(["stdout", text]);
    });
    const error = spyOn(console, "error").mockImplementation((text) => {
      output.push(["stderr", text]);
    });
    const exit = spyOn(process, "exit").mockImplementation((code) => {
      output.push(["exit", code]);
      return undefined as never;
    });
    try {
      await runDaemonCommand(
        "heartbeat",
        [sessionId, "--liveness-owner-token", "keeper", "--claim-liveness-ownership"],
        {},
        Manager,
      );
    } finally {
      log.mockRestore();
      error.mockRestore();
      exit.mockRestore();
    }

    expect(client.calls).toEqual([
      {
        method: "daemon/heartbeat",
        params: expect.objectContaining({
          sessionId,
          livenessOwnerKind: "cli-keeper",
          livenessOwnerToken: "keeper",
          claimLivenessOwnership: true,
        }),
      },
    ]);
    expect(output).toEqual([
      [
        "stderr",
        `Error: Session ${sessionId} is owned by an MCP proxy. [liveness_owner_is_proxy] Stop this keeper; heartbeat only works for one-shot CLI sessions.`,
      ],
      ["exit", 1],
    ]);
  });
});

// Owner decision 2026-10-09 (#11096): keepers are dropped for one-shot CLI sessions.
describe("heartbeat command against a one-shot CLI session (#11096)", () => {
  test("reports the daemon's no-op and exits zero", async () => {
    const sessionId = "cli-idle-session";
    const events: unknown[] = [];
    class Client extends FakeDaemonClient {
      override async connect() {}
      override async callDaemonMethod() {
        return { sessionId, livenessPolicy: "cli-idle", livenessUnchanged: true };
      }
      override async close() {
        events.push("close");
      }
    }
    const client = new Client();
    class Manager extends SafeDaemonManager {
      override getDaemonState() {
        return remoteState;
      }
      override createClient() {
        return client;
      }
    }
    const log = spyOn(console, "log").mockImplementation((text) => {
      events.push(["stdout", text]);
    });
    const exit = spyOn(process, "exit").mockImplementation((code) => {
      events.push(["exit", code]);
      return undefined as never;
    });
    try {
      await runDaemonCommand(
        "heartbeat",
        [sessionId, "--liveness-owner-token", "keeper", "--claim-liveness-ownership"],
        {},
        Manager,
      );
    } finally {
      log.mockRestore();
      exit.mockRestore();
    }

    expect(events).toEqual([
      [
        "stdout",
        `Session ${sessionId} is a one-shot CLI session: its idle window runs from tool calls, so this heartbeat changed nothing (no keeper is needed).`,
      ],
      "close",
    ]);
  });
});
