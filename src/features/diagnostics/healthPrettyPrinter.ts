import type { LatencyPercentiles, RunHealthSummary, ToolCallStats } from "./types";


function formatPercent(value: number): string {
  return `${(value * 100).toFixed(1)}%`;
}


function formatLatency(latency: LatencyPercentiles): string {
  if (latency.count === 0) {
    return "(no samples)";
  }
  return `min=${latency.minMs}ms p50=${latency.p50Ms}ms p90=${latency.p90Ms}ms p99=${latency.p99Ms}ms max=${latency.maxMs}ms`;
}


function formatDuration(ms: number): string {
  if (ms < 1000) {
    return `${ms}ms`;
  }
  const seconds = ms / 1000;
  if (seconds < 60) {
    return `${seconds.toFixed(2)}s`;
  }
  const minutes = Math.floor(seconds / 60);
  const remainingSeconds = (seconds - minutes * 60).toFixed(1);
  return `${minutes}m ${remainingSeconds}s`;
}


/**
 * Render a `RunHealthSummary` as a human-readable, fixed-width report.
 * Pure string formatting — no I/O. Consumers wire this into the CLI
 * `--cli health <path>` subcommand or paste it into Slack threads.
 */
export function prettyPrintRunHealth(summary: RunHealthSummary): string {
  const lines: string[] = [];

  lines.push("AutoMobile Run Health Summary");
  lines.push("=============================");
  lines.push(`Session:     ${summary.sessionId ?? "(ad-hoc)"}`);
  lines.push(`Plan:        ${summary.planName ?? "(unnamed)"}`);
  lines.push(`Started:     ${summary.startedAt}`);
  lines.push(`Finished:    ${summary.finishedAt}`);
  lines.push(`Duration:    ${formatDuration(summary.durationMs)}`);
  if (summary.device) {
    lines.push(`Device:      ${summary.device.id ?? "?"} (${summary.device.model ?? "?"})`);
  }
  lines.push("");

  lines.push("Tool Calls");
  lines.push("----------");
  lines.push(
    `Total: ${summary.toolCalls.total} (success=${summary.toolCalls.successes}, failure=${summary.toolCalls.failures})`
  );
  const toolEntries = Object.entries(summary.toolCalls.byTool).sort(
    (a, b) => b[1].count - a[1].count
  );
  if (toolEntries.length === 0) {
    lines.push("  (no tool calls recorded)");
  } else {
    for (const [name, stats] of toolEntries) {
      lines.push(`  ${name}: ${formatToolCallStats(stats)}`);
    }
  }
  lines.push("");

  lines.push("Hierarchy Sync");
  lines.push("--------------");
  lines.push(
    `Requests: ${summary.hierarchy.syncRequests} ` +
      `(cache=${summary.hierarchy.cacheHits}, fresh=${summary.hierarchy.freshDeliveries}, ` +
      `stale=${summary.hierarchy.staleCacheReturns}, timeout=${summary.hierarchy.timeouts}, ` +
      `failed=${summary.hierarchy.failed})`
  );
  lines.push(`Cache hit rate: ${formatPercent(summary.hierarchy.cacheHitRate)}`);
  lines.push(`Staleness rate: ${formatPercent(summary.hierarchy.stalenessRate)}`);
  lines.push(`Fresh latency:  ${formatLatency(summary.hierarchy.freshLatencyMs)}`);
  lines.push("");

  lines.push("Screenshots");
  lines.push("-----------");
  lines.push(`Count: ${summary.screenshot.count}`);
  lines.push(`Latency: ${formatLatency(summary.screenshot.latencyMs)}`);
  lines.push("");

  lines.push("Await Idle");
  lines.push("----------");
  lines.push(
    `Calls: ${summary.awaitIdle.calls} ` +
      `(timeouts=${summary.awaitIdle.timeouts}, errors=${summary.awaitIdle.errors})`
  );
  lines.push(`Timeout rate: ${formatPercent(summary.awaitIdle.timeoutRate)}`);
  lines.push(`Error rate:   ${formatPercent(summary.awaitIdle.errorRate)}`);
  lines.push(`Duration: ${formatLatency(summary.awaitIdle.durationMs)}`);
  lines.push("");

  lines.push("Back Stack & A11y Detector");
  lines.push("--------------------------");
  lines.push(`Back stack:   count=${summary.backStack.count} ${formatLatency(summary.backStack.latencyMs)}`);
  lines.push(
    `A11y detect:  count=${summary.accessibilityDetector.count} ${formatLatency(summary.accessibilityDetector.latencyMs)}`
  );
  lines.push("");

  lines.push("Ghost Tap Detection");
  lines.push("-------------------");
  lines.push(
    `Evaluations: ${summary.ghostTap.evaluations} ` +
      `(registered=${summary.ghostTap.tapRegistered}, false-positive=${summary.ghostTap.falsePositives}, bailed=${summary.ghostTap.bailedNullHierarchy})`
  );
  lines.push(`False-positive rate: ${formatPercent(summary.ghostTap.falsePositiveRate)}`);

  return lines.join("\n");
}


function formatToolCallStats(stats: ToolCallStats): string {
  return (
    `count=${stats.count} (ok=${stats.successes}, fail=${stats.failures}) ` +
    `p50=${stats.p50Ms}ms p90=${stats.p90Ms}ms p99=${stats.p99Ms}ms max=${stats.maxMs}ms`
  );
}
