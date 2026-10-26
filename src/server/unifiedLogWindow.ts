import type {
  UnifiedLogWindowRequest,
  UnifiedLogWindowResult,
  UnifiedLogMechanism,
} from "./sessionLogContract";

/** The app's own `os_log` subsystem and any child subsystem (`<appId>.network`). */
export function unifiedLogPredicate(appId: string, processName?: string): string {
  const subsystem = `subsystem == "${appId}" OR subsystem BEGINSWITH "${appId}."`;
  if (!processName) {
    return subsystem;
  }
  // Most apps, system apps included, log under other subsystems; their process still names them.
  const quoted = processName.replaceAll("\\", "\\\\").replaceAll('"', '\\"');
  return `${subsystem} OR process == "${quoted}"`;
}

/**
 * `log show` arguments (after the `log` binary) for one bounded window. Simulators
 * read the live store via `simctl spawn … log`; physical devices append the
 * collected archive path.
 */
export function logShowArgs(request: UnifiedLogWindowRequest, predicate: string): string[] {
  return [
    "show",
    "--last",
    `${request.lastSeconds}`,
    "--style",
    "compact",
    "--predicate",
    predicate,
    ...(request.level === "info" ? ["--info"] : []),
    ...(request.level === "debug" ? ["--info", "--debug"] : []),
  ];
}

/** Bound `log show` output to `maxBytes`, reporting the full size and how it was collected. */
export function unifiedLogWindowResult(
  request: UnifiedLogWindowRequest,
  stdout: string,
  maxBytes: number,
  details: {
    predicate: string;
    mechanism: UnifiedLogMechanism;
    collectionMs: number;
    timeoutMs: number;
  },
): UnifiedLogWindowResult {
  const buffer = Buffer.from(stdout, "utf8");
  const bounded = buffer.byteLength > maxBytes ? buffer.subarray(0, maxBytes) : buffer;
  return {
    ...streamedUnifiedLogWindowResult(
      request,
      { text: bounded.toString("utf8"), totalBytes: buffer.byteLength },
      details,
    ),
    truncated: bounded.byteLength < buffer.byteLength,
  };
}

/** Build metadata from output that has already been bounded during streaming. */
export function streamedUnifiedLogWindowResult(
  request: UnifiedLogWindowRequest,
  output: { text: string; totalBytes: number },
  details: {
    predicate: string;
    mechanism: UnifiedLogMechanism;
    collectionMs: number;
    timeoutMs: number;
  },
): UnifiedLogWindowResult {
  return {
    lastSeconds: request.lastSeconds,
    level: request.level,
    predicate: details.predicate,
    mechanism: details.mechanism,
    collectionMs: details.collectionMs,
    timeoutMs: details.timeoutMs,
    byteCount: output.totalBytes,
    truncated: Buffer.byteLength(output.text) < output.totalBytes,
    text: output.text,
  };
}
