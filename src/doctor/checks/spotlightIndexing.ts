import { existsSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { DefaultHostCommandExecutor } from "../../utils/HostCommandExecutor";
import { DOCTOR_EXEC_TIMEOUT_MS } from "../../utils/diagnosticTimeouts";
import { errorMessage } from "../../utils/describeUnknownError";
import { logger } from "../../utils/logger";
import { remainingDoctorProbe } from "../deadline";
import type { CheckResult, DoctorProbeOptions } from "../types";

/** Read-only host operations; no Spotlight configuration commands are exposed. */
export interface SpotlightProbe {
  exists(dir: string): boolean;
  hasMarker(dir: string): boolean;
  indexingStatus(dir: string, timeoutMs: number): Promise<string>;
}

export interface SpotlightDependencies {
  platform?: NodeJS.Platform;
  /** Repository candidate root; defaults to the process cwd. */
  repoRoot?: string;
  homeDir?: string;
  probe?: SpotlightProbe;
}

function defaultProbe(options: DoctorProbeOptions): SpotlightProbe {
  const executor = new DefaultHostCommandExecutor();
  return {
    exists: (dir) => existsSync(dir) && statSync(dir).isDirectory(),
    hasMarker: (dir) => existsSync(join(dir, ".metadata_never_index")),
    indexingStatus: async (dir, timeoutMs) =>
      (
        await executor.executeCommand("mdutil", ["-s", dir], {
          timeoutMs,
          signal: options.signal,
          killSignal: "SIGKILL",
        })
      ).stdout,
  };
}

export async function checkSpotlightIndexing(
  dependencies: SpotlightDependencies = {},
  options: DoctorProbeOptions = {},
): Promise<CheckResult> {
  const name = "Spotlight Indexing";
  if ((dependencies.platform ?? process.platform) !== "darwin") {
    return { name, status: "skip", message: "Spotlight is only available on macOS" };
  }
  try {
    const root = dependencies.repoRoot ?? process.cwd();
    const home = dependencies.homeDir ?? homedir();
    const probe = dependencies.probe ?? defaultProbe(options);
    const candidates = [
      join(root, "scratch"),
      join(root, ".claude/worktrees"),
      join(home, ".auto-mobile"),
      "/tmp/automobile-ctrl-proxy",
      join(home, "Library/Developer/Xcode/DerivedData"),
      join(home, ".gradle"),
    ];
    const indexed: string[] = [];
    for (const dir of candidates) {
      if (!probe.exists(dir) || probe.hasMarker(dir)) continue;
      const current = remainingDoctorProbe(options);
      const status = await probe.indexingStatus(dir, current.timeoutMs ?? DOCTOR_EXEC_TIMEOUT_MS);
      if (!status.includes("Indexing disabled")) indexed.push(dir);
    }
    if (indexed.length === 0) {
      return {
        name,
        status: "pass",
        message: "Existing developer directories are excluded from Spotlight",
      };
    }
    return {
      name,
      status: "warn",
      message: `Developer directories may be indexed by Spotlight (only marker files and volume-wide mdutil status are detected): ${indexed.join(", ")}`,
      recommendation:
        "Drop a marker (`touch <dir>/.metadata_never_index`) or add the directory in " +
        "System Settings > Spotlight > Search Privacy. A directory already excluded via Search Privacy " +
        "may still be listed; ignore it or add the marker to silence this warning. OPTIONAL: run `sudo mdutil -i off <vol>` " +
        "yourself to disable indexing for an entire volume; doctor never changes system settings.",
    };
  } catch (error) {
    logger.warn(`Spotlight indexing check failed: ${errorMessage(error)}`, error);
    return {
      name,
      status: "warn",
      message: `Could not inspect Spotlight indexing: ${errorMessage(error)}`,
    };
  }
}
