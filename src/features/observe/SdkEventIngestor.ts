/**
 * SdkEventIngestor - shared abstraction for fanning SDK telemetry events out to
 * the telemetry/failure recorders.
 *
 * Both the iOS CtrlProxy client and the Android CtrlProxy client receive SDK
 * events (network, log, lifecycle, navigation, crash, ...) that must be routed
 * into `TelemetryRecorder` / `FailureRecorder`. That routing is a single concern
 * that does not belong to connection lifecycle, so each platform owns an
 * implementation of this interface and forwards events to it.
 *
 * The Android companion (issue #2764) adopts the same interface so telemetry
 * ingestion is expressed one way across platforms; keep the shape platform
 * neutral.
 */

/**
 * A decoded SDK event as delivered by a CtrlProxy runner: a discriminating
 * `type`, an event `timestamp`, and an opaque `payload` whose fields depend on
 * the type. Implementations narrow the payload per `type`.
 */
export interface SdkEvent {
  type: string;
  timestamp: number;
  payload: Record<string, unknown>;
}

/**
 * Routes a single SDK event to the appropriate recorder(s).
 */
export interface SdkEventIngestor {
  /**
   * Record one SDK event, fanning it out to the correct recorder based on its
   * type. `applicationId` is the owning app/bundle id when known, else null.
   * Never throws — ingestion is best-effort and must not break observation.
   */
  recordSdkEvent(event: SdkEvent, applicationId: string | null): Promise<void>;
}
