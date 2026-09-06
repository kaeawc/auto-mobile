import { defaultIdGenerator, type IdGenerator } from "../utils/IdGenerator";

export class SessionToolBinding {
  private readonly boundDeviceSessions = new Map<string, string>();
  private readonly releasedDeviceSessions = new Map<string, string>();
  private initialSessionUuid?: string;
  private releasedInitialSessionUuid?: string;
  /** The single stdio transport has no MCP session ID, so retain its device session here. */
  private directDeviceSessionUuid?: string;
  private releasedDirectDeviceSessionUuid?: string;
  private initialToolSelectionProfileUuid?: string;
  /** The single stdio transport has no MCP session ID, so retain its profile here. */
  private directToolSelectionProfileUuid?: string;
  private readonly toolSelectionProfiles = new Map<string, string>();

  constructor(
    initialSessionUuid?: string,
    initialToolSelectionProfileUuid?: string,
    private readonly idGenerator: IdGenerator = defaultIdGenerator,
    initialReleasedSessionUuid?: string,
  ) {
    this.initialSessionUuid = initialSessionUuid;
    this.initialToolSelectionProfileUuid = initialToolSelectionProfileUuid;
    this.releasedInitialSessionUuid = initialReleasedSessionUuid;
  }

  private boundSessionUuid(mcpSessionId: string | undefined): string | undefined {
    if (mcpSessionId) {
      return this.boundDeviceSessions.get(mcpSessionId) ?? this.initialSessionUuid;
    }
    return this.directDeviceSessionUuid ?? this.initialSessionUuid;
  }

  effectiveSessionUuid(mcpSessionId: string | undefined, params?: unknown): string | undefined {
    const explicit =
      params && typeof params === "object" && !Array.isArray(params)
        ? (params as Record<string, unknown>).sessionUuid
        : undefined;
    const explicitSessionUuid =
      typeof explicit === "string" && explicit.trim().length > 0 ? explicit : undefined;
    const boundSessionUuid = this.boundSessionUuid(mcpSessionId);
    if (
      this.initialSessionUuid &&
      explicitSessionUuid &&
      explicitSessionUuid !== this.initialSessionUuid
    ) {
      throw new Error(
        `MCP connection is bound to device session ${this.initialSessionUuid}; ` +
          `cannot route this call to ${explicitSessionUuid} until the binding is released.`,
      );
    }
    return explicitSessionUuid ?? boundSessionUuid;
  }

  /** A released identity is not an authorization grant for a replacement session. */
  releasedResourceSessionUuid(mcpSessionId: string | undefined): string | undefined {
    if (this.boundSessionUuid(mcpSessionId)) {
      return undefined;
    }
    if (mcpSessionId) {
      return this.releasedDeviceSessions.get(mcpSessionId) ?? this.releasedInitialSessionUuid;
    }
    return this.releasedDirectDeviceSessionUuid ?? this.releasedInitialSessionUuid;
  }

  /**
   * Resolve the profile used solely for exact-tool selection. A generated
   * connection profile deliberately never becomes a routing/device session:
   * executePlan may release device sessions, but that must not erase a user's
   * tool choices for the still-open MCP connection.
   */
  effectiveToolSelectionProfileUuid(
    mcpSessionId: string | undefined,
    params?: unknown,
  ): string | undefined {
    return (
      this.connectionToolSelectionProfileUuid(mcpSessionId) ??
      this.effectiveSessionUuid(mcpSessionId, params)
    );
  }

  /** Connection-scoped profile, deliberately independent of routing sessions. */
  connectionToolSelectionProfileUuid(mcpSessionId: string | undefined): string | undefined {
    return mcpSessionId
      ? (this.toolSelectionProfiles.get(mcpSessionId) ?? this.initialToolSelectionProfileUuid)
      : (this.directToolSelectionProfileUuid ?? this.initialToolSelectionProfileUuid);
  }

  /**
   * True only when `sessionUuid` is the profile THIS instance itself generated
   * and bound for this exact connection (via {@link createAndBindToolSelectionProfile}
   * / {@link bindToolSelectionProfile}) — never the `initialToolSelectionProfileUuid`
   * fallback, which is threaded verbatim from an unauthenticated, caller-controlled
   * transport header (DAEMON_TOOL_SELECTION_PROFILE_HEADER, see src/daemon/daemon.ts)
   * with no issuance check of its own.
   *
   * A proxied caller can set that header to any string, including one it also
   * sends as an explicit `sessionUuid` argument, so `connectionToolSelectionProfileUuid`
   * alone is not a safe provenance signal for bypassing session admission (#6148
   * round 2). This narrower check is: callers may freely re-affirm a profile the
   * server actually minted for them, but an unverified header value never counts.
   */
  isServerIssuedToolSelectionProfile(
    mcpSessionId: string | undefined,
    sessionUuid: string,
  ): boolean {
    return mcpSessionId
      ? this.toolSelectionProfiles.get(mcpSessionId) === sessionUuid
      : this.directToolSelectionProfileUuid === sessionUuid;
  }

  bind(mcpSessionId: string | undefined, sessionUuid: string | undefined): boolean {
    if (!sessionUuid?.trim()) {
      return false;
    }
    if (this.initialSessionUuid && sessionUuid !== this.initialSessionUuid) {
      return false;
    }
    if (!mcpSessionId) {
      if (this.directDeviceSessionUuid === sessionUuid) {
        return false;
      }
      this.directDeviceSessionUuid = sessionUuid;
      this.releasedDirectDeviceSessionUuid = undefined;
      return true;
    }
    if (this.boundDeviceSessions.get(mcpSessionId) === sessionUuid) {
      return false;
    }
    this.boundDeviceSessions.set(mcpSessionId, sessionUuid);
    this.releasedDeviceSessions.delete(mcpSessionId);
    return true;
  }

  /** Creates and binds a persistent tool-selection profile without selecting a device session. */
  createAndBindToolSelectionProfile(mcpSessionId: string | undefined): string {
    const sessionUuid = this.idGenerator.next();
    this.bindToolSelectionProfile(mcpSessionId, sessionUuid);
    return sessionUuid;
  }

  /** Associate a persisted profile with this MCP connection without changing device routing. */
  bindToolSelectionProfile(
    mcpSessionId: string | undefined,
    sessionUuid: string | undefined,
  ): boolean {
    if (!sessionUuid?.trim()) {
      return false;
    }
    if (mcpSessionId) {
      if (this.toolSelectionProfiles.get(mcpSessionId) === sessionUuid) {
        return false;
      }
      this.toolSelectionProfiles.set(mcpSessionId, sessionUuid);
    } else {
      if (this.directToolSelectionProfileUuid === sessionUuid) {
        return false;
      }
      this.directToolSelectionProfileUuid = sessionUuid;
    }
    return true;
  }

  /**
   * Drop every binding whose effective session is the just-released
   * `sessionUuid` (issue #4611 Gap D). After an executePlan (or a heartbeat/idle)
   * release frees a daemon session, the per-transport binding must be torn down
   * so a later sessionless `tools/list`/`tools/call` on the SAME MCP transport
   * stops enforcing the released session's (now stale) tool-selection profile.
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
        this.releasedDeviceSessions.set(mcpSessionId, sessionUuid);
        removed = true;
      }
    }
    if (this.initialSessionUuid === sessionUuid) {
      this.initialSessionUuid = undefined;
      this.releasedInitialSessionUuid = sessionUuid;
      removed = true;
    }
    if (this.directDeviceSessionUuid === sessionUuid) {
      this.directDeviceSessionUuid = undefined;
      this.releasedDirectDeviceSessionUuid = sessionUuid;
      removed = true;
    }
    return removed;
  }
}
