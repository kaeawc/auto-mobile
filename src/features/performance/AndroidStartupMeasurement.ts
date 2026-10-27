import { ActionableError } from "../../models/ActionableError";
import type { AdbExecutor } from "../../utils/android-cmdline-tools/interfaces/AdbExecutor";
import { logger } from "../../utils/logger";
import { shellQuote } from "../../utils/shellQuote";
import type { Timer } from "../../utils/SystemTimer";
import {
  parseAmStartWaitOutput,
  parseFullyDrawnReports,
  parseResolvedActivity,
  summarizeStartupSamples,
  type StartupTimingStats,
} from "./startupLaunchParsing";

export type StartupMode = "cold" | "warm" | "hot";
export type StartupCompilationMode = "asIs" | "speed-profile" | "speed" | "verify";

export const MEASURE_STARTUP_DEFAULT_ITERATIONS = 5;
export const MEASURE_STARTUP_MAX_ITERATIONS = 50;

export interface MeasureStartupRequest {
  appId: string;
  activity?: string;
  mode: StartupMode;
  iterations?: number;
  compilation?: StartupCompilationMode;
  dropCaches?: boolean;
  waitForFullyDrawn?: boolean;
}

export interface MeasureStartupResult {
  appId: string;
  component: string;
  mode: StartupMode;
  iterations: number;
  compilation: StartupCompilationMode;
  /** Time to initial display, from `am start -W` `TotalTime`. */
  ttid: StartupTimingStats;
  /** Time to full display, from logcat `Fully drawn`; omitted when the app never reported it. */
  ttfd?: StartupTimingStats;
  /** `LaunchState` per iteration as `am start -W` reported it (API 29+), else `UNKNOWN`. */
  launchState: string[];
  /** `WaitTime` per iteration, ms. */
  waitTimeMs: number[];
  warnings: string[];
}

/** The device surface the measurement needs: shell commands and the device clock. */
export type StartupDeviceShell = Pick<AdbExecutor, "executeCommand" | "getDeviceTimestampMs">;

/** Waits between launch steps; injectable so tests run on a FakeTimer without real delays. */
export interface StartupMeasurementTiming {
  /** Idle after stopping or backgrounding the app, before the measured launch. */
  preLaunchIdleMs: number;
  /** Idle after a launch so the app finishes its startup work before the next iteration. */
  postLaunchSettleMs: number;
  /** Longest wait for `Fully drawn` when `waitForFullyDrawn` is set. */
  fullyDrawnTimeoutMs: number;
  /** Interval between logcat reads while waiting for `Fully drawn`. */
  fullyDrawnPollMs: number;
}

export const DEFAULT_STARTUP_MEASUREMENT_TIMING: StartupMeasurementTiming = {
  preLaunchIdleMs: 500,
  postLaunchSettleMs: 1500,
  fullyDrawnTimeoutMs: 10_000,
  fullyDrawnPollMs: 250,
};

const AM_START_TIMEOUT_MS = 60_000;
const SHELL_TIMEOUT_MS = 15_000;
const COMPILE_TIMEOUT_MS = 180_000;
const LOGCAT_MAX_BUFFER = 1024 * 1024;
const LAUNCHER_INTENT = "-a android.intent.action.MAIN -c android.intent.category.LAUNCHER";
const DROP_CACHES_SCRIPT = "sync; echo 3 > /proc/sys/vm/drop_caches";

type RootShell = "shell" | "su";

interface IterationSample {
  launchState: string;
  totalTimeMs: number | null;
  waitTimeMs: number | null;
  fullyDrawnMs: number | null;
}

/** Checks the schema cannot express; returns the iteration count to run. */
function validateRequest(request: MeasureStartupRequest): number {
  const iterations = request.iterations ?? MEASURE_STARTUP_DEFAULT_ITERATIONS;
  if (
    !Number.isInteger(iterations) ||
    iterations < 1 ||
    iterations > MEASURE_STARTUP_MAX_ITERATIONS
  ) {
    throw new ActionableError(
      `iterations must be an integer from 1 to ${MEASURE_STARTUP_MAX_ITERATIONS}; got ${iterations}.`,
    );
  }
  if (request.dropCaches && request.mode !== "cold") {
    throw new ActionableError(
      "dropCaches only applies to cold starts; set mode to cold or drop it.",
    );
  }
  return iterations;
}

/**
 * Measures Android app startup over repeated launches (#14112). Each iteration
 * runs plain `am` commands: it never goes through `launchApp`, observation or
 * UI settling, so AutoMobile adds no work of its own to the measured launch.
 *
 * - cold: `am force-stop`, optionally drop the page cache (root), then launch.
 * - warm: the process stays alive; the task is cleared so the activity is recreated.
 * - hot: home, then relaunch, so the existing activity is brought back.
 */
export class AndroidStartupMeasurement {
  constructor(
    private readonly shell: StartupDeviceShell,
    private readonly timer: Timer,
    private readonly timing: StartupMeasurementTiming = DEFAULT_STARTUP_MEASUREMENT_TIMING,
  ) {}

  async measure(
    request: MeasureStartupRequest,
    signal?: AbortSignal,
  ): Promise<MeasureStartupResult> {
    const iterations = validateRequest(request);
    const compilation = request.compilation ?? "asIs";
    const rootShell = request.dropCaches ? await this.requireRootShell(signal) : null;
    const component = await this.resolveComponent(request, signal);

    if (compilation !== "asIs") {
      await this.compile(request.appId, compilation, signal);
    }
    if (request.mode !== "cold") {
      await this.prime(request.appId, component, signal);
    }

    const samples: IterationSample[] = [];
    for (let index = 0; index < iterations; index++) {
      signal?.throwIfAborted();
      samples.push(await this.runIteration(request, component, rootShell, signal));
    }
    return this.buildResult(request, component, compilation, samples);
  }

  private async exec(command: string, signal?: AbortSignal, timeoutMs = SHELL_TIMEOUT_MS) {
    signal?.throwIfAborted();
    return this.shell.executeCommand(command, { timeoutMs, noRetry: true, signal });
  }

  private async requireRootShell(signal?: AbortSignal): Promise<RootShell> {
    const direct = await this.exec("shell id", signal);
    if (direct.stdout.includes("uid=0(root)")) {
      return "shell";
    }
    try {
      const su = await this.exec("shell su 0 id", signal);
      if (su.stdout.includes("uid=0(root)")) {
        return "su";
      }
    } catch (error) {
      signal?.throwIfAborted();
      // No su binary is the normal case on user builds; the refusal below explains it.
      logger.debug(`[measureStartup] su probe failed: ${error}`);
    }
    throw new ActionableError(
      "dropCaches needs a root shell (adb root or su), and this device has neither. " +
        "Use an emulator image without Google Play, or leave dropCaches off.",
    );
  }

  private async resolveComponent(
    request: MeasureStartupRequest,
    signal?: AbortSignal,
  ): Promise<string> {
    if (request.activity) {
      return request.activity.includes("/")
        ? request.activity
        : `${request.appId}/${request.activity}`;
    }
    const result = await this.exec(
      `shell cmd package resolve-activity --brief ${LAUNCHER_INTENT} ${shellQuote(request.appId)}`,
      signal,
    );
    const component = parseResolvedActivity(result.stdout, request.appId);
    if (!component) {
      throw new ActionableError(
        `No launcher activity found for ${request.appId}. Check that it is installed, or pass activity.`,
      );
    }
    return component;
  }

  private async compile(
    appId: string,
    mode: StartupCompilationMode,
    signal?: AbortSignal,
  ): Promise<void> {
    const result = await this.exec(
      `shell cmd package compile -m ${mode} -f ${shellQuote(appId)}`,
      signal,
      COMPILE_TIMEOUT_MS,
    );
    if (!/Success/.test(result.stdout)) {
      const output = `${result.stdout}\n${result.stderr}`.trim();
      throw new ActionableError(
        `cmd package compile -m ${mode} failed for ${appId}: ${output || "no output"}`,
      );
    }
  }

  /** Warm and hot starts need a live process (and, for hot, a live activity) to start from. */
  private async prime(appId: string, component: string, signal?: AbortSignal): Promise<void> {
    await this.exec(`shell am force-stop ${shellQuote(appId)}`, signal);
    await this.launch(component, false, signal);
    await this.timer.sleep(this.timing.postLaunchSettleMs);
  }

  private async prepare(
    request: MeasureStartupRequest,
    rootShell: RootShell | null,
    signal?: AbortSignal,
  ): Promise<void> {
    if (request.mode === "cold") {
      await this.exec(`shell am force-stop ${shellQuote(request.appId)}`, signal);
      if (rootShell) {
        const script = shellQuote(DROP_CACHES_SCRIPT);
        await this.exec(
          rootShell === "shell" ? `shell sh -c ${script}` : `shell su 0 sh -c ${script}`,
          signal,
        );
      }
    } else {
      await this.exec("shell input keyevent KEYCODE_HOME", signal);
    }
    await this.timer.sleep(this.timing.preLaunchIdleMs);
  }

  private async launch(component: string, clearTask: boolean, signal?: AbortSignal) {
    const flags = clearTask ? " --activity-clear-task" : "";
    const result = await this.exec(
      `shell am start -W ${LAUNCHER_INTENT}${flags} -n ${shellQuote(component)}`,
      signal,
      AM_START_TIMEOUT_MS,
    );
    const parsed = parseAmStartWaitOutput(`${result.stdout}\n${result.stderr}`);
    if (parsed.error) {
      throw new ActionableError(`am start failed for ${component}: ${parsed.error}`);
    }
    return parsed;
  }

  private async runIteration(
    request: MeasureStartupRequest,
    component: string,
    rootShell: RootShell | null,
    signal?: AbortSignal,
  ): Promise<IterationSample> {
    await this.prepare(request, rootShell, signal);
    const launchedAtMs = await this.shell.getDeviceTimestampMs();
    const launched = await this.launch(component, request.mode === "warm", signal);
    const fullyDrawnMs = await this.readFullyDrawn(request, launchedAtMs, signal);
    await this.timer.sleep(this.timing.postLaunchSettleMs);
    return {
      launchState: launched.launchState ?? "UNKNOWN",
      totalTimeMs: launched.totalTimeMs,
      waitTimeMs: launched.waitTimeMs,
      fullyDrawnMs,
    };
  }

  /** The first `Fully drawn` the app logged since this launch; polls when asked to wait. */
  private async readFullyDrawn(
    request: MeasureStartupRequest,
    sinceMs: number,
    signal?: AbortSignal,
  ): Promise<number | null> {
    const since = `${Math.floor(sinceMs / 1000)}.${String(sinceMs % 1000).padStart(3, "0")}`;
    const command = `shell logcat -d -v epoch -T ${shellQuote(since)} -s ActivityTaskManager:I ActivityManager:I`;
    const deadline =
      this.timer.now() + (request.waitForFullyDrawn ? this.timing.fullyDrawnTimeoutMs : 0);
    for (;;) {
      signal?.throwIfAborted();
      const output = await this.shell.executeCommand(command, {
        timeoutMs: SHELL_TIMEOUT_MS,
        maxBuffer: LOGCAT_MAX_BUFFER,
        noRetry: true,
        signal,
      });
      const [first] = parseFullyDrawnReports(output.stdout, request.appId, sinceMs);
      if (first) {
        return first.fullyDrawnMs;
      }
      if (this.timer.now() >= deadline) {
        return null;
      }
      await this.timer.sleep(this.timing.fullyDrawnPollMs);
    }
  }

  private buildResult(
    request: MeasureStartupRequest,
    component: string,
    compilation: StartupCompilationMode,
    samples: IterationSample[],
  ): MeasureStartupResult {
    const warnings: string[] = [];
    const ttidSamples = samples.flatMap((sample) =>
      sample.totalTimeMs === null ? [] : [sample.totalTimeMs],
    );
    const ttid = summarizeStartupSamples(ttidSamples);
    if (!ttid) {
      throw new ActionableError(
        `am start -W reported no TotalTime for ${component} in ${samples.length} launches; ` +
          "the activity may already have been in front, or the launch timed out.",
      );
    }
    if (ttidSamples.length < samples.length) {
      warnings.push(
        `${samples.length - ttidSamples.length} of ${samples.length} launches reported no TotalTime.`,
      );
    }

    const expected = request.mode.toUpperCase();
    const mismatched = samples.filter(
      (sample) => !sample.launchState.startsWith("UNKNOWN") && sample.launchState !== expected,
    );
    if (mismatched.length > 0) {
      warnings.push(
        `${mismatched.length} of ${samples.length} launches reported a launch state other than ${expected}: ` +
          `${[...new Set(mismatched.map((sample) => sample.launchState))].join(", ")}.`,
      );
    }

    const ttfdSamples = samples.flatMap((sample) =>
      sample.fullyDrawnMs === null ? [] : [sample.fullyDrawnMs],
    );
    const ttfd = summarizeStartupSamples(ttfdSamples);
    if (!ttfd) {
      warnings.push(
        request.waitForFullyDrawn
          ? `No "Fully drawn" report within ${this.timing.fullyDrawnTimeoutMs} ms of any launch; ` +
              "TTFD is omitted. The app must call Activity.reportFullyDrawn()."
          : 'No "Fully drawn" report was logged; TTFD is omitted. Set waitForFullyDrawn if the app calls ' +
              "Activity.reportFullyDrawn() after its first frame.",
      );
    } else if (ttfdSamples.length < samples.length) {
      warnings.push(
        `${samples.length - ttfdSamples.length} of ${samples.length} launches logged no "Fully drawn".`,
      );
    }

    return {
      appId: request.appId,
      component,
      mode: request.mode,
      iterations: samples.length,
      compilation,
      ttid,
      ...(ttfd ? { ttfd } : {}),
      launchState: samples.map((sample) => sample.launchState),
      waitTimeMs: samples.flatMap((sample) =>
        sample.waitTimeMs === null ? [] : [sample.waitTimeMs],
      ),
      warnings,
    };
  }
}
