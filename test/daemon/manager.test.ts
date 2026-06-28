import { describe, expect, spyOn, test } from "bun:test";
import {
  DAEMON_PROCESS_TABLE_MAX_BUFFER_BYTES,
  DaemonManager,
  parseDaemonProcessTable,
  PsDaemonProcessFinder,
  resolveDaemonLaunchCommand,
  runDaemonCommand
} from "../../src/daemon/manager";
import type { DaemonProcessFinder, DaemonProcessRecord } from "../../src/daemon/manager";
import type { DaemonStateLike } from "../../src/daemon/daemonState";
import type { DaemonClientLike } from "../../src/daemon/client";

class FakeDaemonClient implements DaemonClientLike {
  readonly readResourceCalls: string[] = [];
  readonly callToolCalls: Array<{ toolName: string; params: Record<string, any> }> = [];
  readonly callDaemonMethodCalls: Array<{ method: string; params: Record<string, any> }> = [];
  private readonly result: any;

  constructor(result: any) {
    this.result = result;
  }

  async connect(): Promise<void> {}

  async close(): Promise<void> {}

  async callTool(toolName: string, params: Record<string, any>): Promise<any> {
    this.callToolCalls.push({ toolName, params });
    return {};
  }

  async readResource(uri: string): Promise<any> {
    this.readResourceCalls.push(uri);
    return this.result;
  }

  async callDaemonMethod(method: string, params: Record<string, any>): Promise<any> {
    this.callDaemonMethodCalls.push({ method, params });
    return {};
  }
}

class FakeDaemonProcessFinder implements DaemonProcessFinder {
  constructor(private readonly records: DaemonProcessRecord[]) {}

  findDaemonProcesses(): DaemonProcessRecord[] {
    return this.records;
  }
}

describe("resolveDaemonLaunchCommand", () => {
  test("uses the current entry script when one is available", () => {
    const launch = resolveDaemonLaunchCommand("/tmp/auto-mobile/dist/src/index.js", "bunx", "1.2.3");

    expect(launch).toEqual({
      command: process.execPath,
      args: ["/tmp/auto-mobile/dist/src/index.js", "--daemon-mode"],
    });
  });

  test("pins bunx fallback to the initiating package version", () => {
    const launch = resolveDaemonLaunchCommand("", "bunx", "1.2.3");

    expect(launch).toEqual({
      command: "bunx",
      args: ["-y", "@kaeawc/auto-mobile@1.2.3", "--daemon-mode"],
    });
  });

  test("rejects unknown versions instead of falling back to latest", () => {
    expect(() => resolveDaemonLaunchCommand("", "bunx", "unknown")).toThrow(
      "current package version is unknown"
    );
  });
});

describe("Daemon manager process detection", () => {
  test("parses daemon processes from ps pid ppid command output", () => {
    const records = parseDaemonProcessTable(`
      10     1 /usr/bin/unrelated --daemon-mode
      20     1 /bin/sh -c "bun /worktree/dist/src/index.js --daemon-mode"
      21    20 bun /worktree/dist/src/index.js --daemon-mode
      22     1 bun /worktree/dist/src/index.js
      30     1 bunx -y @kaeawc/auto-mobile@0.0.38 --daemon-mode
    `);

    expect(records).toEqual([
      {
        pid: 20,
        ppid: 1,
        command: `/bin/sh -c "bun /worktree/dist/src/index.js --daemon-mode"`,
      },
      {
        pid: 21,
        ppid: 20,
        command: "bun /worktree/dist/src/index.js --daemon-mode",
      },
      {
        pid: 30,
        ppid: 1,
        command: "bunx -y @kaeawc/auto-mobile@0.0.38 --daemon-mode",
      },
    ]);
  });

  test("uses an expanded buffer when reading the full process table", () => {
    const calls: Array<{
      command: string;
      options: { encoding: "utf-8"; maxBuffer: number };
    }> = [];
    const finder = new PsDaemonProcessFinder((command, options) => {
      calls.push({ command, options });
      return "20 1 bunx -y @kaeawc/auto-mobile@0.0.38 --daemon-mode";
    });

    expect(finder.findDaemonProcesses()).toEqual([
      {
        pid: 20,
        ppid: 1,
        command: "bunx -y @kaeawc/auto-mobile@0.0.38 --daemon-mode",
      },
    ]);
    expect(calls).toEqual([
      {
        command: "ps -eo pid=,ppid=,command=",
        options: {
          encoding: "utf-8",
          maxBuffer: DAEMON_PROCESS_TABLE_MAX_BUFFER_BYTES,
        },
      },
    ]);
    expect(DAEMON_PROCESS_TABLE_MAX_BUFFER_BYTES).toBeGreaterThan(1024 * 1024);
  });

  function managerWithProcesses(records: DaemonProcessRecord[]): DaemonManager {
    return new DaemonManager(
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      new FakeDaemonProcessFinder(records)
    );
  }

  test("reports a shell-launched daemon once using the long-lived daemon child PID", () => {
    const manager = managerWithProcesses([
      {
        pid: 100,
        ppid: 1,
        command: `/bin/sh -c "${process.execPath} /tmp/auto-mobile/dist/src/index.js --daemon-mode"`,
      },
      {
        pid: 101,
        ppid: 100,
        command: `${process.execPath} /tmp/auto-mobile/dist/src/index.js --daemon-mode`,
      },
    ]);

    expect(manager.findAllDaemonProcesses()).toEqual([101]);
  });

  test("does not report the current daemon's shell wrapper as another daemon", () => {
    const manager = managerWithProcesses([
      {
        pid: 100,
        ppid: 1,
        command: `/bin/sh -c "${process.execPath} /tmp/auto-mobile/dist/src/index.js --daemon-mode"`,
      },
      {
        pid: process.pid,
        ppid: 100,
        command: `${process.execPath} /tmp/auto-mobile/dist/src/index.js --daemon-mode`,
      },
    ]);

    expect(manager.findAllDaemonProcesses()).toEqual([]);
  });

  test("filters the active daemon PID while preserving distinct daemons", () => {
    const manager = managerWithProcesses([
      {
        pid: 200,
        ppid: 1,
        command: `/bin/sh -c "bun /worktree-a/dist/src/index.js --daemon-mode"`,
      },
      {
        pid: 201,
        ppid: 200,
        command: `bun /worktree-a/dist/src/index.js --daemon-mode`,
      },
      {
        pid: 300,
        ppid: 1,
        command: `/bin/sh -c "bun /worktree-b/dist/src/index.js --daemon-mode"`,
      },
      {
        pid: 301,
        ppid: 300,
        command: `bun /worktree-b/dist/src/index.js --daemon-mode`,
      },
    ]);

    expect(manager.findOtherDaemonProcesses(201)).toEqual([301]);
  });
});

describe("Daemon manager available-devices", () => {
  test("queries the booted devices resource when daemon is not initialized", async () => {
    const result = {
      contents: [
        {
          text: JSON.stringify({
            poolStatus: {
              idle: 2,
              assigned: 1,
              error: 0,
              total: 3
            }
          })
        }
      ]
    };
    const fakeClient = new FakeDaemonClient(result);
    const output: string[] = [];
    const logSpy = spyOn(console, "log").mockImplementation((...args) => {
      output.push(args.join(" "));
    });

    try {
      await runDaemonCommand("available-devices", [], {
        clientFactory: () => fakeClient,
        stateProvider: () => ({
          isInitialized: () => false,
          getDevicePool: () => {
            throw new Error("Device pool unavailable");
          },
          getSessionManager: () => {
            throw new Error("Session manager unavailable");
          }
        } satisfies DaemonStateLike)
      });
    } finally {
      logSpy.mockRestore();
    }

    expect(fakeClient.readResourceCalls).toEqual(["automobile:devices/booted"]);
    expect(fakeClient.callToolCalls).toHaveLength(0);
    expect(output).toContain(JSON.stringify({
      availableDevices: 2,
      totalDevices: 3,
      assignedDevices: 1,
      errorDevices: 0
    }));
  });

  test("uses daemon state pool stats when initialized", async () => {
    const fakeClient = new FakeDaemonClient({});
    const output: string[] = [];
    const logSpy = spyOn(console, "log").mockImplementation((...args) => {
      output.push(args.join(" "));
    });

    const fakeState: DaemonStateLike = {
      isInitialized: () => true,
      getDevicePool: () => ({
        getStats: () => ({
          idle: 1,
          assigned: 2,
          error: 1,
          total: 4
        })
      } as any),
      getSessionManager: () => ({
        getSession: () => null,
        releaseSession: async () => null
      } as any)
    };

    try {
      await runDaemonCommand("available-devices", [], {
        clientFactory: () => fakeClient,
        stateProvider: () => fakeState
      });
    } finally {
      logSpy.mockRestore();
    }

    expect(fakeClient.readResourceCalls).toHaveLength(0);
    expect(output).toContain(JSON.stringify({
      availableDevices: 1,
      totalDevices: 4,
      assignedDevices: 2,
      errorDevices: 1
    }));
  });
});
