import { describe, expect, test } from "bun:test";
import { Daemon, type DaemonShutdownDependencies } from "../../src/daemon/daemon";
import { FakeTimer } from "../fakes/FakeTimer";

describe("Daemon shutdown", () => {
  test("cleans child process owners before closing the database", async () => {
    const calls: string[] = [];
    const shutdownDependencies: DaemonShutdownDependencies = {
      cleanupChildProcesses: async () => {
        calls.push("child-process-cleanup");
      },
      cleanupDaemonFiles: async () => {
        calls.push("daemon-files");
      },
      closeDatabase: async () => {
        calls.push("close-database");
      },
      closeLogger: () => {},
    };
    const daemon = new Daemon(
      {},
      undefined,
      new FakeTimer(),
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      process.env,
      shutdownDependencies
    );

    await daemon.stop();

    expect(calls).toEqual(["child-process-cleanup", "daemon-files", "close-database"]);
  });
});
