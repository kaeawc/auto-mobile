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
   * Capture GC events from logcat
   * Should be called with timestamps around the action being monitored
   */
  async captureGCEvents(
    startTimestamp: number,
    endTimestamp: number,
    perf: PerformanceTracker = new NoOpPerformanceTracker(),
  ): Promise<GCEvent[]> {
    try {
      // Clear logcat buffer before starting if this is the start
      // For now, we'll just read the recent buffer and filter by timestamp
      //
      // ART (API 21+) logs GC lines under the app's own process tag (not a
      // dedicated "art" tag) and without the legacy "GC_" prefix, e.g.
      // "Background concurrent copying GC freed 4180(230KB) ..., paused 213us".
      // A `-s dalvikvm:I art:I` tag filter plus `grep "GC_"` drops every modern
      // ART line, so scope only on the "freed ... paused" shape both Dalvik and
      // ART share and let parseGCEvents() do the format-specific parsing.
      const { stdout } = await perf.track("adbLogcatGC", () =>
        this.adb.executeCommand(`shell logcat -d -v time | grep -iE "GC[_ ].*freed.*paused"`, 5000),
      );

      return this.parseGCEvents(stdout, startTimestamp, endTimestamp);
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
   *    0(0B) LOS objects, 49% free, 2MB/4MB, paused 213us,45us total 42.3ms" — pause may be
   *    reported in "us" (converted to ms below) or "ms", and the freed size may appear either
   *    bare ("1234KB") or parenthesized after an object count ("4180(230KB)").
   */
  private parseGCEvents(output: string, startTimestamp: number, endTimestamp: number): GCEvent[] {
    const events: GCEvent[] = [];
    const lines = output.split("\n");

    const dalvikPattern = /^GC_(\w+)\s+freed\s+(\d+)K,?.*?paused\s+(\d+)ms/i;
    const artPattern =
      /([A-Za-z][A-Za-z ]*?)\s*GC freed\s+(?:\d+\()?(\d+)\s*KB\)?.*?paused\s+([\d.]+)\s*(us|ms)/i;

    for (const rawLine of lines) {
      const line = rawLine.trim();
      if (!line) {
        continue;
      }

      // Strip the logcat prefix (timestamp/pid/tid/level/tag) so pattern
      // matching only sees the GC message itself. The tag separator is the
      // rightmost ": " — timestamps use "HH:MM:SS.mmm" (colon with no
      // trailing space), so this reliably isolates the message.
      const tagSeparator = line.lastIndexOf(": ");
      const message = tagSeparator >= 0 ? line.slice(tagSeparator + 2) : line;

      const dalvikMatch = message.match(dalvikPattern);
      if (dalvikMatch) {
        events.push({
          type: dalvikMatch[1],
          freedKb: parseInt(dalvikMatch[2], 10),
          durationMs: parseInt(dalvikMatch[3], 10),
          timestamp: this.timer.now(), // Approximate - logcat would give us real timestamp with -v time
        });
        continue;
      }

      const artMatch = message.match(artPattern);
      if (artMatch) {
        const pauseValue = parseFloat(artMatch[3]);
        const pauseUnit = artMatch[4].toLowerCase();
        const durationMs = pauseUnit === "us" ? pauseValue / 1000 : pauseValue;

        events.push({
          type: artMatch[1].trim(),
          freedKb: parseInt(artMatch[2], 10),
          durationMs,
          timestamp: this.timer.now(), // Approximate - logcat would give us real timestamp with -v time
        });
      }
    }

    return events;
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
    const gcEvents = await this.captureGCEvents(startTimestamp, endTimestamp, perf);

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
