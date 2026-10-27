import {
  AdbClientFactory,
  defaultAdbClientFactory,
} from "../../utils/android-cmdline-tools/AdbClientFactory";
import type { AdbExecutor } from "../../utils/android-cmdline-tools/interfaces/AdbExecutor";
import { logger } from "../../utils/logger";
import { BootedDevice, DisplayedLogcatTag, DisplayedTimeMetric } from "../../models";
import { NoOpPerformanceTracker, PerformanceTracker } from "../../utils/PerformanceTracker";

interface DisplayedTimeCaptureOptions {
  packageName: string;
  startTimestampMs: number;
  endTimestampMs: number;
}

// AdbExecutor extended with optional AdbClient-specific methods
// Budget and output cap for the logcat dump that is scanned for "Displayed" lines.
const LOGCAT_DISPLAYED_TIMEOUT_MS = 5000;
const LOGCAT_DISPLAYED_MAX_BUFFER = 1024 * 1024;

type ExtendedAdbExecutor = AdbExecutor & { getAndroidApiLevel?: () => Promise<number | null> };

export async function getPreferredDisplayedLogcatTag(
  adb: AdbExecutor,
): Promise<DisplayedLogcatTag> {
  const extendedAdb = adb as ExtendedAdbExecutor;
  if (typeof extendedAdb.getAndroidApiLevel === "function") {
    const apiLevel = await extendedAdb.getAndroidApiLevel();
    if (apiLevel !== null && apiLevel >= 29) {
      return "ActivityTaskManager";
    }
  }
  return "ActivityManager";
}

export function parseDisplayedDurationMs(value: string): number | null {
  const trimmed = value.replace("+", "").trim();
  const secondsWithMsMatch = trimmed.match(/^(\d+)s(\d+)ms$/);
  if (secondsWithMsMatch) {
    return (
      Number.parseInt(secondsWithMsMatch[1], 10) * 1000 + Number.parseInt(secondsWithMsMatch[2], 10)
    );
  }
  const msMatch = trimmed.match(/^(\d+)ms$/);
  if (msMatch) {
    return Number.parseInt(msMatch[1], 10);
  }
  const secondsMatch = trimmed.match(/^(\d+)s$/);
  if (secondsMatch) {
    return Number.parseInt(secondsMatch[1], 10) * 1000;
  }
  return null;
}

/** One `ActivityManager`/`ActivityTaskManager` line of `logcat -v epoch` output. */
export interface ActivityManagerLogcatLine {
  timestampMs: number;
  logcatTag: DisplayedLogcatTag;
  message: string;
}

/**
 * Parse one `logcat -v epoch` line from the activity manager. Shared by the
 * `Displayed` (TTID) and `Fully drawn` (TTFD) readers so both agree on format.
 */
export function parseActivityManagerLogcatLine(line: string): ActivityManagerLogcatLine | null {
  // Allow leading whitespace - logcat epoch format often has spaces before timestamp
  const match = line.match(/^\s*(\d+\.\d+)\s+\d+\s+\d+\s+[VDIWEF]\s+(\w+):\s+(.*)$/);
  if (!match) {
    return null;
  }

  const timestampSeconds = Number.parseFloat(match[1]);
  if (Number.isNaN(timestampSeconds)) {
    return null;
  }

  const logcatTag = match[2];
  if (logcatTag !== "ActivityManager" && logcatTag !== "ActivityTaskManager") {
    return null;
  }

  return {
    timestampMs: Math.round(timestampSeconds * 1000),
    logcatTag,
    message: match[3],
  };
}

/** The `pkg/.Activity` component a `Displayed` or `Fully drawn` message names. */
export function extractTimingComponentName(
  message: string,
  marker: "Displayed" | "Fully drawn",
): string | null {
  const pattern =
    marker === "Displayed"
      ? /Displayed\s+(\S+?)(?:\s+for user \d+)?:/
      : /Fully drawn\s+(\S+?)(?:\s+for user \d+)?:/;
  const match = message.match(pattern);
  return match ? match[1] : null;
}

/** Split a `pkg/.Activity` component, expanding a relative activity name. */
export function parseLaunchComponent(component: string): {
  packageName: string;
  activityName: string;
  componentName: string;
} {
  const [packageName, activityPart] = component.split("/");
  let activityName = activityPart ?? "";

  if (activityName.startsWith(".")) {
    activityName = `${packageName}${activityName}`;
  }

  return {
    packageName,
    activityName,
    componentName: component,
  };
}

/** The `+1s234ms` duration a `Displayed` or `Fully drawn` message carries. */
export function extractLaunchDurationMs(message: string): number | null {
  const durationMatch = message.match(/\+\s*\d+(?:s\d+ms|ms|s)/);
  if (!durationMatch) {
    return null;
  }

  return parseDisplayedDurationMs(durationMatch[0]);
}

export class DisplayedTimeMetricsCollector {
  private adb: ExtendedAdbExecutor;
  private device: BootedDevice;
  private logcatTagCache: DisplayedLogcatTag | undefined;

  constructor(
    device: BootedDevice,
    adbFactoryOrExecutor: AdbClientFactory | AdbExecutor | null = defaultAdbClientFactory,
  ) {
    this.device = device;
    // Detect if the argument is a factory (has create method) or an executor
    if (
      adbFactoryOrExecutor &&
      typeof (adbFactoryOrExecutor as AdbClientFactory).create === "function"
    ) {
      this.adb = (adbFactoryOrExecutor as AdbClientFactory).create(device);
    } else if (adbFactoryOrExecutor) {
      this.adb = adbFactoryOrExecutor as ExtendedAdbExecutor;
    } else {
      this.adb = defaultAdbClientFactory.create(device);
    }
  }

  async captureDisplayedMetrics(
    options: DisplayedTimeCaptureOptions,
    perf: PerformanceTracker = new NoOpPerformanceTracker(),
  ): Promise<DisplayedTimeMetric[]> {
    if (this.device.platform !== "android") {
      logger.info(`[DisplayedTimeMetrics] Skipping - not Android platform`);
      return [];
    }

    const logcatTag = await this.getPreferredLogcatTag();
    logger.info(`[DisplayedTimeMetrics] Using logcat tag: ${logcatTag}`);
    const cmd = this.buildLogcatCommand(logcatTag);
    logger.info(`[DisplayedTimeMetrics] Logcat command: ${cmd}`);
    try {
      const { stdout } = await perf.track("adbLogcatDisplayed", () =>
        this.adb.executeCommand(cmd, {
          timeoutMs: LOGCAT_DISPLAYED_TIMEOUT_MS,
          maxBuffer: LOGCAT_DISPLAYED_MAX_BUFFER,
        }),
      );
      logger.info(`[DisplayedTimeMetrics] Logcat output length: ${stdout.length} chars`);
      const metrics = this.parseDisplayedMetrics(stdout, options);
      logger.info(
        `[DisplayedTimeMetrics] Parsed ${metrics.length} metrics for package ${options.packageName} (window: ${options.startTimestampMs} - ${options.endTimestampMs})`,
      );
      return metrics;
    } catch (error) {
      logger.warn(`[DisplayedTimeMetrics] Failed to read logcat: ${error}`);
      return [];
    }
  }

  async getPreferredLogcatTag(): Promise<DisplayedLogcatTag> {
    if (this.logcatTagCache) {
      return this.logcatTagCache;
    }

    this.logcatTagCache = await getPreferredDisplayedLogcatTag(this.adb);
    return this.logcatTagCache;
  }

  private buildLogcatCommand(tag: DisplayedLogcatTag): string {
    return `shell logcat -d -v epoch -s ${tag}:I`;
  }

  parseDisplayedMetrics(
    output: string,
    options: DisplayedTimeCaptureOptions,
  ): DisplayedTimeMetric[] {
    const metrics: DisplayedTimeMetric[] = [];
    const lines = output.split("\n");

    // Find all "Displayed" lines for debugging
    const displayedLines = lines.filter((l) => l.includes("Displayed"));
    logger.info(
      `[DisplayedTimeMetrics] Found ${displayedLines.length} 'Displayed' lines in logcat`,
    );
    if (displayedLines.length > 0) {
      logger.info(
        `[DisplayedTimeMetrics] Last few Displayed lines: ${displayedLines.slice(-3).join(" | ")}`,
      );
    }

    for (const line of lines) {
      const parsedLine = parseActivityManagerLogcatLine(line);
      if (!parsedLine) {
        continue;
      }

      const { timestampMs, logcatTag, message } = parsedLine;

      if (timestampMs < options.startTimestampMs || timestampMs > options.endTimestampMs) {
        // Log if we're filtering out a Displayed line due to timestamp
        if (message.includes("Displayed") && message.includes(options.packageName)) {
          logger.info(
            `[DisplayedTimeMetrics] Filtered by timestamp: logcatTs=${timestampMs}, window=[${options.startTimestampMs}, ${options.endTimestampMs}]`,
          );
        }
        continue;
      }

      const component = extractTimingComponentName(message, "Displayed");
      if (!component) {
        continue;
      }

      const componentInfo = parseLaunchComponent(component);
      if (componentInfo.packageName !== options.packageName) {
        continue;
      }

      const displayedTimeMs = extractLaunchDurationMs(message);
      if (displayedTimeMs === null) {
        continue;
      }

      logger.info(
        `[DisplayedTimeMetrics] Found metric: ${componentInfo.componentName} = ${displayedTimeMs}ms`,
      );
      metrics.push({
        packageName: componentInfo.packageName,
        activityName: componentInfo.activityName,
        componentName: componentInfo.componentName,
        displayedTimeMs,
        timestampMs,
        logcatTag,
      });
    }

    return metrics;
  }
}
