import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { SafeDaemonManager } from "../fakes/SafeDaemonManager";
import { FakeLockOwnerGenerationProbe } from "../fakes/FakeLockOwnerGenerationProbe";
import { FakeTimer } from "../fakes/FakeTimer";
import { useScratchRoot } from "../helpers/scratchRoot";
import { formatLockContent, parseLockContent } from "../../src/utils/fileLock";

interface HolderReader {
  readStartupLockHolder(): {
    present: boolean;
    livePid: number | undefined;
    token: string | undefined;
  };
}

describe("startup lock holder generation", () => {
  const scratch = useScratchRoot("startup-holder-generation-");
  function fixture(
    verdict: "same" | "different" | "unknown" | "throws",
    generation: string | undefined = "linux:boot:old",
  ) {
    const root = scratch.next();
    const lockPath = join(root, "lock");
    const probe = new FakeLockOwnerGenerationProbe();
    if (verdict === "throws") {
      probe.compareError = new Error("sample unavailable");
    } else {
      probe.verdict = verdict;
    }
    const manager = new SafeDaemonManager({
      timer: new FakeTimer(),
      lockFilePath: lockPath,
      pidFilePath: join(root, "pid"),
      socketPath: join(root, "socket"),
      processFinder: { findDaemonProcesses: () => [], isProcessRunning: () => true },
      platform: "linux",
      lockOwnerGenerationProbe: probe,
    });
    const body = formatLockContent(9999, "old-owner", "", generation || undefined);
    writeFileSync(lockPath, body);
    return { manager, reader: manager as unknown as HolderReader, lockPath, body, probe };
  }

  test("reads a provably different live generation as dead, then reclaims with the same probe", () => {
    const { manager, reader, lockPath, probe } = fixture("different");
    expect(reader.readStartupLockHolder()).toEqual({
      present: false,
      livePid: undefined,
      token: "old-owner",
    });
    expect(probe.compareCalls).toEqual([{ pid: 9999, recorded: "linux:boot:old" }]);
    try {
      expect(manager.acquireLock()).toBe(true);
      expect(parseLockContent(readFileSync(lockPath, "utf8")).generation).toBe(probe.token);
      expect(probe.compareCalls).toEqual([
        { pid: 9999, recorded: "linux:boot:old" },
        { pid: 9999, recorded: "linux:boot:old" },
      ]);
      expect(probe.currentCalls).toEqual([process.pid, process.pid]);
    } finally {
      manager.releaseLock();
    }
    expect(existsSync(lockPath)).toBe(false);
  });

  test.each(["same", "unknown", "throws"] as const)("keeps a live holder on %s", (verdict) => {
    const { manager, reader, lockPath, body, probe } = fixture(verdict);
    expect(reader.readStartupLockHolder()).toMatchObject({
      present: true,
      livePid: 9999,
      token: "old-owner",
    });
    expect(manager.acquireLock()).toBe(false);
    expect(readFileSync(lockPath, "utf8")).toBe(body);
    expect(probe.compareCalls).toHaveLength(2);
  });

  test("a legacy lock without line 4 keeps PID-only behavior", () => {
    const { manager, reader, lockPath, body, probe } = fixture("different", "");
    expect(reader.readStartupLockHolder()).toMatchObject({
      present: true,
      livePid: 9999,
      token: "old-owner",
    });
    expect(manager.acquireLock()).toBe(false);
    expect(readFileSync(lockPath, "utf8")).toBe(body);
    expect(probe.compareCalls).toEqual([]);
  });
});
