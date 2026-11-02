import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { ENV, readEnvTrimmed } from "../../config/env";
import type { BootedDevice } from "../../models";
import { ActionableError } from "../../models/ActionableError";
import {
  defaultAdbClientFactory,
  type AdbClientFactory,
} from "../../utils/android-cmdline-tools/AdbClientFactory";
import type { AdbExecutor } from "../../utils/android-cmdline-tools/interfaces/AdbExecutor";
import { errorMessage } from "../../utils/describeUnknownError";
import { logger } from "../../utils/logger";
import { resolvePathFromDaemonLaunchWorkingDirectory } from "../../utils/workingDirectory";
import { shellQuote } from "../../utils/shellQuote";
import { defaultTimer, type Timer } from "../../utils/SystemTimer";
import type {
  DeviceConditionApplyOutcome,
  DeviceConditionInjector,
} from "./DeviceConditionController";
import type { DeviceConditionKey } from "./DeviceConditionTypes";
import { OwedResetError } from "./OwedResetError";
import { adbCommand, createSerializer, rejectValue, shell, unsupported } from "./injectorSupport";
import { LmkPressureBinaryProvider } from "./lmkPressureBinaryProvider";

export const MEMORY_PRESSURE_BINARY = "/data/local/tmp/automobile-lmk-pressure";
export const MEMORY_PRESSURE_PID = `${MEMORY_PRESSURE_BINARY}.pid`;
export const MEMORY_PRESSURE_OUTPUT = `${MEMORY_PRESSURE_BINARY}.out`;
const ARTIFACTS = [MEMORY_PRESSURE_PID, MEMORY_PRESSURE_OUTPUT, MEMORY_PRESSURE_BINARY];
export const MEMORY_PRESSURE_OVERSHOOT_MIB = 128;
export const MEMORY_PRESSURE_MIN_MIB = 256;
export const MEMORY_PRESSURE_MAX_MIB = 16384;
export const MEMORY_PRESSURE_MAX_SECONDS = 1800;
const POLL_MS = 250;
const READY_TIMEOUT_MS = 60_000;
const KILL_WINDOW_MS = 15_000;
const RESET_TIMEOUT_MS = 5_000;

export function parseMemAvailableKb(text: string): number {
  const match = /^MemAvailable:\s+(\d+)\s+kB\s*$/m.exec(text);
  const kb = match ? Number(match[1]) : NaN;
  if (!Number.isSafeInteger(kb) || kb < 0) {
    unsupported("could not read MemAvailable from /proc/meminfo");
  }
  return kb;
}

export function memoryPressureSizeMiB(memAvailableKb: number): number {
  if (!Number.isSafeInteger(memAvailableKb) || memAvailableKb < 0) {
    unsupported("invalid MemAvailable measurement");
  }
  // Exceed MemAvailable to exhaust swap and trigger lmkd; the minimum applies to the payload.
  const size = Math.floor(memAvailableKb / 1024) + MEMORY_PRESSURE_OVERSHOOT_MIB;
  if (size < MEMORY_PRESSURE_MIN_MIB) {
    unsupported("not enough available memory to create pressure");
  }
  return Math.min(size, MEMORY_PRESSURE_MAX_MIB);
}

export function countLmkdKills(text: string): number {
  return text
    .split("\n")
    .filter((line) => /\blowmemorykiller: Kill '[^'\r\n]+' \(\d+\)(?:,|\s|$)/.test(line)).length;
}

/** Resolve from the module's package root, independent of the caller's working directory. */
function resolveBinaryPath(abi: string, env: NodeJS.ProcessEnv): string {
  let root = dirname(fileURLToPath(import.meta.url));
  while (!existsSync(join(root, "package.json")) && dirname(root) !== root) {
    root = dirname(root);
  }
  const override = readEnvTrimmed(ENV.LMK_PRESSURE_DIR, env);
  // The detached daemon chdirs to the user's home, so a relative override must anchor at the launch directory.
  const directory = override
    ? resolvePathFromDaemonLaunchWorkingDirectory(override, env)
    : join(root, "build/lmk-pressure");
  return join(directory, abi, "lmk_pressure");
}

export interface MemoryPressureOptions {
  env?: NodeJS.ProcessEnv;
  timer?: Timer;
  resolveBinaryPath?: (abi: string) => string;
  binaryExists?: (path: string) => boolean | Promise<boolean>;
  /**
   * The checksum-verified release binary for an ABI, or null when the pinned
   * release has none (#16402). Defaults to the shared release download cache.
   */
  releaseBinary?: (abi: "arm64-v8a" | "x86_64") => Promise<string | null>;
}

/** Only argv[0] equal to our exact executable is owned; substrings and reused PIDs are not. */
function identityCommand(pid: string): string {
  return `$(tr '\\000' '\\n' < /proc/${pid}/cmdline 2>/dev/null | head -n 1)`;
}

class MemoryPressureFixture {
  private active = false;
  private owned = false;
  private readonly serialize = createSerializer();
  private readonly timer: Timer;

  constructor(
    private readonly adb: AdbExecutor,
    private readonly options: MemoryPressureOptions,
  ) {
    this.timer = options.timer ?? defaultTimer;
  }

  private async livePids(signal?: AbortSignal): Promise<string[]> {
    const script = `for p in /proc/[0-9]*; do if [ "${identityCommand("${p##*/}")}" = ${shellQuote(MEMORY_PRESSURE_BINARY)} ]; then echo "\${p##*/}"; fi; done`;
    const output = await shell(this.adb, [script], signal);
    return output.split(/\s+/).filter((pid) => /^\d+$/.test(pid));
  }

  async isClean(signal?: AbortSignal): Promise<boolean> {
    const files = await shell(this.adb, ["ls", ...ARTIFACTS, "2>/dev/null;", "true"], signal);
    return files === "" && (await this.livePids(signal)).length === 0;
  }

  private async poll(
    check: () => Promise<boolean>,
    timeout: number,
    signal?: AbortSignal,
  ): Promise<boolean> {
    const deadline = this.timer.now() + timeout;
    while (true) {
      signal?.throwIfAborted();
      if (await check()) {
        return true;
      }
      if (this.timer.now() >= deadline) {
        return false;
      }
      await this.timer.sleep(Math.min(POLL_MS, deadline - this.timer.now()));
    }
  }

  private async restoreNow(signal?: AbortSignal): Promise<void> {
    if (!this.owned) {
      return;
    }
    const recorded = await shell(
      this.adb,
      ["cat", MEMORY_PRESSURE_PID, "2>/dev/null;", "true"],
      signal,
    );
    const pids = new Set(await this.livePids(signal));
    if (/^[1-9]\d*$/.test(recorded)) {
      pids.add(recorded);
    }
    // Include orphaned payloads whose PID file was lost, but guard every kill against PID reuse.
    for (const pid of pids) {
      await shell(
        this.adb,
        [
          `if [ "${identityCommand(pid)}" = ${shellQuote(MEMORY_PRESSURE_BINARY)} ]; then kill -TERM ${pid}; fi`,
        ],
        signal,
      );
    }
    const gone = await this.poll(
      async () => (await this.livePids(signal)).length === 0,
      RESET_TIMEOUT_MS,
      signal,
    );
    if (!gone) {
      throw new ActionableError("memoryPressure process is still alive after reset");
    }
    await shell(this.adb, ["rm", "-f", ...ARTIFACTS], signal);
    if (!(await this.isClean(signal))) {
      throw new ActionableError("memoryPressure artifacts are still present after reset");
    }
    this.owned = false;
    this.active = false;
  }

  readonly reset = (signal?: AbortSignal): Promise<void> =>
    this.serialize(() => this.restoreNow(signal));

  private async rollback(error: unknown): Promise<never> {
    try {
      await this.restoreNow();
    } catch (restoreError) {
      logger.warn(`memoryPressure rollback failed: ${errorMessage(restoreError)}`, restoreError);
      throw new OwedResetError(
        `${errorMessage(error)} Rollback also failed (${errorMessage(restoreError)}); release will retry memoryPressure cleanup.`,
        this.reset,
        { cause: error },
      );
    }
    throw error;
  }

  private async start(path: string, size: number, signal?: AbortSignal): Promise<void> {
    await adbCommand(this.adb, ["push", path, MEMORY_PRESSURE_BINARY], signal);
    await shell(this.adb, ["chmod", "755", MEMORY_PRESSURE_BINARY], signal);
    await shell(
      this.adb,
      [
        `nohup ${MEMORY_PRESSURE_BINARY} ${size} ${MEMORY_PRESSURE_MAX_SECONDS} >${MEMORY_PRESSURE_OUTPUT} 2>&1 </dev/null & echo $! > ${MEMORY_PRESSURE_PID}`,
      ],
      signal,
    );
    const ready = await this.poll(
      async () => {
        const output = await shell(
          this.adb,
          ["cat", MEMORY_PRESSURE_OUTPUT, "2>/dev/null;", "true"],
          signal,
        );
        return output.split("\n").includes(`READY ${size}`);
      },
      READY_TIMEOUT_MS,
      signal,
    );
    if (!ready) {
      unsupported(`memory pressure payload ${size} MiB did not become READY`);
    }
  }

  private async observeKills(since: string, signal?: AbortSignal): Promise<number> {
    let kills = 0;
    await this.poll(
      async () => {
        kills = countLmkdKills(
          await shell(this.adb, ["logcat", "-d", "-b", "all", "-t", shellQuote(since)], signal),
        );
        return kills > 0;
      },
      KILL_WINDOW_MS,
      signal,
    );
    return kills;
  }

  private async binaryPath(signal?: AbortSignal): Promise<string> {
    const abi = await shell(this.adb, ["getprop", "ro.product.cpu.abi"], signal);
    if (abi !== "arm64-v8a" && abi !== "x86_64") {
      unsupported(`memoryPressure does not support ABI ${abi}`);
    }
    const env = this.options.env ?? process.env;
    const path = this.options.resolveBinaryPath
      ? this.options.resolveBinaryPath(abi)
      : resolveBinaryPath(abi, env);
    if (await (this.options.binaryExists ?? existsSync)(path)) {
      return path;
    }
    // An explicit directory is the user's choice: report it rather than download around it.
    if (!readEnvTrimmed(ENV.LMK_PRESSURE_DIR, env)) {
      // The on-disk cache is shared, so a provider per apply does not re-download.
      const released = await (
        this.options.releaseBinary ??
        ((wanted) => new LmkPressureBinaryProvider({ env }).ensure(wanted))
      )(abi);
      if (released) {
        return released;
      }
    }
    return unsupported(
      `missing pressure binary ${path} and no released binary for this AutoMobile version; run bash scripts/android/build-lmk-pressure.sh or set AUTOMOBILE_LMK_PRESSURE_DIR`,
    );
  }

  private async applyNow(
    value: string,
    signal?: AbortSignal,
  ): Promise<DeviceConditionApplyOutcome> {
    if (value !== "on") {
      rejectValue("faults.memoryPressure", value, ["on"]);
    }
    if (this.active && (await this.livePids(signal)).length > 0) {
      return { status: "unchanged", detail: "memory pressure payload is still alive" };
    }
    // Remove stale payloads before measuring available memory.
    this.owned = true;
    try {
      await this.restoreNow(signal);
      const path = await this.binaryPath(signal);
      const memAvailableKb = parseMemAvailableKb(
        await shell(this.adb, ["cat", "/proc/meminfo"], signal),
      );
      const size = memoryPressureSizeMiB(memAvailableKb);
      const since = await shell(this.adb, ["date", "+'%m-%d %H:%M:%S.000'"], signal);
      this.owned = true;
      await this.start(path, size, signal);
      const kills = await this.observeKills(since, signal);
      if (kills === 0) {
        unsupported(
          `memory pressure payload ${size} MiB (sized from MemAvailable ${memAvailableKb} kB): no lmkd kill followed within ${KILL_WINDOW_MS / 1000} seconds`,
        );
      }
      if ((await this.livePids(signal)).length === 0) {
        unsupported(`memory pressure payload ${size} MiB exited after ${kills} lmkd kills`);
      }
      this.active = true;
      return {
        status: "applied",
        detail: `${kills} lmkd kills with ${size} MiB memory pressure payload`,
        reset: this.reset,
      };
    } catch (error) {
      return this.rollback(error);
    }
  }

  readonly apply = (value: string, signal?: AbortSignal): Promise<DeviceConditionApplyOutcome> =>
    this.serialize(() => this.applyNow(value, signal));

  readonly recover = (
    signal?: AbortSignal,
  ): Promise<NonNullable<DeviceConditionApplyOutcome["reset"]> | null> =>
    this.serialize(async () => {
      if (this.active || (await this.isClean(signal))) {
        return null;
      }
      this.owned = true;
      return this.reset;
    });
}

export function createMemoryPressureInjector(
  adb: AdbExecutor,
  options: MemoryPressureOptions = {},
): DeviceConditionInjector {
  const fixture = new MemoryPressureFixture(adb, options);
  return {
    key: "faults.memoryPressure",
    apply: fixture.apply,
    recover: fixture.recover,
    isClean: (signal) => fixture.isClean(signal),
  };
}

export interface MemoryPressureInjectorDeps extends MemoryPressureOptions {
  adbFactory?: AdbClientFactory;
  cache?: Map<string, DeviceConditionInjector>;
}
const injectorsByDevice = new Map<string, DeviceConditionInjector>();

export function resolveMemoryPressureInjector(
  device: BootedDevice,
  key: DeviceConditionKey,
  deps: MemoryPressureInjectorDeps = {},
): DeviceConditionInjector | undefined {
  if (device.platform !== "android" || key !== "faults.memoryPressure") {
    return undefined;
  }
  const cache = deps.cache ?? injectorsByDevice;
  let injector = cache.get(device.deviceId);
  if (!injector) {
    injector = createMemoryPressureInjector(
      (deps.adbFactory ?? defaultAdbClientFactory).create(device),
      deps,
    );
    cache.set(device.deviceId, injector);
  }
  return injector;
}
