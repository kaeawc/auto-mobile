import type { SessionReleasedDuringCallError } from "../sessionReleasedDuringCall";

export interface SessionExecutionMetadata {
  executionId: string;
  /** When the call started, on the wall clock of the tracker that stamped it. */
  startTime: number;
  /**
   * {@link startTime} on the session clock, captured when the call started (#11290). Session
   * stamps are judged against this; without it the start is converted with the offset in force
   * when the session is looked up, which is the same instant unless the wall clock stepped in
   * between.
   */
  sessionClockStartTime?: number;
}

export interface ActiveSessionExecutionQuery {
  /** Count only session-preserving recovery, without consulting tracked executions. */
  recoveryOnly?: boolean;
  startedAtOrBefore?: number;
  /** Compare the start captured on the session clock, immune to wall-clock steps (#11290). */
  sessionClockStartedAtOrBefore?: number;
  /** Admission only: count non-aborted work within its deadline or its undated allowance. */
  liveOnSessionClock?: { at: number; undatedForMs: number };
  excludeExecutionId?: string;
  /** Count control calls only: reads never hold idle or owner-disconnect release (#11381). */
  excludeReads?: boolean;
}

export type ActiveSessionExecutionChecker = (
  sessionId: string,
  query?: ActiveSessionExecutionQuery,
) => boolean;

/**
 * The latest request deadline among a session's in-flight executions, on the session manager's
 * clock; `Number.POSITIVE_INFINITY` or undefined when some execution carries no deadline. Same
 * contract as `SessionExecutionProbe.latestExecutionDeadlineMs` (#10712).
 */
export type SessionExecutionDeadlineLookup = (
  sessionId: string,
  /** With `excludeReads`, reads' deadlines are left out, as the reads themselves are (#11322). */
  query?: Pick<ActiveSessionExecutionQuery, "excludeReads">,
) => number | undefined;

/**
 * Aborts a session's in-flight executions before an idle-expiry release overrides them (#10820).
 * Must signal the aborts synchronously: the expiry release starts in the same turn. `cancellation`
 * is what the calls are aborted with: the typed release, so their callers get the terminal
 * `session_ownership_lost` refusal rather than a generic abort (#11381).
 */
export type ExpiryReleaseExecutionCanceller = (
  sessionId: string,
  cancellation: SessionReleasedDuringCallError,
  query: ActiveSessionExecutionQuery,
  /**
   * The device the released session holds. A derived label session's release cuts its base
   * session's calls only where they drive this device.
   */
  releasedDeviceId?: string,
) => void;

/**
 * Aborts the sessionless executions driving a device a session just acquired (#10829). Must signal
 * the aborts synchronously: the new holder may drive the device in the same turn.
 */
export type DeviceAcquisitionExecutionCanceller = (deviceId: string, sessionId: string) => void;
