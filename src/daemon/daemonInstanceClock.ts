/**
 * Identifies this daemon process. A restarted daemon reports a different value, so a proxy can
 * tell a daemon that resumed after a stall from a new one (#10989).
 */
export const DAEMON_PROCESS_INSTANCE = `${process.pid}:${performance.timeOrigin}`;

/** A session-clock instant as wall-clock epoch ms, for a report another process reads (#11105). */
export function reportedWallClock(
  manager: {
    sessionClockToWall?(sessionClockMs: number): number;
    sessionClockToReportedWall?(sessionClockMs: number): number;
  },
  sessionClockMs: number,
): number {
  return (
    manager.sessionClockToReportedWall?.(sessionClockMs) ??
    manager.sessionClockToWall?.(sessionClockMs) ??
    sessionClockMs
  );
}
