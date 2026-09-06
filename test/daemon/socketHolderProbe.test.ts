import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LsofSocketHolderProbe, parseLsofHolderPids } from "../../src/daemon/socketHolderProbe";
import type { ExecFileAsync } from "../../src/utils/HostCommandExecutor";

type NodeExecError = Error & { code?: number | string; stdout?: string; stderr?: string };

function lsofNoMatchError(): NodeExecError {
  // lsof's documented "no match" exit: given an explicit path argument, exits 1
  // with BOTH stdout and stderr empty when nothing has it open.
  const error = new Error("Command failed: lsof -Fp -- <path>") as NodeExecError;
  error.code = 1;
  error.stdout = "";
  error.stderr = "";
  return error;
}

function lsofBadPathError(): NodeExecError {
  const error = new Error("Command failed: lsof -Fp -- <path>") as NodeExecError;
  error.code = 1;
  error.stdout = "";
  error.stderr = "lsof: status error on <path>: No such file or directory\n";
  return error;
}

function lsofMissingBinaryError(): NodeExecError {
  const error = new Error("spawn lsof ENOENT") as NodeExecError;
  error.code = "ENOENT";
  return error;
}

describe("parseLsofHolderPids", () => {
  test("parses one PID per p<pid> line, de-duplicated", () => {
    expect(parseLsofHolderPids("p123\np456\np123\n")).toEqual([123, 456]);
  });

  test("ignores lines that are not p<pid>", () => {
    expect(parseLsofHolderPids("p123\nf3\nn/tmp/socket\n")).toEqual([123]);
  });

  test("returns an empty array for empty stdout", () => {
    expect(parseLsofHolderPids("")).toEqual([]);
  });
});

describe("LsofSocketHolderProbe", () => {
  const tempDirs: string[] = [];

  function createTempSocketPathFile(): string {
    const dir = mkdtempSync(join(tmpdir(), "socket-holder-probe-test-"));
    tempDirs.push(dir);
    const socketPath = join(dir, "daemon.sock");
    writeFileSync(socketPath, "placeholder");
    return socketPath;
  }

  function cleanup(): void {
    for (const dir of tempDirs) {
      rmSync(dir, { recursive: true, force: true });
    }
    tempDirs.length = 0;
  }

  test("returns the live PIDs holding the socket path on a successful lsof match", async () => {
    const socketPath = createTempSocketPathFile();
    try {
      const execAsync: ExecFileAsync = async () => ({ stdout: "p123\np456\n", stderr: "" });
      const probe = new LsofSocketHolderProbe(execAsync, "darwin");

      await expect(probe.getHolderPids(socketPath)).resolves.toEqual([123, 456]);
    } finally {
      cleanup();
    }
  });

  test("returns an empty (confirmed) array on lsof's documented no-match exit", async () => {
    const socketPath = createTempSocketPathFile();
    try {
      const execAsync: ExecFileAsync = async () => {
        throw lsofNoMatchError();
      };
      const probe = new LsofSocketHolderProbe(execAsync, "darwin");

      await expect(probe.getHolderPids(socketPath)).resolves.toEqual([]);
    } finally {
      cleanup();
    }
  });

  test("returns undefined (inconclusive) when lsof reports a genuine error", async () => {
    const socketPath = createTempSocketPathFile();
    try {
      const execAsync: ExecFileAsync = async () => {
        throw lsofBadPathError();
      };
      const probe = new LsofSocketHolderProbe(execAsync, "darwin");

      await expect(probe.getHolderPids(socketPath)).resolves.toBeUndefined();
    } finally {
      cleanup();
    }
  });

  test("returns undefined (inconclusive) when the lsof binary itself is missing", async () => {
    const socketPath = createTempSocketPathFile();
    try {
      const execAsync: ExecFileAsync = async () => {
        throw lsofMissingBinaryError();
      };
      const probe = new LsofSocketHolderProbe(execAsync, "darwin");

      await expect(probe.getHolderPids(socketPath)).resolves.toBeUndefined();
    } finally {
      cleanup();
    }
  });

  test("returns undefined (inconclusive) on a simulated win32 platform without shelling out", async () => {
    const socketPath = createTempSocketPathFile();
    try {
      let execCalls = 0;
      const execAsync: ExecFileAsync = async () => {
        execCalls++;
        return { stdout: "p123\n", stderr: "" };
      };
      const probe = new LsofSocketHolderProbe(execAsync, "win32");

      await expect(probe.getHolderPids(socketPath)).resolves.toBeUndefined();
      expect(execCalls).toBe(0);
    } finally {
      cleanup();
    }
  });

  test("returns an empty (confirmed) array without shelling out when the path does not exist", async () => {
    const dir = mkdtempSync(join(tmpdir(), "socket-holder-probe-missing-test-"));
    try {
      const nonExistentPath = join(dir, "does-not-exist.sock");
      let execCalls = 0;
      const execAsync: ExecFileAsync = async () => {
        execCalls++;
        return { stdout: "", stderr: "" };
      };
      const probe = new LsofSocketHolderProbe(execAsync, "darwin");

      await expect(probe.getHolderPids(nonExistentPath)).resolves.toEqual([]);
      expect(execCalls).toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
