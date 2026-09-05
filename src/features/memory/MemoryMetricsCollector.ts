import type { AdbExecutor } from "../../utils/android-cmdline-tools/interfaces/AdbExecutor";
import type { AdbClientFactory } from "../../utils/android-cmdline-tools/AdbClientFactory";
import { defaultAdbClientFactory } from "../../utils/android-cmdline-tools/AdbClientFactory";
import { logger } from "../../utils/logger";
import { BootedDevice } from "../../models";
import { PerformanceTracker, NoOpPerformanceTracker } from "../../utils/PerformanceTracker";
import type { MemoryMetricsProvider } from "./interfaces/MemoryMetricsProvider";
import { Timer, defaultTimer } from "../../utils/SystemTimer";

/**
 * Memory snapshot from dumpsys meminfo
 */
export interface MemorySnapshot {
  javaHeapMb: number;
  nativeHeapMb: number;
  totalPssMb: number;
  timestamp: number;
  raw: string;
}

/**
 * GC event parsed from logcat
 */
export interface GCEvent {
  type: string; // GC_FOR_ALLOC, GC_EXPLICIT, etc.
  freedKb: number;
  durationMs: number;
  timestamp: number;
}

/**
 * Unreachable objects data from dumpsys meminfo --unreachable
 */
export interface UnreachableObjectsInfo {
  count: number;
  sizeKb: number;
  raw: string;
}

/**
 * Complete memory metrics collected during audit
 */
export interface MemoryMetrics {
  preSnapshot: MemorySnapshot;
  postSnapshot: MemorySnapshot;
  javaHeapGrowthMb: number;
  nativeHeapGrowthMb: number;
  totalPssGrowthMb: number;
  gcEvents: GCEvent[];
  gcCount: number;
  gcTotalDurationMs: number;
  unreachableObjects: UnreachableObjectsInfo | null;
}

/**
 * Collector for memory metrics via ADB commands
 */
export class MemoryMetricsCollector implements MemoryMetricsProvider {
  private adb: AdbExecutor;
  private device: BootedDevice;
  private timer: Timer;

  constructor(
    device: BootedDevice,
    adbOrFactory: AdbExecutor | AdbClientFactory | null = null,
    timer: Timer = defaultTimer,
  ) {
    this.device = device;
    this.timer = timer;
    // Support both direct AdbExecutor injection and factory injection
    if (adbOrFactory && "create" in adbOrFactory) {
      // It's a factory
      this.adb = adbOrFactory.create(device);
    } else if (adbOrFactory) {
      // It's an AdbExecutor
      this.adb = adbOrFactory;
    } else {
      // Use default factory
      this.adb = defaultAdbClientFactory.create(device);
    }
  }

  /**
   * Take a memory snapshot using dumpsys meminfo
   */
  async takeSnapshot(
    packageName: string,
    perf: PerformanceTracker = new NoOpPerformanceTracker(),
  ): Promise<MemorySnapshot> {
    try {
      const { stdout } = await perf.track("adbMeminfo", () =>
        this.adb.executeCommand(`shell dumpsys meminfo ${packageName}`),
      );

      const metrics = this.parseMeminfo(stdout);

      return {
        javaHeapMb: metrics.javaHeapMb,
        nativeHeapMb: metrics.nativeHeapMb,
        totalPssMb: metrics.totalPssMb,
        timestamp: this.timer.now(),
        raw: stdout,
      };
    } catch (error) {
      logger.warn(`[MemoryMetricsCollector] Failed to take memory snapshot: ${error}`);
      throw error;
    }
  }

  /**
   * Parse dumpsys meminfo output
   */
  private parseMeminfo(output: string): {
    javaHeapMb: number;
    nativeHeapMb: number;
    totalPssMb: number;
  } {
    // Parse Java heap
    // Looking for: "Java Heap:     12345"
    const javaHeapMatch = output.match(/Java Heap:\s+(\d+)/i);
    const javaHeapKb = javaHeapMatch ? parseInt(javaHeapMatch[1], 10) : 0;

    // Parse Native heap
    // Looking for: "Native Heap:   12345"
    const nativeHeapMatch = output.match(/Native Heap:\s+(\d+)/i);
    const nativeHeapKb = nativeHeapMatch ? parseInt(nativeHeapMatch[1], 10) : 0;

    // Parse Total PSS
    // Looking for: "TOTAL:         12345" or "TOTAL PSS:     12345"
    const totalPssMatch = output.match(/TOTAL(?:\s+PSS)?:\s+(\d+)/i);
    const totalPssKb = totalPssMatch ? parseInt(totalPssMatch[1], 10) : 0;

    return {
      javaHeapMb: javaHeapKb / 1024,
      nativeHeapMb: nativeHeapKb / 1024,
      totalPssMb: totalPssKb / 1024,
    };
  }

  /**
   * Trigger explicit GC on the target app
   */
  async triggerGC(
    packageName: string,
    perf: PerformanceTracker = new NoOpPerformanceTracker(),
  ): Promise<void> {
    try {
      logger.info(`[MemoryMetricsCollector] Triggering explicit GC for ${packageName}`);

      // Get the PID first
      const { stdout: pidOutput } = await perf.track("adbGetPid", () =>
        this.adb.executeCommand(`shell pidof ${packageName}`),
      );

      const pid = pidOutput.trim();
      if (!pid) {
        logger.warn(`[MemoryMetricsCollector] No PID found for ${packageName}, cannot trigger GC`);
        return;
      }

      // Send SIGUSR1 to trigger GC (Android uses this signal for GC)
      await perf.track("adbTriggerGC", () => this.adb.executeCommand(`shell kill -USR1 ${pid}`));

      // Wait for GC to complete (small delay)
      await this.timer.sleep(500);

      logger.info(`[MemoryMetricsCollector] GC triggered for ${packageName}`);
    } catch (error) {
      logger.warn(`[MemoryMetricsCollector] Failed to trigger GC: ${error}`);
    }
  }

  /**
   * Capture GC events from logcat, scoped to the audited process
   * Should be called with timestamps around the action being monitored
   */
  async captureGCEvents(
    packageName: string,
    startTimestamp: number,
    endTimestamp: number,
    perf: PerformanceTracker = new NoOpPerformanceTracker(),
  ): Promise<GCEvent[]> {
    try {
      // Resolve the audited app's PID so GC lines from other processes on the
      // device are never attributed to it. `pidof` can report multiple pids
      // for a multi-process app; take the first as the primary process.
      const { stdout: pidOutput } = await perf.track("adbGetGcPid", () =>
        this.adb.executeCommand(`shell pidof ${packageName}`),
      );
      const pid = pidOutput.trim().split(/\s+/)[0];
      if (!pid) {
        logger.warn(
          `[MemoryMetricsCollector] No PID found for ${packageName}; skipping GC capture ` +
            `to avoid attributing another process's GC events to it`,
        );
        return [];
      }

      // ART (API 21+) logs GC lines under the app's own process tag (not a
      // dedicated "art" tag) and without the legacy "GC_" prefix, e.g.
      // "Background concurrent copying GC freed 4180(230KB) ..., paused 213us".
      // A `-s dalvikvm:I art:I` tag filter plus `grep "GC_"` drops every modern
      // ART line, so scope only on the "freed ... paused" shape both Dalvik and
      // ART share and let parseGCEvents() do the format-specific parsing.
      //
      // `--pid` scopes logcat itself to the audited process where the device
      // supports it; `-v epoch` gives each line a machine-parseable epoch
      // timestamp so parseGCEvents() can both re-verify the pid column
      // (defense-in-depth for devices where `--pid` is a no-op) and drop
      // events outside [startTimestamp, endTimestamp].
      const { stdout } = await perf.track("adbLogcatGC", () =>
        this.adb.executeCommand(
          `shell logcat -d -v epoch --pid=${pid} | grep -iE "GC[_ ].*freed.*paused"`,
          5000,
        ),
      );

      return this.parseGCEvents(stdout, startTimestamp, endTimestamp, pid);
    } catch (error) {
      logger.warn(`[MemoryMetricsCollector] Failed to capture GC events: ${error}`);
      return [];
    }
  }

  /**
   * Parse GC events from logcat output
   *
   * Two log shapes are supported:
   *  - Dalvik (pre-ART, API < 21): "GC_FOR_ALLOC freed 1234K, 50% free 5678K/11356K, paused 123ms"
   *  - ART (API 21+): "Background concurrent copying GC freed 4180(230KB) AllocSpace objects,
   *    0(0B) LOS objects, 49% free, 2MB/4MB, paused 213us,45us total 42.3ms" — the freed size may
   *    be bare ("1234KB") or scaled and parenthesized after an object count ("4180(230KB)" /
   *    "716275(24MB)"), and the pause may list multiple stop-the-world components
   *    ("213us,45us") in "us" or "ms", all of which are summed and converted to ms.
   *
   * `expectedPid`, when supplied, restricts events to lines whose logcat `-v epoch` pid column
   * matches — a line with no parseable pid column is dropped rather than risk attributing another
   * process's GC to the audited one. `startTimestamp`/`endTimestamp` are applied the same way:
   * a line with a parseable epoch timestamp outside the window is dropped; a line with no
   * timestamp (e.g. a bare fixture without the logcat prefix) is kept for backward compatibility.
   */
  private parseGCEvents(
    output: string,
    startTimestamp: number,
    endTimestamp: number,
    expectedPid?: string,
  ): GCEvent[] {
    const events: GCEvent[] = [];

    for (const rawLine of output.split("\n")) {
      const line = rawLine.trim();
      if (!line) {
        continue;
      }

      const prefix = this.parseLogcatLinePrefix(line);

      // Scope to the audited process: drop lines we can't attribute to it.
      if (expectedPid !== undefined && prefix.pid !== expectedPid) {
        continue;
      }

      // Scope to the requested capture window: drop events parsed as outside it.
      if (
        prefix.timestampMs !== undefined &&
        (prefix.timestampMs < startTimestamp || prefix.timestampMs > endTimestamp)
      ) {
        continue;
      }

      const eventTimestamp = prefix.timestampMs ?? this.timer.now(); // Approximate when unparsed
      const event = this.parseGCEventFromMessage(prefix.message, eventTimestamp);
      if (event) {
        events.push(event);
      }
    }

    return events;
  }

  /**
   * Split a raw logcat line into its message body plus, when present, the
   * "-v epoch" prefix fields: "<epochSeconds> <pid> <tid> <level> <tag>: <message>".
   * Lines without that prefix (e.g. bare test fixtures) return only `message`.
   */
  private parseLogcatLinePrefix(line: string): {
    message: string;
    timestampMs?: number;
    pid?: string;
  } {
    const epochLinePattern = /^(\d+(?:\.\d+)?)\s+(\d+)\s+(\d+)\s+[A-Z]\s+(.*)$/;
    const epochMatch = line.match(epochLinePattern);
    const rest = epochMatch ? epochMatch[4] : line;

    // Strip the tag separator so pattern matching only sees the GC message
    // itself. The tag separator is the rightmost ": " — timestamps use
    // "HH:MM:SS.mmm" (colon with no trailing space), so this reliably
    // isolates the message even when the epoch prefix wasn't present.
    const tagSeparator = rest.lastIndexOf(": ");
    const message = tagSeparator >= 0 ? rest.slice(tagSeparator + 2) : rest;

    if (!epochMatch) {
      return { message };
    }

    return {
      message,
      timestampMs: parseFloat(epochMatch[1]) * 1000,
      pid: epochMatch[2],
    };
  }

  /**
   * Match a single GC log message against the Dalvik and ART shapes and
   * build the corresponding GCEvent, or return null if neither matches.
   */
  private parseGCEventFromMessage(message: string, timestamp: number): GCEvent | null {
    const dalvikPattern = /^GC_(\w+)\s+freed\s+(\d+)K,?.*?paused\s+(\d+)ms/i;
    const artPattern =
      /([A-Za-z][A-Za-z ]*?)\s*GC freed\s+(?:\d+\()?([\d.]+)\s*(B|KB|MB|GB)\)?.*?paused\s+([\d.]+(?:us|ms)(?:,\s*[\d.]+(?:us|ms))*)/i;

    const dalvikMatch = message.match(dalvikPattern);
    if (dalvikMatch) {
      return {
        type: dalvikMatch[1],
        freedKb: parseInt(dalvikMatch[2], 10),
        durationMs: parseInt(dalvikMatch[3], 10),
        timestamp,
      };
    }

    const artMatch = message.match(artPattern);
    if (artMatch) {
      return {
        type: artMatch[1].trim(),
        freedKb: this.normalizeFreedToKb(artMatch[2], artMatch[3]),
        durationMs: this.sumPauseComponentsMs(artMatch[4]),
        timestamp,
      };
    }

    return null;
  }

  /**
   * Normalize an ART freed-size measurement (adaptively scaled B/KB/MB/GB) to KB.
   */
  private normalizeFreedToKb(rawValue: string, unit: string): number {
    const value = parseFloat(rawValue);
    switch (unit.toUpperCase()) {
      case "B":
        return value / 1024;
      case "MB":
        return value * 1024;
      case "GB":
        return value * 1024 * 1024;
      case "KB":
      default:
        return value;
    }
  }

  /**
   * Sum a comma-separated list of ART stop-the-world pause components
   * (e.g. "213us,45us"), converting each to ms.
   */
  private sumPauseComponentsMs(pauseList: string): number {
    return pauseList.split(",").reduce((sum, token) => {
      const match = token.trim().match(/^([\d.]+)(us|ms)$/i);
      if (!match) {
        return sum;
      }
      const value = parseFloat(match[1]);
      const unit = match[2].toLowerCase();
      return sum + (unit === "us" ? value / 1000 : value);
    }, 0);
  }

  /**
   * Get unreachable objects info
   */
  async getUnreachableObjects(
    packageName: string,
    perf: PerformanceTracker = new NoOpPerformanceTracker(),
  ): Promise<UnreachableObjectsInfo | null> {
    try {
      const { stdout } = await perf.track("adbMeminfoUnreachable", () =>
        this.adb.executeCommand(`shell dumpsys meminfo --unreachable ${packageName}`, 10000),
      );

      return this.parseUnreachableObjects(stdout);
    } catch (error) {
      logger.warn(`[MemoryMetricsCollector] Failed to get unreachable objects: ${error}`);
      return null;
    }
  }

  /**
   * Parse unreachable objects from dumpsys output
   */
  private parseUnreachableObjects(output: string): UnreachableObjectsInfo {
    // Pattern: "Unreachable memory: 123 bytes in 45 unreachable objects"
    const unreachableMatch = output.match(
      /Unreachable memory:\s+(\d+)\s+bytes in\s+(\d+)\s+unreachable objects/i,
    );

    if (unreachableMatch) {
      const sizeBytes = parseInt(unreachableMatch[1], 10);
      const count = parseInt(unreachableMatch[2], 10);

      return {
        count,
        sizeKb: sizeBytes / 1024,
        raw: output,
      };
    }

    // If pattern not found, look for alternative format or count manually
    // Just count occurrences of "Unreachable" as a fallback
    const unreachableCount = (output.match(/unreachable/gi) || []).length;

    return {
      count: unreachableCount,
      sizeKb: 0,
      raw: output,
    };
  }

  /**
   * Clear logcat buffer to prepare for GC event capture
   */
  async clearLogcat(perf: PerformanceTracker = new NoOpPerformanceTracker()): Promise<void> {
    try {
      await perf.track("adbLogcatClear", () => this.adb.executeCommand("logcat -c"));
      logger.debug("[MemoryMetricsCollector] Logcat buffer cleared");
    } catch (error) {
      logger.warn(`[MemoryMetricsCollector] Failed to clear logcat: ${error}`);
    }
  }

  /**
   * Collect complete memory metrics around an action
   * This is the main entry point that orchestrates all metric collection
   */
  async collectMetrics(
    packageName: string,
    beforeAction: () => Promise<void>,
    perf: PerformanceTracker = new NoOpPerformanceTracker(),
  ): Promise<MemoryMetrics> {
    logger.info(`[MemoryMetricsCollector] Collecting memory metrics for ${packageName}`);

    // Clear logcat to prepare for GC event capture
    await this.clearLogcat(perf);

    // Take pre-action snapshot
    const preSnapshot = await this.takeSnapshot(packageName, perf);
    const startTimestamp = this.timer.now();

    // Execute the action
    await beforeAction();

    const endTimestamp = this.timer.now();

    // Trigger explicit GC to ensure we get post-GC measurements
    await this.triggerGC(packageName, perf);

    // Take post-action snapshot (after GC)
    const postSnapshot = await this.takeSnapshot(packageName, perf);

    // Capture GC events that occurred during the action
    const gcEvents = await this.captureGCEvents(packageName, startTimestamp, endTimestamp, perf);

    // Get unreachable objects
    const unreachableObjects = await this.getUnreachableObjects(packageName, perf);

    // Calculate deltas
    const javaHeapGrowthMb = postSnapshot.javaHeapMb - preSnapshot.javaHeapMb;
    const nativeHeapGrowthMb = postSnapshot.nativeHeapMb - preSnapshot.nativeHeapMb;
    const totalPssGrowthMb = postSnapshot.totalPssMb - preSnapshot.totalPssMb;

    // Aggregate GC metrics
    const gcCount = gcEvents.length;
    const gcTotalDurationMs = gcEvents.reduce((sum, event) => sum + event.durationMs, 0);

    return {
      preSnapshot,
      postSnapshot,
      javaHeapGrowthMb,
      nativeHeapGrowthMb,
      totalPssGrowthMb,
      gcEvents,
      gcCount,
      gcTotalDurationMs,
      unreachableObjects,
    };
  }
}
