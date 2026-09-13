import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { logger } from "../logger";

/**
 * Reads the host-side advertisement an emulator process writes while it owns an
 * AVD, so a launch guard can ask "does some process on this host already run
 * this AVD?" without depending on ADB having named the runtime yet.
 *
 * This is a SECONDARY signal only, and deliberately narrow (one method). On
 * macOS/Apple silicon the emulator does not advertise instances at all (see
 * #6407's device verification: the advertisement directory does not exist even
 * with two emulators up), so a `false` here means "no advertisement", never
 * "not running". The primary guards are this process's in-flight launch
 * registry and the console-port-correlated device scan.
 */
export interface RunningAvdAdvertisementReader {
  /**
   * Whether a LIVE process on this host advertises `avdName` as running.
   *
   * Throws on an unexpected read failure so the caller can surface it per the
   * error-handling convention instead of collapsing every failure into `false`.
   */
  isAvdAdvertisedRunning(avdName: string): Promise<boolean>;
}

/**
 * Default reader over `${os.tmpdir()}/avd/running/pid_<pid>.ini`, the location
 * the Android emulator uses to advertise running instances on the platforms
 * where it does so at all.
 */
export class TmpdirRunningAvdAdvertisementReader implements RunningAvdAdvertisementReader {
  constructor(
    private readonly runningDir: string = join(tmpdir(), "avd", "running"),
    private readonly isProcessAlive: (pid: number) => boolean = defaultIsProcessAlive,
  ) {}

  async isAvdAdvertisedRunning(avdName: string): Promise<boolean> {
    if (!existsSync(this.runningDir)) {
      // Expected miss, not a failure: most hosts (every macOS host checked in
      // #6407) never create this directory, so it stays at debug level.
      logger.debug(`No running-AVD advertisement directory at ${this.runningDir}`);
      return false;
    }

    const pidFiles = readdirSync(this.runningDir).filter(
      (file) => file.startsWith("pid_") && file.endsWith(".ini"),
    );

    for (const file of pidFiles) {
      const pid = parsePidFromAdvertisementFileName(file);
      if (pid === undefined) {
        continue;
      }
      const content = readFileSync(join(this.runningDir, file), "utf-8");
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
