import { defaultIdGenerator, type IdGenerator } from "../utils/IdGenerator";

export class SessionToolBinding {
  private readonly boundDeviceSessions = new Map<string, string>();
  private initialSessionUuid?: string;
  /** The single stdio transport has no MCP session ID, so retain its device session here. */
  private directDeviceSessionUuid?: string;
  private initialCapabilityProfileUuid?: string;
  /** The single stdio transport has no MCP session ID, so retain its profile here. */
  private directCapabilityProfileUuid?: string;
  private readonly capabilityProfiles = new Map<string, string>();

  constructor(
    initialSessionUuid?: string,
    initialCapabilityProfileUuid?: string,
    private readonly idGenerator: IdGenerator = defaultIdGenerator,
  ) {
    this.initialSessionUuid = initialSessionUuid;
    this.initialCapabilityProfileUuid = initialCapabilityProfileUuid;
  }

  private boundSessionUuid(mcpSessionId: string | undefined): string | undefined {
    if (mcpSessionId) {
      return this.boundDeviceSessions.get(mcpSessionId) ?? this.initialSessionUuid;
    }
    return this.directDeviceSessionUuid ?? this.initialSessionUuid;
  }

  effectiveSessionUuid(mcpSessionId: string | undefined, params?: unknown): string | undefined {
    const explicit = params && typeof params === "object" && !Array.isArray(params)
      ? (params as Record<string, unknown>).sessionUuid
      : undefined;
    const explicitSessionUuid = typeof explicit === "string" && explicit.trim().length > 0
      ? explicit
      : undefined;
    const boundSessionUuid = this.boundSessionUuid(mcpSessionId);
    if (
      this.initialSessionUuid &&
      explicitSessionUuid &&
      explicitSessionUuid !== this.initialSessionUuid
    ) {
      throw new Error(
        `MCP connection is bound to device session ${this.initialSessionUuid}; ` +
        `cannot route this call to ${explicitSessionUuid} until the binding is released.`
      );
    }
    return explicitSessionUuid ?? boundSessionUuid;
  }

  /**
   * Resolve the profile used solely for tool-capability policy. A generated
   * connection profile deliberately never becomes a routing/device session:
   * executePlan may release device sessions, but that must not erase a user's
   * capability choices for the still-open MCP connection.
   */
  effectiveCapabilityProfileUuid(mcpSessionId: string | undefined, params?: unknown): string | undefined {
    return this.connectionCapabilityProfileUuid(mcpSessionId) ?? this.effectiveSessionUuid(mcpSessionId, params);
  }

  /** Connection-scoped profile, deliberately independent of routing sessions. */
  connectionCapabilityProfileUuid(mcpSessionId: string | undefined): string | undefined {
    return mcpSessionId
      ? this.capabilityProfiles.get(mcpSessionId) ?? this.initialCapabilityProfileUuid
      : this.directCapabilityProfileUuid ?? this.initialCapabilityProfileUuid;
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
      return true;
    }
    if (this.boundDeviceSessions.get(mcpSessionId) === sessionUuid) {
      return false;
    }
    this.boundDeviceSessions.set(mcpSessionId, sessionUuid);
    return true;
  }

  /** Creates and binds a persistent capability profile without selecting a device session. */
  createAndBindCapabilityProfile(mcpSessionId: string | undefined): string {
    const sessionUuid = this.idGenerator.next();
    this.bindCapabilityProfile(mcpSessionId, sessionUuid);
    return sessionUuid;
  }

  /** Associate a persisted profile with this MCP connection without changing device routing. */
  bindCapabilityProfile(mcpSessionId: string | undefined, sessionUuid: string | undefined): boolean {
    if (!sessionUuid?.trim()) {
      return false;
    }
    if (mcpSessionId) {
      if (this.capabilityProfiles.get(mcpSessionId) === sessionUuid) {
        return false;
      }
      this.capabilityProfiles.set(mcpSessionId, sessionUuid);
    } else {
      if (this.directCapabilityProfileUuid === sessionUuid) {
        return false;
      }
      this.directCapabilityProfileUuid = sessionUuid;
    }
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
    if (this.directDeviceSessionUuid === sessionUuid) {
      this.directDeviceSessionUuid = undefined;
      removed = true;
    }
    return removed;
  }
}
