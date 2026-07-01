/**
 * SdkEventIngestor - shared abstraction for fanning SDK telemetry events out to
 * the telemetry/failure recorders.
 *
 * Both the iOS and Android CtrlProxy clients receive SDK events (network, log,
 * lifecycle, navigation, custom, storage, ...) that must be routed into
 * `TelemetryRecorder` / `FailureRecorder`. That routing is a single concern that
 * does not belong to connection lifecycle, so each platform owns an
 * implementation of this interface and forwards events to it.
 *
 * The **shared** surface is the `recordSdkEvent` method. Platform-specific
 * ingestion that has no cross-platform analogue stays on the platform interface,
 * not here — iOS layout telemetry (`IosSdkEventIngestor.recordLayoutTelemetryEvent`)
 * and Android crash/ANR analytics are extensions, not part of this contract.
 *
 * `SdkEvent` is generic over its payload so neither platform bends to the other's
 * transport: iOS delivers events over an HTTP poll as an opaque base64-JSON bag
 * (`Record<string, unknown>`, the default), while Android delivers already-typed
 * event objects on its WebSocket and can narrow `P` to those shapes (issue #2764).
 */

/**
 * A single SDK event: a discriminating `type`, an event `timestamp`, and a
 * `payload` whose shape depends on the type. `P` defaults to an opaque bag for
 * the iOS transport; Android may specialize it.
 */
export interface SdkEvent<P = Record<string, unknown>> {
  type: string;
  timestamp: number;
  payload: P;
}

/**
 * Routes a single SDK event to the appropriate recorder(s).
 */
export interface SdkEventIngestor<P = Record<string, unknown>> {
  /**
   * Record one SDK event, fanning it out to the correct recorder based on its
   * type. `applicationId` is the owning app/bundle id when known, else null.
   * Never throws — ingestion is best-effort and must not break observation.
   */
  recordSdkEvent(event: SdkEvent<P>, applicationId: string | null): Promise<void>;
}
