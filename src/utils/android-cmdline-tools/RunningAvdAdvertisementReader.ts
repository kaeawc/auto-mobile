import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { homedir, tmpdir } from "node:os";
import { logger } from "../logger";
import { sortedReaddirSync } from "../io";

/**
 * Reads the host-side advertisement an emulator process writes while it owns an
 * AVD, so a launch guard can ask "does some process on this host already run
 * this AVD?" without depending on ADB having named the runtime yet.
 *
 * This is a SECONDARY signal only, and deliberately narrow (one method). #6407
 * found no advertisements under `os.tmpdir()` on macOS because the emulator
 * advertises elsewhere there (see {@link runningAvdAdvertisementDirs}, #11103);
 * a `false` here still means "no advertisement", never "not running". The
 * primary guards are this process's in-flight launch registry and the
 * console-port-correlated device scan.
 */
export interface RunningAvdAdvertisementReader {
  /**
   * Whether a LIVE process on this host advertises `avdName` as running.
   *
   * Throws when the SCAN itself fails so the caller can surface it per the
   * error-handling convention instead of collapsing every failure into `false`.
   * A single unreadable advertisement is warned about and skipped, so one stale
   * entry cannot hide a live target (#6407).
   */
  isAvdAdvertisedRunning(avdName: string): Promise<boolean>;
}

export interface AdvertisementHost {
  platform: NodeJS.Platform;
  homeDir: string;
  tmpDir: string;
  env: Readonly<Record<string, string | undefined>>;
}

/**
 * Candidate `avd/running` discovery directories, most specific first. The
 * emulator (`EmulatorAdvertisement` / `ConfigDirs::getDiscoveryDirectory`)
 * advertises under `$HOME/Library/Caches/TemporaryItems` on macOS and under
 * `$XDG_RUNTIME_DIR` on Linux, falling back to its temp dir
 * (`/tmp/android-<user>`) when that is unset (#11103). `os.tmpdir()` is kept as
 * the historical candidate (it is the Windows `%LOCALAPPDATA%\Temp` location).
 */
export function runningAvdAdvertisementDirs(host: AdvertisementHost): string[] {
  const roots: string[] = [];
  if (host.platform === "darwin") {
    roots.push(join(host.homeDir, "Library", "Caches", "TemporaryItems"));
  } else if (host.platform !== "win32") {
    const xdgRuntimeDir = host.env.XDG_RUNTIME_DIR;
    const user = host.env.USER ?? host.env.LOGNAME;
    if (xdgRuntimeDir) {
      roots.push(xdgRuntimeDir);
    } else if (user) {
      roots.push(join("/tmp", `android-${user}`));
    }
  }
  roots.push(host.tmpDir);
  return [...new Set(roots.map((root) => join(root, "avd", "running")))];
}

function defaultRunningAvdAdvertisementDirs(): string[] {
  return runningAvdAdvertisementDirs({
    platform: process.platform,
    homeDir: homedir(),
    tmpDir: tmpdir(),
    env: process.env,
  });
}

/**
 * Default reader over `<discovery dir>/avd/running/pid_<pid>.ini`, the location
 * the Android emulator uses to advertise running instances on the platforms
 * where it does so at all.
 */
export class TmpdirRunningAvdAdvertisementReader implements RunningAvdAdvertisementReader {
  private readonly runningDirs: readonly string[];

  constructor(
    runningDirs: string | readonly string[] = defaultRunningAvdAdvertisementDirs(),
    private readonly isProcessAlive: (pid: number) => boolean = defaultIsProcessAlive,
  ) {
    this.runningDirs = typeof runningDirs === "string" ? [runningDirs] : runningDirs;
  }

  async isAvdAdvertisedRunning(avdName: string): Promise<boolean> {
    for (const runningDir of this.runningDirs) {
      if (this.isAdvertisedIn(runningDir, avdName)) {
        return true;
      }
    }
    return false;
  }

  private isAdvertisedIn(runningDir: string, avdName: string): boolean {
    if (!existsSync(runningDir)) {
      // Expected miss, not a failure: only one candidate exists per host, and
      // the emulator creates it lazily, so it stays at debug level.
      logger.debug(`No running-AVD advertisement directory at ${runningDir}`);
      return false;
    }

    const pidFiles = sortedReaddirSync(runningDir)
      .filter((file) => file.startsWith("pid_") && file.endsWith(".ini"))
      // Sorted so a scan reads the directory in the same order every time.
      .sort();

    for (const file of pidFiles) {
      const pid = parsePidFromAdvertisementFileName(file);
      if (pid === undefined) {
        continue;
      }
      const content = this.readAdvertisement(runningDir, file);
      if (content === undefined) {
        continue;
      }
      if (content.match(/^avd\.id=(.+)$/m)?.[1] !== avdName) {
        continue;
      }
      if (this.isProcessAlive(pid)) {
        logger.info(`AVD '${avdName}' is advertised as running by PID ${pid}`);
        return true;
      }
      logger.debug(`Stale advertisement for AVD '${avdName}' (PID ${pid} is not running)`);
    }

    return false;
  }

  /**
   * One advertisement's contents, or `undefined` when that single entry cannot
   * be read. Entries are isolated on purpose: a pid file that disappears
   * between the directory listing and the read is routine, and letting it throw
   * would hide every advertisement after it in the scan and report the AVD as
   * not running (#6407).
   */
  private readAdvertisement(runningDir: string, file: string): string | undefined {
    try {
      return readFileSync(join(runningDir, file), "utf-8");
    } catch (error) {
      logger.warn(`Failed to read running-AVD advertisement ${file}: ${error}`, error);
      return undefined;
    }
  }
}

function parsePidFromAdvertisementFileName(file: string): number | undefined {
  const pidMatch = file.match(/^pid_(\d+)\.ini$/);
  return pidMatch ? parseInt(pidMatch[1], 10) : undefined;
}

function defaultIsProcessAlive(pid: number): boolean {
  try {
    // Signal 0 probes for existence without delivering a signal.
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // ESRCH is the expected answer for a stale advertisement.
    logger.debug(`Advertised PID ${pid} is not alive: ${error}`);
    return false;
  }
}
