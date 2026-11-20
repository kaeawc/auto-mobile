import { PerformanceAuditRepository } from "../../db/performanceAuditRepository";
import type { BootedDevice } from "../../models";
import { toActionableError } from "../../models/ActionableError";
import { currentDeviceSessionUuid } from "../../utils/deviceIncarnation";
import {
  DefaultHostCommandExecutor,
  type HostCommandExecutor,
} from "../../utils/HostCommandExecutor";
import { SimCtlClient } from "../../utils/ios-cmdline-tools/SimCtlClient";
import { logger } from "../../utils/logger";
import { defaultTimer, type Timer } from "../../utils/SystemTimer";
import { findIosSimulatorAppProcessId } from "../action/CrashApp";
import type { ObserveScreen } from "../observe/interfaces/ObserveScreen";
import { RealObserveScreen } from "../observe/ObserveScreen";
import { PerformanceMonitor } from "../performance/PerformanceMonitor";
import {
  getSdkFrameMetricsStore,
  type SdkFrameMetricsStore,
  type SdkFrameSample,
} from "../performance/SdkFrameMetricsStore";
import {
  IOS_AUDIT_WINDOW_MS,
  judgeIosMemory,
  judgeIosPerformance,
} from "./iosPerformanceJudgement";
import type { OnDemandAuditEngines } from "./OnDemandAudit";

const FRAME_POLL_MS = 250;
const PROCESS_COMMAND_TIMEOUT_MS = 5000;

export interface IosAuditProcessSampler {
  resolvePid(appId: string): Promise<number | null>;
  readRssKiB(pid: number): Promise<number | null>;
}

function psProcessDisappeared(error: unknown): boolean {
  const cause = error instanceof Error ? error.cause : undefined;
  return (
    cause instanceof Error &&
    "code" in cause &&
    cause.code === 1 &&
    "stdout" in cause &&
    "stderr" in cause &&
    !String(cause.stdout).trim() &&
    !String(cause.stderr).trim()
  );
}

export function createIosAuditProcessSampler(
  device: BootedDevice,
  simctl: Pick<SimCtlClient, "executeCommandArgs"> = new SimCtlClient(device),
  host: HostCommandExecutor = new DefaultHostCommandExecutor(),
): IosAuditProcessSampler {
  return {
    async resolvePid(appId) {
      const list = await simctl.executeCommandArgs(
        ["spawn", device.deviceId, "launchctl", "list"],
        PROCESS_COMMAND_TIMEOUT_MS,
      );
      return findIosSimulatorAppProcessId(list.stdout, appId);
    },
    async readRssKiB(pid) {
      try {
        const result = await host.executeCommand("ps", ["-o", "rss=", "-p", String(pid)], {
          timeoutMs: PROCESS_COMMAND_TIMEOUT_MS,
        });
        const value = result.stdout.trim();
        const rss = Number(value);
        if (value && Number.isSafeInteger(rss) && rss >= 0) {
          return rss;
        }
        throw new Error("ps did not report a valid RSS value");
      } catch (error) {
        if (psProcessDisappeared(error)) {
          // ps exits 1 when the PID disappears between launchctl and ps.
          logger.debug(`Could not sample RSS for simulator PID ${pid}`, error);
          return null;
        }
        throw toActionableError(error, `Failed to read RSS for simulator PID ${pid}`);
      }
    },
  };
}

interface IosOnDemandAuditDeps {
  observeScreen?: Pick<ObserveScreen, "execute">;
  timer?: Timer;
  frameStore?: Pick<SdkFrameMetricsStore, "getFresh">;
  processSampler?: IosAuditProcessSampler;
  recorder?: Pick<PerformanceAuditRepository, "recordAudit">;
  deviceSessionUuid?: (deviceId: string) => string | null;
}

async function collectFrames(
  deviceId: string,
  appId: string,
  timer: Timer,
  frameStore: Pick<SdkFrameMetricsStore, "getFresh">,
): Promise<SdkFrameSample[]> {
  const samples = new Map<number, SdkFrameSample>();
  const clock = () => timer.monotonicNow?.() ?? timer.now();
  const deadline = clock() + IOS_AUDIT_WINDOW_MS;
  for (;;) {
    const sample = frameStore.getFresh(
      deviceId,
      appId,
      timer.now(),
      PerformanceMonitor.SDK_FRAME_TTL_MS,
    );
    if (sample && !samples.has(sample.receivedAt)) {
      samples.set(sample.receivedAt, sample);
    }
    const remaining = deadline - clock();
    if (remaining <= 0) {
      return [...samples.values()];
    }
    await timer.sleep(Math.min(remaining, FRAME_POLL_MS));
  }
}

export function createIosOnDemandAuditEngines(
  device: BootedDevice,
  {
    observeScreen = new RealObserveScreen(device),
    timer = defaultTimer,
    frameStore = getSdkFrameMetricsStore(),
    processSampler = createIosAuditProcessSampler(device),
    recorder = new PerformanceAuditRepository({ timer }),
    deviceSessionUuid = currentDeviceSessionUuid,
  }: IosOnDemandAuditDeps = {},
): OnDemandAuditEngines {
  return {
    async observe() {
      const result = await observeScreen.execute({
        freshness: "fresh",
        screenshot: "none",
        skipAccessibilityAudit: true,
        skipPerformanceAudit: true,
      });
      return { result };
    },
    async accessibility() {
      throw new Error("The WCAG audit is unavailable on iOS Simulator.");
    },
    async performance(result) {
      const appId = result.activeWindow?.appId;
      if (!appId) {
        return undefined;
      }

      // Capture the device epoch before sampling so a reincarnation cannot reattribute the audit.
      const auditSessionUuid = deviceSessionUuid(device.deviceId);
      const samples = await collectFrames(device.deviceId, appId, timer, frameStore);
      const audit = judgeIosPerformance(appId, samples);
      if ("unsupported" in audit) {
        return audit;
      }
      const timestamp = new Date(timer.now()).toISOString();
      await recorder.recordAudit({
        deviceId: device.deviceId,
        sessionId: timestamp.slice(0, 10),
        packageName: appId,
        timestamp,
        passed: audit.passed,
        metrics: audit.metrics,
        diagnostics: audit.diagnostics,
        deviceSessionUuid: auditSessionUuid,
      });
      return audit;
    },
    async memory(appId) {
      const notRunning = { unsupported: `${appId} is not running on ${device.deviceId}` };
      const pid = await processSampler.resolvePid(appId);
      if (pid === null) {
        return notRunning;
      }
      const start = await processSampler.readRssKiB(pid);
      if (start === null) {
        return notRunning;
      }
      await timer.sleep(IOS_AUDIT_WINDOW_MS);
      const endPid = await processSampler.resolvePid(appId);
      const end = endPid === pid ? await processSampler.readRssKiB(pid) : null;
      if (end === null) {
        return { unsupported: "app restarted during the audit" };
      }
      // iOS memory results are returned only, since memory_audit_results has no device_session_uuid.
      return judgeIosMemory(start, end);
    },
    elements: () => [],
    baselines: {
      async getBaseline() {
        throw new Error("Accessibility baselines are unavailable on iOS Simulator.");
      },
      async saveBaseline() {
        throw new Error("Accessibility baselines are unavailable on iOS Simulator.");
      },
    },
    accessibilityConfig: () => null,
  };
}
