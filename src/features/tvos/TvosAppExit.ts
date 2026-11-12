import { TvosAppExitError } from "./TvosAppExitError";
export { TvosAppExitError } from "./TvosAppExitError";
import {
  SimulatorIosCrashBackend,
  findIosSimulatorAppProcess,
  type SimulatorCrashCommandRunner,
} from "../../utils/ios-cmdline-tools/IosCrashBackend";
import { SimCtlClient } from "../../utils/ios-cmdline-tools/SimCtlClient";
import { SimctlCommandTimeoutError } from "../../utils/ios-cmdline-tools/SimctlCommandTimeoutError";
import { logger } from "../../utils/logger";
import { raceWithDeadline } from "../../utils/raceWithDeadline";
import { defaultTimer, type Timer } from "../../utils/SystemTimer";
import {
  IosSimulatorCrashReportFinder,
  nodeCrashReportFileSystem,
} from "../crashReports/IosSimulatorCrashReportFinder";
import type { NativeCrashReportFinder } from "../crashReports/NativeCrashReport";

const LIVENESS_PROBE_TIMEOUT_MS = 4000;
const APP_EXIT_DIAGNOSIS_TIMEOUT_MS = 6000;

export interface TvosAppLiveness {
  isRunning(bundleId: string, signal?: AbortSignal): Promise<boolean>;
}

/** Reuses crashApp's launchctl transport and exact bundle-id process matcher. */
export function simulatorTvosAppLiveness(
  deviceId: string,
  simctl: SimulatorCrashCommandRunner = new SimCtlClient(),
): TvosAppLiveness {
  const backend = new SimulatorIosCrashBackend(deviceId, simctl, "system");
  return {
    async isRunning(bundleId, signal) {
      const result = await backend.listProcesses({ timeoutMs: LIVENESS_PROBE_TIMEOUT_MS, signal });
      return findIosSimulatorAppProcess(result.stdout, bundleId) !== null;
    },
  };
}

/** Best-effort diagnosis after a sent command loses the runner, never part of its success path. */
export class TvosAppExit {
  constructor(
    private readonly dependencies: {
      liveness: TvosAppLiveness;
      finder: NativeCrashReportFinder;
      timer?: Timer;
    },
  ) {}

  async diagnose(
    bundleId: string,
    commandType: string,
    notBeforeTimestampMs: number,
    signal?: AbortSignal,
  ): Promise<TvosAppExitError | undefined> {
    const controller = new AbortController();
    const combined = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
    let exited = false;
    try {
      return await raceWithDeadline(
        async () => {
          let running: boolean;
          try {
            running = await this.dependencies.liveness.isRunning(bundleId, combined);
          } catch (error) {
            if (!(error instanceof SimctlCommandTimeoutError)) {
              throw error;
            }
            combined.throwIfAborted();
            logger.warn(
              `[TvosRunner] App liveness probe timed out for ${bundleId}; retrying`,
              error,
            );
            running = await this.dependencies.liveness.isRunning(bundleId, combined);
          }
          if (running) {
            return undefined;
          }
          combined.throwIfAborted();
          exited = true;
          const lookup = await this.dependencies.finder.find({
            appId: bundleId,
            notBeforeTimestampMs,
            signal: combined,
          });
          return new TvosAppExitError(
            bundleId,
            commandType,
            lookup.status === "found" ? lookup.report : undefined,
          );
        },
        {
          timer: this.dependencies.timer ?? defaultTimer,
          timeoutMs: APP_EXIT_DIAGNOSIS_TIMEOUT_MS,
          signal: combined,
          label: "tvOS app-exit diagnosis",
          onTimeout: () => controller.abort(),
        },
      );
    } catch (error) {
      signal?.throwIfAborted();
      logger.warn(`[TvosRunner] App-exit diagnosis failed for ${bundleId}`, error);
      return exited ? new TvosAppExitError(bundleId, commandType) : undefined;
    } finally {
      controller.abort();
    }
  }
}

export function createTvosAppExit(deviceId: string, timer?: Timer): TvosAppExit {
  return new TvosAppExit({
    timer,
    liveness: simulatorTvosAppLiveness(deviceId),
    finder: new IosSimulatorCrashReportFinder(deviceId, nodeCrashReportFileSystem),
  });
}
