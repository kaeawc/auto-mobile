/** Newest finalized recordings remembered per proxy; older ids fall out first. */
export const MAX_FINALIZED_RECORDING_OWNERS = 64;

/** What the ledger needs from its proxy: whether it holds a session id. */
export interface FinalizedRecordingOwnersPort {
  /** Whether this proxy holds, or held until now, the exact session id. */
  holdsSession(sessionUuid: string): boolean;
}

/**
 * Recordings a session this proxy held finalized when it was released, by id, to the session
 * that started them (#11362). The release notification names them; only this connection learns
 * them, so only it can retrieve them later.
 */
export class FinalizedRecordingOwners {
  private readonly owners = new Map<string, string>();

  constructor(private readonly port: FinalizedRecordingOwnersPort) {}

  get size(): number {
    return this.owners.size;
  }

  /** Remember recordings finalized by a released session this proxy held (or its base). */
  remember(releasedSessionUuid: string, recordingIds: readonly string[] | undefined): void {
    if (!recordingIds?.length || !this.holdsSessionFamily(releasedSessionUuid)) {
      return;
    }
    for (const recordingId of recordingIds) {
      this.owners.delete(recordingId);
      this.owners.set(recordingId, releasedSessionUuid);
    }
    while (this.owners.size > MAX_FINALIZED_RECORDING_OWNERS) {
      const oldest = this.owners.keys().next();
      if (oldest.done) {
        break;
      }
      this.owners.delete(oldest.value);
    }
  }

  /**
   * The session that started the finalized recording a `videoRecording stop {recordingId}` call
   * retrieves, when this connection learned of that recording from its own session's release
   * (#11362). Retrieval is a read of a stored artifact: it touches no device, so a terminal fence
   * never refuses it, and the daemon scopes the lookup to the starting session, not to whichever
   * session this connection holds now. An id this connection was not told about is not one.
   */
  retrievalOwner(name: string, args: Record<string, unknown>): string | undefined {
    return name === "videoRecording" &&
      args.action === "stop" &&
      typeof args.recordingId === "string"
      ? this.owners.get(args.recordingId)
      : undefined;
  }

  /** Whether this proxy holds, or held until now, the session or its base (`base:label`). */
  private holdsSessionFamily(sessionUuid: string): boolean {
    const colon = sessionUuid.indexOf(":");
    return [sessionUuid, ...(colon > 0 ? [sessionUuid.slice(0, colon)] : [])].some((id) =>
      this.port.holdsSession(id),
    );
  }
}
