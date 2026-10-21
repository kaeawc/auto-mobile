import { expect, test } from "bun:test";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { readProcessGenerationTokenForPid } from "../../../src/daemon/daemonFiles";
import { forceStopHostRecorder } from "../../../src/features/video/hostRecorderTeardown";

const standIn = `
  process.on("SIGINT", () => {
    require("node:fs").writeFileSync(process.env.TEST_HOST_RECORDER_MARKER, "finalized");
    process.exit(0);
  });
  setInterval(() => {}, 1000);
  process.stdout.write("ready\\n");
`;

test.skipIf(readProcessGenerationTokenForPid(process.pid) === undefined)(
  "persisted identity stops a detached recorder with SIGINT and protects a mismatched generation",
  async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "host-recorder-teardown-"));
    const children: ChildProcess[] = [];
    const start = async (capturePath: string) => {
      const child = spawn(process.execPath, ["-e", standIn], {
        env: { ...process.env, TEST_HOST_RECORDER_MARKER: capturePath },
        stdio: ["ignore", "pipe", "pipe"],
      });
      children.push(child);
      const exit = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
        (resolve, reject) => {
          child.once("error", reject);
          child.once("exit", (code, signal) => resolve({ code, signal }));
        },
      );
      await new Promise<void>((resolve, reject) => {
        child.once("error", reject);
        child.stdout!.once("data", () => resolve());
      });
      const hostPid = child.pid!;
      const hostStartToken = readProcessGenerationTokenForPid(hostPid);
      expect(hostStartToken).toBeDefined();
      return {
        child,
        exit,
        descriptor: {
          kind: "ios-host-recorder" as const,
          hostPid,
          hostStartToken: hostStartToken!,
          udid: "stand-in",
          capturePath,
        },
      };
    };
    try {
      const first = await start(path.join(directory, "finalized.mov"));
      // Only the persisted identity is passed to recovery, as after losing the daemon's handle.
      await forceStopHostRecorder(first.descriptor);
      expect(await first.exit).toEqual({ code: 0, signal: null });
      expect(await readFile(first.descriptor.capturePath, "utf8")).toBe("finalized");

      const second = await start(path.join(directory, "untouched.mov"));
      await forceStopHostRecorder({ ...second.descriptor, hostStartToken: "wrong-token" });
      expect(second.child.exitCode).toBeNull();
      expect(second.child.signalCode).toBeNull();
      expect(readProcessGenerationTokenForPid(second.descriptor.hostPid)).toBe(
        second.descriptor.hostStartToken,
      );
      await expect(readFile(second.descriptor.capturePath, "utf8")).rejects.toMatchObject({
        code: "ENOENT",
      });
    } finally {
      for (const child of children) {
        if (child.exitCode === null && child.signalCode === null) {
          const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
          child.kill("SIGKILL");
          await exited;
        }
      }
      await rm(directory, { recursive: true, force: true });
    }
  },
);
