import { ActionableError, toActionableError } from "../../models/ActionableError";
import { errorMessage } from "../../models/describeUnknownError";
import type { SimCtl } from "../../utils/ios-cmdline-tools/SimCtlClient";
import { hasSimctlTimeoutCause } from "../../utils/ios-cmdline-tools/SimctlCommandTimeoutError";
import { logger } from "../../utils/logger";
import type { Timer } from "../../utils/SystemTimer";
import {
  MEASURE_STARTUP_DEFAULT_ITERATIONS,
  type MeasureStartupRequest,
  type MeasureStartupResult,
} from "./AndroidStartupMeasurement";
import { parseIosSceneReady } from "./iosSceneReadyParsing";
import { summarizeStartupSamples } from "./startupLaunchParsing";

export type IosStartupSimulator = Pick<SimCtl, "executeCommandArgs">;

interface IosStartupTiming {
  preLaunchIdleMs: number;
  sceneReadyTimeoutMs: number;
  pollMs: number;
}

const DEFAULT_TIMING: IosStartupTiming = {
  preLaunchIdleMs: 500,
  sceneReadyTimeoutMs: 10_000,
  pollMs: 250,
};

const COMMAND_TIMEOUT_MS = 15_000;
// Keep the launch request in view through both the launch command and the ready poll.
const LOG_LOOKBACK = "30s";

function validateSimulatorOptions(request: MeasureStartupRequest): void {
  if (request.mode === "hot") {
    throw new ActionableError("iOS has no hot start distinct from warm. Use warm or cold.");
  }
  if (request.dropCaches) {
    throw new ActionableError("dropCaches is Android-only. Simulator cannot evict caches.");
  }
  if (
    (request.compilation !== undefined && request.compilation !== "asIs") ||
    request.waitForFullyDrawn ||
    request.activity !== undefined
  ) {
    throw new ActionableError(
      "Non-asIs compilation, waitForFullyDrawn, and activity are Android-only. Omit them on iOS.",
    );
  }
}

export class IosStartupMeasurement {
  constructor(
    private readonly deviceId: string,
    private readonly simulator: IosStartupSimulator,
    private readonly timer: Pick<Timer, "now" | "sleep">,
    private readonly timing: IosStartupTiming = DEFAULT_TIMING,
  ) {}

  async measure(
    request: MeasureStartupRequest,
    signal?: AbortSignal,
  ): Promise<MeasureStartupResult> {
    validateSimulatorOptions(request);
    const { appId, mode } = request;
    const iterations = request.iterations ?? MEASURE_STARTUP_DEFAULT_ITERATIONS;
    let previousPid: string | undefined;
    if (mode === "warm") {
      await this.terminate(appId, signal);
      previousPid = (await this.launchAndWait(appId, signal)).pid;
    }

    const launchState: string[] = [];
    const samples: number[] = [];
    for (let index = 0; index < iterations; index++) {
      if (mode === "cold") {
        await this.terminate(appId, signal);
      } else {
        await this.run("launch", "com.apple.springboard", signal);
      }
      await this.timer.sleep(this.timing.preLaunchIdleMs);
      const { pid, ttidMs } = await this.launchAndWait(appId, signal);
      launchState.push(pid === previousPid ? "WARM" : "COLD");
      previousPid = pid;
      if (ttidMs !== null) {
        samples.push(ttidMs);
      }
    }

    const ttid = summarizeStartupSamples(samples);
    if (!ttid) {
      throw new ActionableError(
        `No scene-ready log line was seen after any launch of ${appId}. ` +
          "The app may have crashed, or the Simulator runtime may log scene readiness differently.",
      );
    }
    const warnings: string[] = [];
    if (mode === "cold") {
      warnings.push("Simulator cannot evict caches; cold means the app process was terminated.");
    }
    if (samples.length < iterations) {
      warnings.push(
        `${iterations - samples.length} of ${iterations} launches logged no scene-ready event.`,
      );
    }
    const expected = mode.toUpperCase();
    const mismatches = launchState.filter((state) => state !== expected);
    if (mismatches.length > 0) {
      warnings.push(
        `${mismatches.length} of ${iterations} launches reported a launch state other than ${expected}: ` +
          `${mismatches[0]}. Classification uses the app process ID.`,
      );
    }
    return {
      appId,
      component: appId,
      mode,
      iterations,
      compilation: "asIs",
      ttid,
      launchState,
      waitTimeMs: [],
      warnings,
    };
  }

  private async run(command: "terminate" | "launch", appId: string, signal?: AbortSignal) {
    signal?.throwIfAborted();
    try {
      return await this.simulator.executeCommandArgs(
        [command, this.deviceId, appId],
        COMMAND_TIMEOUT_MS,
        signal,
      );
    } catch (error) {
      signal?.throwIfAborted();
      throw toActionableError(error, `Simulator could not ${command} ${appId}`);
    }
  }

  private async terminate(appId: string, signal?: AbortSignal): Promise<void> {
    try {
      await this.run("terminate", appId, signal);
    } catch (error) {
      signal?.throwIfAborted();
      if (!errorMessage(error).toLowerCase().includes("found nothing to terminate")) {
        throw toActionableError(error, `Simulator could not terminate ${appId}`);
      }
      // The app is already stopped, which is the desired state before this launch.
      logger.debug(`[measureStartup] ${appId} was already stopped`);
    }
  }

  private async launchAndWait(appId: string, signal?: AbortSignal) {
    const args = [
      "spawn",
      this.deviceId,
      "log",
      "show",
      "--last",
      LOG_LOOKBACK,
      "--style",
      "ndjson",
      "--predicate",
      'subsystem == "com.apple.FrontBoard" AND ' +
        '(eventMessage CONTAINS "Received request to open" OR eventMessage CONTAINS "scene content state changed") AND ' +
        `eventMessage CONTAINS "${appId}"`,
    ];
    // A recent launch can still be in the lookback window, especially after warm priming.
    const beforeLaunch = await this.readLog(args, appId, signal);
    const { stdout } = await this.run("launch", appId, signal);
    const prefix = `${appId}: `;
    const launchOutput = stdout.trim();
    const pid = launchOutput.slice(prefix.length);
    if (!launchOutput.startsWith(prefix) || !/^[1-9]\d*$/.test(pid)) {
      throw new ActionableError(
        `Simulator launch did not report a process ID for ${appId}. Check that the app launched.`,
      );
    }

    const deadline = this.timer.now() + this.timing.sceneReadyTimeoutMs;
    for (
      let remainingMs = deadline - this.timer.now();
      remainingMs > 0;
      remainingMs = deadline - this.timer.now()
    ) {
      const log = await this.readLog(args, appId, signal, remainingMs);
      if (!log) {
        break;
      }
      if (
        log.requestTimestampMs !== null &&
        log.requestTimestampMs > (beforeLaunch?.requestTimestampMs ?? -Infinity) &&
        log.ttidMs !== null
      ) {
        return { pid, ttidMs: log.ttidMs };
      }
      const delay = Math.min(this.timing.pollMs, deadline - this.timer.now());
      if (delay > 0) {
        await this.timer.sleep(delay);
      }
    }
    return { pid, ttidMs: null };
  }

  private async readLog(
    args: string[],
    appId: string,
    signal?: AbortSignal,
    pollTimeoutMs?: number,
  ) {
    signal?.throwIfAborted();
    try {
      const { stdout } = await this.simulator.executeCommandArgs(
        args,
        pollTimeoutMs ?? COMMAND_TIMEOUT_MS,
        signal,
      );
      return parseIosSceneReady(stdout, appId);
    } catch (error) {
      signal?.throwIfAborted();
      if (pollTimeoutMs === undefined || !hasSimctlTimeoutCause(error)) {
        throw toActionableError(error, `Could not read Simulator launch logs for ${appId}`);
      }
      // A log read can exhaust the remaining scene-ready polling budget.
      logger.debug(`[measureStartup] Simulator launch log poll timed out: ${error}`);
      return null;
    }
  }
}
