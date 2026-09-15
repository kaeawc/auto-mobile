import { describe, expect, test } from "bun:test";
import {
  createCurrentProcessGenerationTokenProvider,
  createLinuxProcessGenerationTokenReader,
  readDarwinProcessGenerationToken,
} from "../../src/daemon/processGeneration";

describe("current daemon process generation tokens", () => {
  test("captures the Linux token directly once and caches it for later Daemon construction", () => {
    const readPaths: string[] = [];
    const readLinux = createLinuxProcessGenerationTokenReader((path) => {
      readPaths.push(path);
      return path === "/proc/42/stat"
        ? `42 (auto-mobile) ${["S", ...Array(18).fill("0"), "424242"].join(" ")}`
        : "boot-id";
    });
    let reads = 0;
    const provider = createCurrentProcessGenerationTokenProvider({
      platform: "linux",
      pid: 42,
      readLinuxProcessGenerationToken: (pid) => {
        reads++;
        return readLinux(pid);
      },
    });

    expect(provider()).toBe("linux:boot-id:424242");
    expect(provider()).toBe("linux:boot-id:424242");
    expect(reads).toBe(1);
    expect(readPaths).toEqual(["/proc/42/stat", "/proc/sys/kernel/random/boot_id"]);
  });

  test("uses a direct, locale-stable Darwin single-PID query", () => {
    const calls: Array<{
      command: string;
      args: readonly string[];
      options: { timeout: number; env: NodeJS.ProcessEnv };
    }> = [];

    expect(
      readDarwinProcessGenerationToken(42, (command, args, options) => {
        calls.push({ command, args, options });
        return "Sun Nov 1 01:30:00 2026\n";
      }),
    ).toBe("darwin:Sun Nov 1 01:30:00 2026");
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      command: "ps",
      args: ["-p", "42", "-o", "lstart="],
      options: { timeout: 1_000, env: { LC_ALL: "C" } },
    });
  });

  test("preserves Windows' optional-token behavior without an OS read", () => {
    let reads = 0;
    const provider = createCurrentProcessGenerationTokenProvider({
      platform: "win32",
      readLinuxProcessGenerationToken: () => {
        reads++;
        return "linux:boot:1";
      },
      readDarwinProcessGenerationToken: () => {
        reads++;
        return "darwin:Sun Nov 1 01:30:00 2026";
      },
    });

    expect(provider()).toBeUndefined();
    expect(provider()).toBeUndefined();
    expect(reads).toBe(0);
  });

  test("fails closed and caches an unavailable direct capture", () => {
    let reads = 0;
    const provider = createCurrentProcessGenerationTokenProvider({
      platform: "linux",
      readLinuxProcessGenerationToken: () => {
        reads++;
        throw new Error("procfs unavailable");
      },
    });

    expect(provider()).toBeUndefined();
    expect(provider()).toBeUndefined();
    expect(reads).toBe(1);
  });
});
