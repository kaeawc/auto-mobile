import { describe, expect, spyOn, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runDaemonCommand } from "../../src/daemon/cli/runDaemonCommand";
import type { DaemonStatus } from "../../src/daemon/types";
import { SafeDaemonManager } from "../fakes/SafeDaemonManager";

async function runStatus(status: DaemonStatus, args: string[]) {
  const stdout: string[] = [];
  const exits: unknown[] = [];
  const exited = new Error("fake exit");
  class Manager extends SafeDaemonManager {
    override async status() {
      return status;
    }
    override findOtherDaemonProcesses() {
      return [];
    }
  }
  const log = spyOn(console, "log").mockImplementation((text) => {
    stdout.push(String(text));
  });
  const exit = spyOn(process, "exit").mockImplementation((code) => {
    exits.push(code);
    throw exited;
  });
  // status lists forwarding leases from the coordination dir; read an empty one.
  const coordinationDir = mkdtempSync(join(tmpdir(), "daemon-status-exit-coord-"));
  const previousCoordinationDir = process.env.AUTOMOBILE_COORDINATION_DIR;
  process.env.AUTOMOBILE_COORDINATION_DIR = coordinationDir;
  try {
    await runDaemonCommand("status", args, {}, Manager).catch((error) => {
      if (error !== exited) {
        throw error;
      }
    });
  } finally {
    exit.mockRestore();
    log.mockRestore();
    if (previousCoordinationDir === undefined) {
      delete process.env.AUTOMOBILE_COORDINATION_DIR;
    } else {
      process.env.AUTOMOBILE_COORDINATION_DIR = previousCoordinationDir;
    }
    rmSync(coordinationDir, { recursive: true, force: true });
  }
  return { stdout, exits };
}

const unauthenticated: DaemonStatus = {
  running: false,
  recovery: { state: "unauthenticated", reason: "no version identity" },
};

// #11252: status exited 0 ("Daemon is not running") while a foreign process held the socket.
describe("daemon status exit code and --json", () => {
  test("an unauthenticated socket owner exits 1", async () => {
    const { stdout, exits } = await runStatus(unauthenticated, []);
    expect(stdout.slice(0, 2)).toEqual([
      "  Identity recovery: unauthenticated (no version identity)",
      "Daemon socket is held by a process that is not an authenticated daemon",
    ]);
    expect(exits).toEqual([1]);
  });

  test("--json prints the status object and keeps the exit code", async () => {
    const { stdout, exits } = await runStatus(unauthenticated, ["--json"]);
    expect(stdout.map((line) => JSON.parse(line))).toEqual([unauthenticated]);
    expect(exits).toEqual([1]);
  });

  test("a plain not-running daemon still exits 0", async () => {
    const { stdout, exits } = await runStatus({ running: false }, ["--json"]);
    expect(stdout.map((line) => JSON.parse(line))).toEqual([{ running: false }]);
    expect(exits).toEqual([]);
  });
});
