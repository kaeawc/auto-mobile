import { readGuardFile } from "./astGuard";
import { describe, expect, test } from "bun:test";
import { readdirSync } from "node:fs";
import { join, posix, sep } from "node:path";

const REPO_ROOT = join(import.meta.dir, "../..");

// The daemon tier is scanned alongside the server tier because server modules keep moving
// into src/daemon (daemon import direction, #13839, #13841); a scope limited to src/server
// silently dropped those managers from the ratchet (#14524, #14526).
const SCANNED_DIRS = ["src/server", "src/daemon"];

// Existing hooks are a ratchet keyed by repo-relative path: lower or remove an allowance as
// callers migrate to injection. An allowance above a file's count, or naming a file outside the
// scanned dirs, fails too, so a relocation must carry its allowance to the new path.
const ALLOWLIST: Record<string, number> = {
  "src/daemon/deviceSnapshotManager.ts": 1,
  "src/daemon/videoRecordingManager.ts": 1,
  "src/daemon/videoStreamSocketDefaults.ts": 1,
  "src/daemon/webrtcStreamManager.ts": 1,
  "src/server/videoRecordingSegments.ts": 1,
};

const HOOK_PATTERN =
  /export function (set|reset)[A-Z]\w*(Factory|ForTesting|ForTests|Dependencies)\b/g;

function scannedFiles(): string[] {
  return SCANNED_DIRS.flatMap((dir) =>
    readdirSync(join(REPO_ROOT, dir), { recursive: true, encoding: "utf8" })
      .filter((name) => name.endsWith(".ts"))
      .map((name) => posix.join(dir, name.split(sep).join("/"))),
  ).sort();
}

describe("server tool test seams", () => {
  test("does not add process-global factory or dependency hooks", () => {
    const files = scannedFiles();
    const violations: string[] = [];
    for (const file of files) {
      const count = [...readGuardFile(join(REPO_ROOT, file)).matchAll(HOOK_PATTERN)].length;
      const allowed = ALLOWLIST[file] ?? 0;
      if (count > allowed) {
        violations.push(`${file}: ${count} hooks exceeds allowance ${allowed}`);
      } else if (count < allowed) {
        violations.push(`${file}: ${count} hooks is below allowance ${allowed}; lower it`);
      }
    }
    const scanned = new Set(files);
    for (const file of Object.keys(ALLOWLIST).filter((key) => !scanned.has(key))) {
      violations.push(`${file}: allowance names a file outside ${SCANNED_DIRS.join(", ")}`);
    }
    expect(
      violations,
      "Inject dependencies via register*/create*Handler instead of exported set/reset test hooks.",
    ).toEqual([]);
  });
});
