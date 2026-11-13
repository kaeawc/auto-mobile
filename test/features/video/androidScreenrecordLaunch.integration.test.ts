import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { chmodSync, writeFileSync } from "node:fs";
import path from "node:path";
import { buildPidReportingScreenrecordArgs } from "../../../src/features/video/androidRecorderPid";
import { useScratchRoot } from "../../helpers/scratchRoot";

// Runs the real launch command under the host sh with stub `setsid` and `screenrecord`
// on PATH, so the fallback is exercised as shell, not as a string (#18243).
describe.skipIf(process.platform === "win32")(
  "Android screenrecord launch command under sh",
  () => {
    const scratch = useScratchRoot("screenrecord-launch-");

    function runLaunch(setsidBody: string): { lines: string[]; status: number | null } {
      const bin = scratch.next();
      const stub = (name: string, body: string) => {
        writeFileSync(path.join(bin, name), `#!/bin/sh\n${body}\n`);
        chmodSync(path.join(bin, name), 0o755);
      };
      stub("setsid", setsidBody);
      stub("screenrecord", 'echo "recording $*"; exit 3');
      const [, command] = buildPidReportingScreenrecordArgs(["screenrecord", "/sdcard/a.mp4"]);
      const run = spawnSync("/bin/sh", ["-c", command], {
        encoding: "utf8",
        env: { PATH: `${bin}${path.delimiter}${process.env.PATH ?? ""}` },
      });
      return { lines: run.stdout.trim().split("\n"), status: run.status };
    }

    test("a working setsid launches the recorder once and keeps its exit status", () => {
      const { lines, status } = runLaunch('exec "$@"');
      expect(lines).toHaveLength(2);
      expect(lines[0]).toMatch(/^\d+$/);
      expect(lines[1]).toBe("recording /sdcard/a.mp4");
      expect(status).toBe(3);
    });

    test.each([126, 127])("setsid exec failure %p falls back to the plain launch", (code) => {
      const { lines, status } = runLaunch(`echo "setsid: exec failed" >&2; exit ${code}`);
      expect(lines).toHaveLength(2);
      expect(lines[0]).toMatch(/^\d+$/);
      expect(lines[1]).toBe("recording /sdcard/a.mp4");
      expect(status).toBe(3);
    });
  },
);
