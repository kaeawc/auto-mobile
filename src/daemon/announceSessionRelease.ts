import type { SessionReleaseSnapshot } from "./sessionManager";
import type { SessionReleaseExtras } from "../server/sessionReleaseBroadcast";

/** Shutdown bookkeeping for release announcements; null outside shutdown. */
export interface ShutdownReleaseAnnouncements {
  /** Sessions shutdown already announced with its daemon-shutdown fallback. */
  fallbacks: ReadonlySet<string> | null;
  /** Sessions whose own daemon-shutdown release was announced. */
  announced: Set<string> | null;
}

export interface SessionReleaseAnnouncer {
  /** Consume the recording ids captured when this session's release began (#10958). */
  takeRecordingIds(sessionId: string): string[];
  emit(
    sessionId: string,
    reason: string,
    snapshot: SessionReleaseSnapshot,
    extras?: SessionReleaseExtras,
  ): void;
}

/**
 * Announce a session release to connected proxies and stream servers (#4610), naming the
 * recordings it finalizes (#10958). The captured recording ids are consumed even when the release
 * is not announced because shutdown's fallback already was (#11058): left behind, they would be
 * reported for a later release that reuses the UUID.
 */
export function announceSessionRelease(
  announcer: SessionReleaseAnnouncer,
  shutdown: ShutdownReleaseAnnouncements,
  sessionId: string,
  releaseReason: string,
  snapshot: SessionReleaseSnapshot,
  options: { upgradeOnly?: boolean } = {},
): void {
  const recordingIds = announcer.takeRecordingIds(sessionId);
  if (shutdown.fallbacks?.has(sessionId)) {
    return;
  }
  if (releaseReason === "daemon-shutdown") {
    shutdown.announced?.add(sessionId);
  }
  const extras: SessionReleaseExtras = {
    ...(recordingIds.length > 0 ? { recordingIds } : {}),
    ...(options.upgradeOnly ? { upgradeOnly: true } : {}),
  };
  announcer.emit(
    sessionId,
    releaseReason,
    snapshot,
    Object.keys(extras).length > 0 ? extras : undefined,
  );
}
