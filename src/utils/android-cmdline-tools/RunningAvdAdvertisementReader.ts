import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { homedir, tmpdir } from "node:os";
import { logger } from "../logger";
import { AMBIENT_ENV, readEnvRaw } from "../../config/env";
import { sortedReaddirSync } from "../io";
import { isProcessRunning } from "../processLiveness";

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
  /**
   * The adb serials (`emulator-<console port>`) of the live processes advertising `avdName`, read
   * from each advertisement's `port.serial`. Lets a caller name an emulator the device scan could
   * not (another daemon's, which is not enriched, #16339). Same failure contract as
   * {@link isAvdAdvertisedRunning}.
   */
  advertisedSerials(avdName: string): Promise<string[]>;
}

export interface AdvertisementHost {
  platform: NodeJS.Platform;
  homeDir: string;
  tmpDir: string;
  env: Readonly<Record<string, string | undefined>>;
}

export function netsimDiscoveryDir(
  host: Pick<AdvertisementHost, "platform" | "tmpDir" | "env">,
): string {
  // Measured on macOS: netsimd -i N writes netsim_N.ini in os.tmpdir().
  if (host.platform === "darwin" || host.platform === "win32") {
    return host.tmpDir;
  }
  // netsim's GetDiscoveryDirectory on Linux: non-empty $TMPDIR, then $XDG_RUNTIME_DIR, then the temp dir.
  return (
    readEnvRaw(AMBIENT_ENV.TMPDIR, host.env) ||
    readEnvRaw(AMBIENT_ENV.XDG_RUNTIME_DIR, host.env) ||
    host.tmpDir
  );
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
    const xdgRuntimeDir = readEnvRaw(AMBIENT_ENV.XDG_RUNTIME_DIR, host.env);
    const user =
      readEnvRaw(AMBIENT_ENV.USER, host.env) ?? readEnvRaw(AMBIENT_ENV.LOGNAME, host.env);
    if (xdgRuntimeDir) {
      roots.push(xdgRuntimeDir);
    } else if (user) {
      roots.push(join("/tmp", `android-${user}`));
    }
  }
  roots.push(host.tmpDir);
  return [...new Set(roots.map((root) => join(root, "avd", "running")))];
}

/** The advertisement directories for this process's host. */
export function defaultRunningAvdAdvertisementDirs(): string[] {
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
    return this.runningDirs.some(
      (runningDir) => this.liveAdvertisementsIn(runningDir, avdName, true).length > 0,
    );
  }

  async advertisedSerials(avdName: string): Promise<string[]> {
    return this.runningDirs.flatMap((runningDir) =>
      this.liveAdvertisementsIn(runningDir, avdName, false).flatMap((content) => {
        const port = Number.parseInt(content.match(/^port\.serial=(\d+)$/m)?.[1] ?? "", 10);
        return Number.isInteger(port) && port > 0 ? [`emulator-${port}`] : [];
      }),
    );
  }

  /** The contents of live advertisements of `avdName` in one directory; `firstOnly` stops at one. */
  private liveAdvertisementsIn(runningDir: string, avdName: string, firstOnly: boolean): string[] {
    if (!existsSync(runningDir)) {
      // Expected miss, not a failure: only one candidate exists per host, and
      // the emulator creates it lazily, so it stays at debug level.
      logger.debug(`No running-AVD advertisement directory at ${runningDir}`);
      return [];
    }

    const pidFiles = sortedReaddirSync(runningDir)
      .filter((file) => file.startsWith("pid_") && file.endsWith(".ini"))
      // Sorted so a scan reads the directory in the same order every time.
      .sort();

    const live: string[] = [];
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
      if (!this.isProcessAlive(pid)) {
        logger.debug(`Stale advertisement for AVD '${avdName}' (PID ${pid} is not running)`);
        continue;
      }
      logger.info(`AVD '${avdName}' is advertised as running by PID ${pid}`);
      live.push(content);
      if (firstOnly) {
        break;
      }
    }

    return live;
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
  // EPERM means the PID exists but belongs to another user, so only a
  // confirmed ESRCH (or a Linux zombie) reads as dead (#11103).
  return isProcessRunning(pid, {
    debugLog: (message, error) => logger.debug(`Advertised PID ${pid}: ${message}`, error),
  });
}
