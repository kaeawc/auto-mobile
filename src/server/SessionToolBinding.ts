export class SessionToolBinding {
  private readonly boundDeviceSessions = new Map<string, string>();
  private initialSessionUuid?: string;

  constructor(initialSessionUuid?: string) {
    this.initialSessionUuid = initialSessionUuid;
  }

  effectiveSessionUuid(mcpSessionId: string | undefined, params?: unknown): string | undefined {
    const explicit = params && typeof params === "object" && !Array.isArray(params)
      ? (params as Record<string, unknown>).sessionUuid
      : undefined;
    return typeof explicit === "string" && explicit.trim().length > 0
      ? explicit
      : mcpSessionId
        ? this.boundDeviceSessions.get(mcpSessionId) ?? this.initialSessionUuid
        : undefined;
  }

  bind(mcpSessionId: string | undefined, sessionUuid: string | undefined): boolean {
    if (
      !mcpSessionId
      || !sessionUuid?.trim()
      || this.boundDeviceSessions.get(mcpSessionId) === sessionUuid
    ) {
      return false;
    }
    this.boundDeviceSessions.set(mcpSessionId, sessionUuid);
    return true;
  }

  /**
   * Drop every binding whose effective session is the just-released
   * `sessionUuid` (issue #4611 Gap D). After an executePlan (or a heartbeat/idle)
   * release frees a daemon session, the per-transport binding must be torn down
   * so a later sessionless `tools/list`/`tools/call` on the SAME MCP transport
   * stops enforcing the released session's (now stale) capability profile.
   *
   * Both binding origins are cleared: any per-transport map entry pointing at the
   * session AND a seeded `initialSessionUuid` fallback that `effectiveSessionUuid`
   * would otherwise still return. Idempotent — returns whether anything was
   * actually removed, so callers can skip a redundant list-changed notification
   * when a duplicate release signal arrives.
   */
  unbindSession(sessionUuid: string): boolean {
    if (!sessionUuid) {
      return false;
    }
    let removed = false;
    for (const [mcpSessionId, boundSessionUuid] of this.boundDeviceSessions) {
      if (boundSessionUuid === sessionUuid) {
        this.boundDeviceSessions.delete(mcpSessionId);
        removed = true;
      }
    }
    if (this.initialSessionUuid === sessionUuid) {
      this.initialSessionUuid = undefined;
      removed = true;
    }
    return removed;
  }
}
