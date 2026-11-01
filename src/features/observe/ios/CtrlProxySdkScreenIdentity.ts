import type { ScreenIdentity } from "../../../models";
import type { DecodedSdkEvent } from "./decodeSdkEventBatches";
import { deriveIosSdkScreenIdentity } from "./IosSdkScreenIdentity";
export type SdkScreenIdentityPollGeneration = {
  clearGeneration: number;
  applicationGenerations: Map<string, number>;
};
interface ScreenIdentityHost {
  invalidateBuildContext(appId: string): void;
  invalidateAllBuildContexts(): void;
  invalidateSdkCapabilities(): void;
}
/** Orders app-provided identities across SDK sessions, tracking epochs and invalidations. */
export class CtrlProxySdkScreenIdentity {
  constructor(private readonly host: ScreenIdentityHost) {}

  private readonly sdkScreenIdentitiesByApplicationId = new Map<string, ScreenIdentity>();

  private readonly sdkScreenIdentityOrdersByApplicationId = new Map<
    string,
    { timestamp: number; sequenceNumber?: number }
  >();

  private readonly sdkScreenIdentityGenerationsByApplicationId = new Map<string, number>();

  private readonly sdkScreenIdentitySessionsByApplicationId = new Map<string, string>();

  private readonly sdkScreenIdentityStartedSessionsByApplicationId = new Map<string, string>();

  private readonly sdkScreenIdentitySessionEpochsByApplicationId = new Map<string, number>();

  private readonly sdkScreenIdentityRetiredSessionsByApplicationId = new Map<string, Set<string>>();

  private readonly sdkScreenIdentityTrackingGenerationsByApplicationId = new Map<string, number>();

  private readonly sdkScreenIdentityTrackingDisabledApplicationIds = new Set<string>();

  private sdkScreenIdentityClearGeneration = 0;

  /** Return the latest app-provided navigation identity without doing I/O. */
  public getSdkScreenIdentity(applicationId?: string): ScreenIdentity | undefined {
    return applicationId ? this.sdkScreenIdentitiesByApplicationId.get(applicationId) : undefined;
  }

  /**
   * Whether the last accepted navigation event covers this device-clock capture.
   * Only a strictly later event orders after the capture: both are truncated to
   * whole epoch milliseconds, so an equal timestamp carries no ordering evidence
   * and an older event in the capture's millisecond must keep the retry (#14433).
   */
  hasSdkScreenIdentityForCapture(applicationId?: string, capturedAt?: number): boolean {
    const timestamp = applicationId
      ? this.sdkScreenIdentityOrdersByApplicationId.get(applicationId)?.timestamp
      : undefined;
    return (
      capturedAt !== undefined &&
      Number.isFinite(capturedAt) &&
      timestamp !== undefined &&
      capturedAt < timestamp
    );
  }

  /** Remove SDK navigation state after an app process is replaced. */
  public clearSdkScreenIdentity(applicationId?: string): void {
    this.host.invalidateSdkCapabilities();
    if (applicationId) {
      this.host.invalidateBuildContext(applicationId);
      this.sdkScreenIdentityTrackingDisabledApplicationIds.delete(applicationId);
      this.invalidateSdkScreenIdentity(applicationId);
      return;
    }
    this.host.invalidateAllBuildContexts();
    this.sdkScreenIdentityClearGeneration++;
    this.sdkScreenIdentityGenerationsByApplicationId.clear();
    this.sdkScreenIdentityTrackingDisabledApplicationIds.clear();
    this.sdkScreenIdentitySessionsByApplicationId.clear();
    this.sdkScreenIdentityStartedSessionsByApplicationId.clear();
    this.sdkScreenIdentitySessionEpochsByApplicationId.clear();
    this.sdkScreenIdentityRetiredSessionsByApplicationId.clear();
    this.sdkScreenIdentityTrackingGenerationsByApplicationId.clear();
    this.sdkScreenIdentitiesByApplicationId.clear();
    this.sdkScreenIdentityOrdersByApplicationId.clear();
  }

  rememberSdkScreenIdentity(
    eventType: string,
    applicationId: string | undefined,
    payload: Record<string, unknown>,
    { timestamp, sequenceNumber }: { timestamp: number; sequenceNumber?: number },
  ): boolean {
    if (
      !applicationId ||
      !this.activateSdkScreenIdentitySession(applicationId, payload) ||
      !this.isSdkScreenIdentityTrackingEnabled(applicationId, payload)
    ) {
      return false;
    }
    const identity = deriveIosSdkScreenIdentity(eventType, applicationId, payload);
    const currentOrder = this.sdkScreenIdentityOrdersByApplicationId.get(applicationId);
    const isNewer =
      currentOrder === undefined ||
      timestamp > currentOrder.timestamp ||
      (timestamp === currentOrder.timestamp &&
        (sequenceNumber === undefined ||
          currentOrder.sequenceNumber === undefined ||
          sequenceNumber > currentOrder.sequenceNumber));
    if (identity && isNewer) {
      this.sdkScreenIdentitiesByApplicationId.set(applicationId, identity);
      this.sdkScreenIdentityOrdersByApplicationId.set(applicationId, { timestamp, sequenceNumber });
      return true;
    }
    return false;
  }

  getSdkScreenIdentityGeneration(applicationId: string): number {
    return this.sdkScreenIdentityGenerationsByApplicationId.get(applicationId) ?? 0;
  }

  private invalidateSdkScreenIdentity(applicationId: string, retireSession: boolean = true): void {
    this.sdkScreenIdentityGenerationsByApplicationId.set(
      applicationId,
      this.getSdkScreenIdentityGeneration(applicationId) + 1,
    );
    const sessionId = this.sdkScreenIdentitySessionsByApplicationId.get(applicationId);
    if (retireSession && sessionId) {
      this.retireSdkScreenIdentitySession(applicationId, sessionId);
    }
    if (retireSession) {
      this.sdkScreenIdentityStartedSessionsByApplicationId.delete(applicationId);
      this.sdkScreenIdentitySessionEpochsByApplicationId.delete(applicationId);
    }
    this.sdkScreenIdentitiesByApplicationId.delete(applicationId);
    this.sdkScreenIdentityOrdersByApplicationId.delete(applicationId);
  }

  applySdkScreenIdentityLifecycleEvent(event: DecodedSdkEvent): boolean {
    if (!event.applicationId || event.eventType !== "lifecycle") {
      return false;
    }
    if (event.payload.state === "sdk_session_started") {
      this.startSdkScreenIdentitySession(event.applicationId, event.payload);
      return true;
    }
    if (!this.activateSdkScreenIdentitySession(event.applicationId, event.payload)) {
      return true;
    }
    const trackingGeneration = this.getSdkScreenIdentityTrackingGeneration(event.payload);
    const currentGeneration = this.sdkScreenIdentityTrackingGenerationsByApplicationId.get(
      event.applicationId,
    );
    if (
      trackingGeneration === undefined ||
      currentGeneration === undefined ||
      trackingGeneration >= currentGeneration
    ) {
      if (trackingGeneration !== undefined) {
        this.sdkScreenIdentityTrackingGenerationsByApplicationId.set(
          event.applicationId,
          trackingGeneration,
        );
      }
    } else {
      return true;
    }
    if (event.payload.state === "sdk_tracking_disabled") {
      this.sdkScreenIdentityTrackingDisabledApplicationIds.add(event.applicationId);
      this.invalidateSdkScreenIdentity(event.applicationId, false);
      return true;
    }
    if (event.payload.state === "sdk_tracking_enabled") {
      this.sdkScreenIdentityTrackingDisabledApplicationIds.delete(event.applicationId);
      return true;
    }
    return false;
  }

  activateSdkScreenIdentitySession(
    applicationId: string,
    payload: Record<string, unknown>,
  ): boolean {
    const sessionId = typeof payload.sessionId === "string" ? payload.sessionId : undefined;
    if (!sessionId) {
      return true;
    }
    if (this.sdkScreenIdentityRetiredSessionsByApplicationId.get(applicationId)?.has(sessionId)) {
      return false;
    }
    const sessionEpoch = this.getSdkScreenIdentitySessionEpoch(payload);
    const currentEpoch = this.sdkScreenIdentitySessionEpochsByApplicationId.get(applicationId);
    const currentSessionId = this.sdkScreenIdentitySessionsByApplicationId.get(applicationId);
    if (
      this.isOlderSdkScreenIdentitySession(sessionId, sessionEpoch, currentEpoch, currentSessionId)
    ) {
      return false;
    }
    const startedSessionId =
      this.sdkScreenIdentityStartedSessionsByApplicationId.get(applicationId);
    if (
      this.isConflictingStartedSdkSession(startedSessionId, sessionId, sessionEpoch, currentEpoch)
    ) {
      return false;
    }
    if (currentSessionId && currentSessionId !== sessionId) {
      this.host.invalidateBuildContext(applicationId);
      this.retireSdkScreenIdentitySession(applicationId, currentSessionId);
      this.sdkScreenIdentitiesByApplicationId.delete(applicationId);
      this.sdkScreenIdentityOrdersByApplicationId.delete(applicationId);
      this.resetSdkScreenIdentityTrackingState(applicationId, payload);
      this.sdkScreenIdentityStartedSessionsByApplicationId.set(applicationId, sessionId);
    }
    this.sdkScreenIdentitySessionsByApplicationId.set(applicationId, sessionId);
    if (sessionEpoch !== undefined) {
      this.sdkScreenIdentitySessionEpochsByApplicationId.set(applicationId, sessionEpoch);
    }
    return true;
  }

  private isOlderSdkScreenIdentitySession(
    sessionId: string,
    sessionEpoch: number | undefined,
    currentEpoch: number | undefined,
    currentSessionId: string | undefined,
  ): boolean {
    return Boolean(
      sessionEpoch !== undefined &&
      currentEpoch !== undefined &&
      (sessionEpoch < currentEpoch ||
        (sessionEpoch === currentEpoch && currentSessionId && currentSessionId !== sessionId)),
    );
  }

  private isConflictingStartedSdkSession(
    startedSessionId: string | undefined,
    sessionId: string,
    sessionEpoch: number | undefined,
    currentEpoch: number | undefined,
  ): boolean {
    return Boolean(
      startedSessionId &&
      startedSessionId !== sessionId &&
      (sessionEpoch === undefined || currentEpoch === undefined || sessionEpoch <= currentEpoch),
    );
  }

  private startSdkScreenIdentitySession(
    applicationId: string,
    payload: Record<string, unknown>,
  ): boolean {
    const sessionId = typeof payload.sessionId === "string" ? payload.sessionId : undefined;
    if (!sessionId || !this.activateSdkScreenIdentitySession(applicationId, payload)) {
      return false;
    }
    this.sdkScreenIdentityStartedSessionsByApplicationId.set(applicationId, sessionId);
    return true;
  }

  private resetSdkScreenIdentityTrackingState(
    applicationId: string,
    payload: Record<string, unknown>,
  ): void {
    this.sdkScreenIdentityTrackingDisabledApplicationIds.delete(applicationId);
    const trackingGeneration = this.getSdkScreenIdentityTrackingGeneration(payload);
    if (trackingGeneration === undefined) {
      this.sdkScreenIdentityTrackingGenerationsByApplicationId.delete(applicationId);
    } else {
      this.sdkScreenIdentityTrackingGenerationsByApplicationId.set(
        applicationId,
        trackingGeneration,
      );
    }
  }

  private retireSdkScreenIdentitySession(applicationId: string, sessionId: string): void {
    let retiredSessions = this.sdkScreenIdentityRetiredSessionsByApplicationId.get(applicationId);
    if (!retiredSessions) {
      retiredSessions = new Set<string>();
      this.sdkScreenIdentityRetiredSessionsByApplicationId.set(applicationId, retiredSessions);
    }
    retiredSessions.add(sessionId);
  }

  private isSdkScreenIdentityTrackingEnabled(
    applicationId: string,
    payload: Record<string, unknown>,
  ): boolean {
    const trackingGeneration = this.getSdkScreenIdentityTrackingGeneration(payload);
    const currentGeneration =
      this.sdkScreenIdentityTrackingGenerationsByApplicationId.get(applicationId);
    if (this.sdkScreenIdentityTrackingDisabledApplicationIds.has(applicationId)) {
      if (
        trackingGeneration === undefined ||
        currentGeneration === undefined ||
        trackingGeneration <= currentGeneration
      ) {
        return false;
      }
      this.sdkScreenIdentityTrackingDisabledApplicationIds.delete(applicationId);
    }
    if (
      trackingGeneration !== undefined &&
      (currentGeneration === undefined || trackingGeneration > currentGeneration)
    ) {
      this.sdkScreenIdentityTrackingGenerationsByApplicationId.set(
        applicationId,
        trackingGeneration,
      );
    }
    return true;
  }

  private getSdkScreenIdentityTrackingGeneration(
    payload: Record<string, unknown>,
  ): number | undefined {
    return typeof payload.trackingGeneration === "number" &&
      Number.isSafeInteger(payload.trackingGeneration)
      ? payload.trackingGeneration
      : undefined;
  }

  private getSdkScreenIdentitySessionEpoch(payload: Record<string, unknown>): number | undefined {
    return typeof payload.sessionEpoch === "number" && Number.isSafeInteger(payload.sessionEpoch)
      ? payload.sessionEpoch
      : undefined;
  }

  isSdkScreenIdentityPollCurrent(
    applicationId: string | undefined,
    pollGeneration: SdkScreenIdentityPollGeneration,
  ): applicationId is string {
    return (
      applicationId !== undefined &&
      pollGeneration.clearGeneration === this.sdkScreenIdentityClearGeneration &&
      (pollGeneration.applicationGenerations.get(applicationId) ?? 0) ===
        this.getSdkScreenIdentityGeneration(applicationId)
    );
  }
  capturePollGeneration(): SdkScreenIdentityPollGeneration {
    return {
      clearGeneration: this.sdkScreenIdentityClearGeneration,
      applicationGenerations: new Map(this.sdkScreenIdentityGenerationsByApplicationId),
    };
  }
}
