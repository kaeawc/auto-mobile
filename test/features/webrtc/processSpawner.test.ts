import { describe, expect, test } from "bun:test";
import type { ChildProcess, SpawnOptions } from "node:child_process";
import { createDefaultProcessSpawner } from "../../../src/features/webrtc/processSpawner";

describe("default process spawner", () => {
  test("delegates to the host process executor with piped output", () => {
    const child = { pid: 123 } as ChildProcess;
    const calls: Array<{ command: string; args: string[]; options: SpawnOptions | undefined }> = [];
    const spawn = createDefaultProcessSpawner({
      spawn(command, args, options) {
        calls.push({ command, args, options });
        return child;
      },
    });

    expect(spawn("encoder", ["--fast"])).toBe(child);
    expect(calls).toEqual([
      { command: "encoder", args: ["--fast"], options: { stdio: ["ignore", "pipe", "pipe"] } },
    ]);
  });
});
