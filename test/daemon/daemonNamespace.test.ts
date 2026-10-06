import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import type { ChildProcess, SpawnOptions } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DaemonManager, type DaemonProcessSpawner } from "../../src/daemon/manager";
import type { IdentityRecoveryIO } from "../../src/daemon/identityRecovery";
import type {
  DaemonProcessFinder,
  DaemonProcessLivenessChecker,
  DaemonProcessRecord,
  DaemonProcessSignaler,
} from "../../src/daemon/processTable";
import {
  DEFAULT_SOCKET_PATH,
  DEFAULT_PID_FILE_PATH,
  DAEMON_SHUTDOWN_TIMEOUT_MS,
  DAEMON_FORCED_STOP_TIMEOUT_MS,
} from "../../src/daemon/constants";
import type { DaemonStatus, PidFileData } from "../../src/daemon/types";
import { ActionableError } from "../../src/models";
import { FakeChildProcess } from "../fakes/FakeChildProcess";
import { FakeTimer } from "../fakes/FakeTimer";

class NamespaceProcesses implements DaemonProcessFinder, DaemonProcessLivenessChecker {
  records: DaemonProcessRecord[] = [];
  livePids = new Set<number>();
  /** Generation token of the process now holding each live PID (unset = unreadable). */
  tokens = new Map<number, string>();
  findDaemonProcesses(): DaemonProcessRecord[] {
    return this.records;
  }
  isProcessRunning(pid: number): boolean {
    return this.livePids.has(pid);
  }
  readProcessGenerationToken(pid: number): string | undefined {
    return this.tokens.get(pid);
  }
}

class NamespaceIdentity implements IdentityRecoveryIO {
  record: PidFileData | null = null;
  owner: DaemonStatus = { running: false };
  exists = false;
  onProbe?: () => void;
  socketExists(): boolean {
    return this.exists;
  }
  readRecord(): PidFileData | null {
    return this.record;
  }
  async probe(): Promise<DaemonStatus> {
    this.onProbe?.();
    return this.owner;
  }
}

class ReadyNamespaceManager extends DaemonManager {
  readyWaits = 0;
  // Fake startup-lock I/O keeps even the default-namespace case off user paths.
  override acquireLock(): boolean {
    return true;
  }
  override releaseLock(): void {}
  override async waitForReady(): Promise<boolean> {
    this.readyWaits++;
    return true;
  }
}

const dirs: string[] = [];

// A manager that reaches start() opens a daemon launch log under the resolved
// AutoMobile data dir, which must never be the developer's real ~/.auto-mobile.
let isolatedDataDir: string | undefined;
let originalDataDir: string | undefined;

beforeEach(() => {
  originalDataDir = process.env.AUTOMOBILE_DATA_DIR;
  isolatedDataDir = mkdtempSync(join(tmpdir(), "namespace-unit-data-"));
  process.env.AUTOMOBILE_DATA_DIR = isolatedDataDir;
});

afterEach(() => {
  if (originalDataDir === undefined) {
    delete process.env.AUTOMOBILE_DATA_DIR;
  } else {
    process.env.AUTOMOBILE_DATA_DIR = originalDataDir;
  }
  if (isolatedDataDir !== undefined) {
    rmSync(isolatedDataDir, { recursive: true, force: true });
    isolatedDataDir = undefined;
  }
  for (const dir of dirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function harness(defaultNamespace = false) {
  const dir = mkdtempSync(join(tmpdir(), "namespace-unit-"));
  dirs.push(dir);
  const socket = defaultNamespace ? DEFAULT_SOCKET_PATH : join(dir, "private socket.sock");
  const pidPath = defaultNamespace ? DEFAULT_PID_FILE_PATH : join(dir, "daemon.pid");
  const processes = new NamespaceProcesses();
  const identity = new NamespaceIdentity();
  const timer = new FakeTimer();
  timer.enableAutoAdvance();
  const signals: Array<{ pid: number; signal: NodeJS.Signals }> = [];
  let exits = true;
  const signaler: DaemonProcessSignaler = {
    signal(pid, signal) {
      signals.push({ pid, signal });
      if (exits) {
        processes.livePids.delete(pid);
        identity.record = null;
        identity.owner = { running: false };
      }
    },
  };
  const calls: Array<{ args: string[]; options: SpawnOptions }> = [];
  const makeRecord = (pid: number, port = 3001): PidFileData => ({
    pid,
    socketPath: socket,
    port,
    startedAt: 1,
    processStartedAt: 1,
    processGenerationToken: `generation-${pid}`,
    version: "test",
  });
  const spawner: DaemonProcessSpawner = {
    spawn(_command, args, options): ChildProcess {
      calls.push({ args: [...args], options });
      const child = new FakeChildProcess(timer);
      child.pid = 202;
      identity.record = makeRecord(202);
      processes.livePids.add(202);
      return child as ChildProcess;
    },
  };
  const ports: number[] = [];
  let defaultPortOccupied = true;
  const manager = new ReadyNamespaceManager(
    () => ({
      async connect() {},
      async close() {},
      async callTool() {
        return {};
      },
      async readResource() {
        return {};
      },
      async callDaemonMethod() {
        return {};
      },
    }),
    undefined,
    timer,
    defaultNamespace ? undefined : join(dir, "daemon.lock"),
    pidPath,
    socket,
    processes,
    spawner,
    undefined,
    () => ({ command: "auto-mobile", args: ["--daemon-mode"] }),
    signaler,
    { next: () => "namespace-test-owner" },
    { isReachable: async () => false },
    undefined,
    {
      isPortFree: async (port) => {
        ports.push(port);
        return port !== 3000 || !defaultPortOccupied;
      },
    },
    undefined,
    undefined,
    identity,
  );
  const addForeign = (marked = false) => {
    processes.records.push({
      pid: 101,
      ppid: 1,
      command: "auto-mobile --daemon-mode" + (marked ? " --daemon-socket-path=/foreign.sock" : ""),
      startedAt: 1,
      processGenerationToken: "foreign-generation",
    });
    processes.livePids.add(101);
  };
  const addOwn = (listed = true) => {
    identity.record = makeRecord(201);
    processes.livePids.add(201);
    identity.owner = {
      ...identity.record,
      running: true,
      reportedSocketPath: socket,
      reportedPidFilePath: pidPath,
    };
    if (listed) {
      processes.records.push({
        pid: 201,
        ppid: 1,
        command: "auto-mobile --daemon-mode",
        startedAt: 1,
        processGenerationToken: "generation-201",
      });
    }
  };
  return {
    manager,
    processes,
    identity,
    timer,
    calls,
    signals,
    socket,
    pidPath,
    ports,
    addForeign,
    addOwn,
    allowDefaultPort: () => {
      defaultPortOccupied = false;
    },
    refuseExit: () => {
      exits = false;
    },
  };
}

describe("daemon namespace ownership", () => {
  test("private start ignores an unmarked foreign daemon without waiting or signalling", async () => {
    const h = harness();
    h.addForeign();
    await expect(h.manager.start()).resolves.toBe("started");
    expect(h.calls).toHaveLength(1);
    expect(h.manager.readyWaits).toBe(1);
    expect(h.timer.now()).toBeLessThan(1000);
    expect(h.signals).toEqual([]);
  });

  test.each([true, false])(
    "restart replaces only the own recorded generation (listed=%s) and reuses its fallback port",
    async (listed) => {
      const h = harness();
      h.addOwn(listed);
      h.addForeign();
      await expect(h.manager.restart()).resolves.toBe("restarted");
      expect(h.signals).toEqual([{ pid: 201, signal: "SIGTERM" }]);
      expect(h.processes.livePids.has(101)).toBe(true);
      expect(h.calls).toHaveLength(1);
      expect(h.calls[0].args).toContain("3001");
      expect(h.ports).toEqual([3001]);
      expect((await h.manager.status(false)).pid).toBe(202);
      expect((await h.manager.status(false)).processGenerationToken).toBe("generation-202");
    },
  );

  test("restart fails with a typed error when the own daemon survives both stop bounds", async () => {
    const h = harness();
    h.addOwn(false);
    h.addForeign();
    h.refuseExit();
    await expect(h.manager.restart()).rejects.toBeInstanceOf(ActionableError);
    expect(h.calls).toHaveLength(0);
    expect(h.signals).toEqual([
      { pid: 201, signal: "SIGTERM" },
      { pid: 201, signal: "SIGKILL" },
    ]);
    expect(h.timer.now()).toBe(DAEMON_SHUTDOWN_TIMEOUT_MS + DAEMON_FORCED_STOP_TIMEOUT_MS);
    expect(h.processes.livePids.has(101)).toBe(true);
  });

  test("alive but unlisted recorded PID without socket identity fails closed", async () => {
    const h = harness();
    h.addOwn(false);
    h.identity.owner = { running: false };
    const restart = h.manager.restart();
    await expect(restart).rejects.toBeInstanceOf(ActionableError);
    await expect(restart).rejects.toThrow(
      "could not verify the live PID's generation and ownership",
    );
    expect(h.signals).toEqual([]);
    expect(h.calls).toHaveLength(0);
  });

  test("lost record reuses an unmarked orphan answering on this socket", async () => {
    const h = harness();
    h.addOwn();
    h.identity.record = null;
    h.addForeign();
    const writes: string[] = [];
    const stderr = spyOn(process.stderr, "write").mockImplementation((chunk) => {
      writes.push(String(chunk));
      return true;
    });
    try {
      await expect(h.manager.start()).resolves.toBe("joined");
    } finally {
      stderr.mockRestore();
    }
    expect(writes.join("\n")).not.toContain("PID 101");
    expect(h.calls).toHaveLength(0);
    expect(h.signals).toEqual([]);
  });

  test("lost record reuses a legacy socket owner even when no process scan entry exists", async () => {
    const h = harness();
    h.addOwn(false);
    h.identity.record = null;
    h.identity.exists = true;
    h.identity.owner = { running: true, pid: 201, startedAt: 1, version: "legacy" };
    await expect(h.manager.start()).resolves.toBe("joined");
    expect(h.calls).toHaveLength(0);
    expect(h.signals).toEqual([]);
  });

  test("lost record reuses a marked orphan in this namespace", async () => {
    const h = harness();
    h.addOwn();
    h.identity.record = null;
    h.addForeign();
    h.identity.owner = { running: false };
    h.processes.records[0].command += ` --daemon-socket-path=${encodeURIComponent(h.socket)}`;
    const writes: string[] = [];
    const stderr = spyOn(process.stderr, "write").mockImplementation((chunk) => {
      writes.push(String(chunk));
      return true;
    });
    try {
      await expect(h.manager.start()).resolves.toBe("joined");
    } finally {
      stderr.mockRestore();
    }
    expect(writes.join("\n")).not.toContain("PID 101");
    expect(h.calls).toHaveLength(0);
    expect(h.signals).toEqual([]);
  });

  test("lost record ignores a daemon marked with another socket", async () => {
    const h = harness();
    h.addForeign(true);
    await expect(h.manager.start()).resolves.toBe("started");
    expect(h.calls).toHaveLength(1);
    expect(h.signals).toEqual([]);
  });

  test("a different socket marker overrides an ambiguous socket probe", async () => {
    const h = harness();
    h.addForeign(true);
    h.identity.owner = { running: true, pid: 101 };
    await expect(h.manager.start()).resolves.toBe("started");
    expect(h.calls).toHaveLength(1);
    expect(h.signals).toEqual([]);
  });

  test("default namespace ignores an unmarked daemon that does not answer on its socket", async () => {
    const h = harness(true);
    h.addForeign();
    await expect(h.manager.start()).resolves.toBe("started");
    expect(h.calls).toHaveLength(1);
    expect(h.signals).toEqual([]);
  });

  test("spawn carries the resolved namespace marker", async () => {
    const h = harness();
    await h.manager.start();
    expect(h.calls[0].args).toContain(`--daemon-socket-path=${encodeURIComponent(h.socket)}`);
  });

  test.each([false, true])(
    "restart rejects joining the old PID without proof of a new generation (metadata changed=%s)",
    async (changed) => {
      const h = harness();
      h.addOwn();
      h.addForeign();
      h.allowDefaultPort();
      const record = h.identity.record!;
      const start = spyOn(h.manager, "start").mockImplementation(async () => {
        h.processes.livePids.add(201);
        h.identity.record = changed
          ? { ...record, processGenerationToken: undefined, version: "changed" }
          : record;
        return "joined";
      });
      try {
        await expect(h.manager.restart()).rejects.toThrow(
          "did not replace the namespace's previous daemon generation",
        );
        expect(h.signals).toEqual([{ pid: 201, signal: "SIGTERM" }]);
        expect(h.processes.livePids.has(101)).toBe(true);
      } finally {
        start.mockRestore();
      }
    },
  );

  test("PID reuse during socket verification is rejected before signalling", async () => {
    const h = harness();
    h.addOwn(false);
    h.identity.onProbe = () => {
      h.processes.records = [
        {
          pid: 201,
          ppid: 1,
          command: "auto-mobile --daemon-mode",
          startedAt: 1,
          processGenerationToken: "reused-during-probe",
        },
      ];
    };
    await expect(h.manager.restart()).rejects.toThrow("PID was reused before signalling");
    expect(h.signals).toEqual([]);
    expect(h.calls).toHaveLength(0);
  });

  test("start rejects a reused recorded PID instead of claiming it is already running", async () => {
    const h = harness();
    h.addOwn();
    h.addForeign();
    h.processes.records[0].processGenerationToken = "reused-generation";
    await expect(h.manager.start()).rejects.toThrow("PID was reused before signalling");
    expect(h.calls).toHaveLength(0);
    expect(h.signals).toEqual([]);
  });

  test("PID reuse never signals a different process generation", async () => {
    const h = harness();
    h.addOwn();
    h.addForeign();
    h.processes.records[0].processGenerationToken = "reused-generation";
    await expect(h.manager.restart()).rejects.toBeInstanceOf(ActionableError);
    expect(h.signals).toEqual([]);
    expect(h.calls).toHaveLength(0);
  });
});

describe("a dead daemon whose PID was reused by an unrelated process (issue #10108)", () => {
  /** The recorded daemon (PID 201) died; an unrelated process holds the PID. */
  function recycled(h: ReturnType<typeof harness>, holderToken: string | undefined): void {
    h.addOwn(false);
    // The socket no longer answers: nothing can vouch for the recorded generation.
    h.identity.owner = { running: false };
    if (holderToken !== undefined) {
      h.processes.tokens.set(201, holderToken);
    }
    writeFileSync(h.pidPath, JSON.stringify(h.identity.record));
  }

  test("start proceeds as not running and launches a child without signalling anything", async () => {
    const h = harness();
    recycled(h, "unrelated-process-generation");

    await expect(h.manager.start()).resolves.toBe("started");

    expect(h.calls).toHaveLength(1);
    expect(h.signals).toEqual([]);
  });

  test("stop reports not running, removes the stale record and signals nothing", async () => {
    const h = harness();
    recycled(h, "unrelated-process-generation");

    await h.manager.stop();

    expect(h.signals).toEqual([]);
    expect(existsSync(h.pidPath)).toBe(false);
  });

  test("stop of an already-observed generation treats the exited generation as gone", async () => {
    const h = harness();
    recycled(h, "unrelated-process-generation");
    const observed: DaemonStatus = { ...h.identity.record!, running: true };

    await h.manager.stop(undefined, observed);

    expect(h.signals).toEqual([]);
    expect(existsSync(h.pidPath)).toBe(false);
  });

  test("restart starts a replacement without signalling the reused PID", async () => {
    const h = harness();
    recycled(h, "unrelated-process-generation");
    h.allowDefaultPort();

    await expect(h.manager.restart()).resolves.toBe("restarted");

    expect(h.signals).toEqual([]);
    expect(h.calls).toHaveLength(1);
  });

  test("an unreadable live token keeps refusing to start (never a guess)", async () => {
    const h = harness();
    recycled(h, undefined);

    await expect(h.manager.start()).rejects.toThrow(
      "could not verify the live PID's generation and ownership",
    );

    expect(h.calls).toHaveLength(0);
    expect(h.signals).toEqual([]);
  });

  test("a matching live token is still the recorded daemon and still refuses to start", async () => {
    const h = harness();
    recycled(h, "generation-201");

    await expect(h.manager.start()).rejects.toThrow(
      "could not verify the live PID's generation and ownership",
    );

    expect(h.calls).toHaveLength(0);
    expect(h.signals).toEqual([]);
  });

  test("a token-less record (legacy) is never compared with the live PID", async () => {
    const h = harness();
    recycled(h, "unrelated-process-generation");
    delete h.identity.record!.processGenerationToken;

    await expect(h.manager.start()).rejects.toThrow(
      "could not verify the live PID's generation and ownership",
    );

    expect(h.calls).toHaveLength(0);
    expect(h.signals).toEqual([]);
  });

  test("a stop that cannot verify the live PID still refuses without removing the record", async () => {
    const h = harness();
    recycled(h, undefined);
    const observed: DaemonStatus = { ...h.identity.record!, running: true };

    await expect(h.manager.stop(undefined, observed)).rejects.toThrow(
      "could not verify the live PID's generation and ownership",
    );

    expect(h.signals).toEqual([]);
    expect(existsSync(h.pidPath)).toBe(true);
  });
});

describe("--daemon stop keeps the proof a stale control socket needs (issue #10107)", () => {
  /** A dead daemon (PID 301 is not live) left a PID record; the socket file remains. */
  function deadDaemon(
    h: ReturnType<typeof harness>,
    record: Partial<PidFileData>,
    socketFileExists: boolean,
  ): void {
    const dead: PidFileData = {
      pid: 301,
      socketPath: h.socket,
      port: 3001,
      startedAt: 1,
      version: "test",
      ...record,
    };
    h.identity.record = dead;
    h.identity.exists = socketFileExists;
    writeFileSync(h.pidPath, JSON.stringify(dead));
  }

  const committed = { entryScript: "/opt/auto-mobile/index.js", buildId: "deadbeefcafef00d" };

  test("a committed dead record stays while the socket file it names is still on disk", async () => {
    const h = harness();
    deadDaemon(h, committed, true);

    await h.manager.stop();

    expect(existsSync(h.pidPath)).toBe(true);
    expect(h.signals).toEqual([]);
  });

  test("a dead record carrying a superseded committed owner stays too", async () => {
    const h = harness();
    deadDaemon(h, { supersededOwner: { pid: 299 } }, true);

    await h.manager.stop();

    expect(existsSync(h.pidPath)).toBe(true);
  });

  test("a committed dead record is still removed when no socket file remains", async () => {
    const h = harness();
    deadDaemon(h, committed, false);

    await h.manager.stop();

    expect(existsSync(h.pidPath)).toBe(false);
  });

  test("a dead record that proves no former socket owner is still removed", async () => {
    const h = harness();
    deadDaemon(h, {}, true);

    await h.manager.stop();

    expect(existsSync(h.pidPath)).toBe(false);
  });
});

describe("--daemon stop keeping a dead record x the unit-test launch-log guard (#10107 x #10030)", () => {
  const committed = { entryScript: "/opt/auto-mobile/index.js", buildId: "deadbeefcafef00d" };

  /** A dead committed daemon (PID 301) left its record and its socket file behind. */
  function deadCommittedDaemon(h: ReturnType<typeof harness>): void {
    const dead: PidFileData = {
      pid: 301,
      socketPath: h.socket,
      port: 3001,
      startedAt: 1,
      version: "test",
      ...committed,
    };
    h.identity.record = dead;
    h.identity.exists = true;
    // The listener died with its daemon: a probe of the leftover file is refused.
    h.identity.onProbe = () => {
      throw new Error("connect ECONNREFUSED");
    };
    writeFileSync(h.pidPath, JSON.stringify(dead));
  }

  function launchLogs(): string[] {
    const logsDir = join(isolatedDataDir!, "logs");
    return existsSync(logsDir)
      ? readdirSync(logsDir).filter((name) => name.startsWith("daemon-launch-"))
      : [];
  }

  test("the kept dead record does not stop the next start, whose launch log lands in the data-dir override", async () => {
    const h = harness();
    deadCommittedDaemon(h);

    await h.manager.stop();
    expect(existsSync(h.pidPath)).toBe(true);
    expect(launchLogs()).toEqual([]);

    await expect(h.manager.start()).resolves.toBe("started");

    expect(h.calls).toHaveLength(1);
    expect(h.signals).toEqual([]);
    expect(launchLogs()).toHaveLength(1);
  });

  test("without a data-dir override the guard refuses the start before spawning, and the kept record survives", async () => {
    const h = harness();
    deadCommittedDaemon(h);
    await h.manager.stop();
    const overrides = [
      "AUTOMOBILE_DATA_DIR",
      "AUTO_MOBILE_DATA_DIR",
      "AUTOMOBILE_LOG_DIR",
      "AUTO_MOBILE_LOG_DIR",
    ];
    const saved = overrides.map((key) => [key, process.env[key]] as const);
    for (const key of overrides) {
      delete process.env[key];
    }
    try {
      await expect(h.manager.start()).rejects.toThrow(
        "Unit test is about to write to the real AutoMobile logs directory",
      );
    } finally {
      for (const [key, value] of saved) {
        if (value !== undefined) {
          process.env[key] = value;
        }
      }
    }

    expect(h.calls).toHaveLength(0);
    expect(h.signals).toEqual([]);
    expect(existsSync(h.pidPath)).toBe(true);
    expect(launchLogs()).toEqual([]);
  });
});
