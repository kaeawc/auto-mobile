import { utimes } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  resolveDeviceSetRoot,
  type SimulatorDeviceSetEnvironment,
} from "../../utils/ios-cmdline-tools/SimulatorTccSqliteClient";

/** The one filesystem call a simulated memory warning needs (#18754). */
export interface MemoryWarningFileSystem {
  utimes(path: string, atime: Date, mtime: Date): Promise<void>;
}

export const nodeMemoryWarningFileSystem: MemoryWarningFileSystem = { utimes };

export interface SimulatorMemoryWarningPathOptions {
  homeDirectory?: string;
  environment?: SimulatorDeviceSetEnvironment;
}

/**
 * `<device set>/<udid>/data/var/run/memory_warning_simulation`. CoreSimulator creates the file
 * UIKit watches it, so a new mtime delivers `didReceiveMemoryWarning` to running apps (#18754).
 * UIKit watches it, so a new mtime delivers `didReceiveMemoryWarning` to the foreground app.
 */
export function simulatorMemoryWarningPath(
  udid: string,
  options: SimulatorMemoryWarningPathOptions = {},
): string {
  const root = resolveDeviceSetRoot(
    options.homeDirectory ?? homedir(),
    options.environment ?? process.env,
  );
  return join(root, udid, "data", "var", "run", "memory_warning_simulation");
}

/**
 * Sets the file's mtime to now, like `touch`. It never creates the file: a missing file means the
 * simulator is not booted, and a new file would not be watched.
 */
export async function touchSimulatorMemoryWarning(
  path: string,
  fileSystem: MemoryWarningFileSystem,
  now: Date,
): Promise<void> {
  await fileSystem.utimes(path, now, now);
}

/** True for the error `utimes` raises when the path does not exist. */
export function isMissingFileError(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}
