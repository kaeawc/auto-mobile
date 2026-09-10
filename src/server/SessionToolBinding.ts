import { defaultIdGenerator, type IdGenerator } from "../utils/IdGenerator";

export class SessionToolBinding {
  private readonly acquiredSessions = new Map<string | undefined, Set<string>>();
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

  /** Resolve selectors only within sessions admitted on this connection. */
  resolveDeviceSessionUuid(
    mcpSessionId: string | undefined,
    params: Record<string, unknown>,
    lookup: (sessionUuid: string) => { deviceId: string; platform: string } | undefined,
    selectingActiveDevice = false,
  ): string | undefined {
    const fallback = this.effectiveSessionUuid(mcpSessionId, params);
    const platform =
      params.platform === "android" || params.platform === "ios" ? params.platform : undefined;
    const deviceId = typeof params.deviceId === "string" ? params.deviceId : undefined;
    if ((!platform && !deviceId) || params.device) {
      return fallback;
    }
    const matches = (device: { deviceId: string; platform: string }) =>
      (!platform || device.platform === platform) && (!deviceId || device.deviceId === deviceId);
    if (params.sessionUuid) {
      return fallback;
    }
    if (this.initialSessionUuid) {
      const device = lookup(this.initialSessionUuid);
      if (device && !matches(device)) {
        throw new Error(
          `Bound device session ${fallback} does not match the requested platform/deviceId. Pass an explicit sessionUuid.`,
        );
      }
      return fallback;
    }
    return this.resolveAcquiredDeviceSession(
      mcpSessionId,
      lookup,
      matches,
      fallback,
      selectingActiveDevice,
    );
  }

  private resolveAcquiredDeviceSession(
    mcpSessionId: string | undefined,
    lookup: (sessionUuid: string) => { deviceId: string; platform: string } | undefined,
    matches: (device: { deviceId: string; platform: string }) => boolean,
    rebindFallback?: string,
    selectingActiveDevice = false,
  ): string | undefined {
    const candidates = [...(this.acquiredSessions.get(mcpSessionId) ?? [])].flatMap(
      (sessionUuid) => {
        const device = lookup(sessionUuid);
        return device ? [{ sessionUuid, ...device }] : [];
      },
    );
    if (candidates.length === 0) {
      // With no live acquired device, let ordinary device discovery resolve the selector.
      return undefined;
    }
    const selected = candidates.filter(matches);
    if (
      selected.length === 0 &&
      selectingActiveDevice &&
      rebindFallback &&
      candidates.some((candidate) => candidate.sessionUuid === rebindFallback)
    ) {
      return rebindFallback;
    }
    if (selected.length === 1) {
      return selected[0].sessionUuid;
    }
    throw new Error(
      `Cannot resolve requested platform/deviceId unambiguously. Candidate sessions: ${candidates
        .map(
          (candidate) => `${candidate.sessionUuid} (${candidate.deviceId}, ${candidate.platform})`,
        )
        .join(", ")}. Pass an explicit sessionUuid/deviceId.`,
    );
  }

  ownsSession(mcpSessionId: string | undefined, sessionUuid: string): boolean {
    return (
      this.initialSessionUuid === sessionUuid ||
      this.acquiredSessions.get(mcpSessionId)?.has(sessionUuid) === true
    );
  }

  /**
   * #6069: The connection's live device-session binding, whether seeded at
   * construction (`initialSessionUuid`) OR acquired mid-connection via `bind()`
   * (getAndroid/getApple, or a device tool with a valid sessionUuid). Unlike
   * {@link effectiveSessionUuid}'s cross-routing throw — which fires for every
   * tool and so is deliberately kept to construction-seeded bindings to leave
   * plain (non-device) tools free to carry any sessionUuid (e.g. a tool-selection
   * profile) — this exposes the bound id so the caller can enforce ownership on
   * the DEVICE-routing path only. Keying that throw on this instead of
   * `initialSessionUuid` closes the residual bypass where a later device-tool
   * call on a connection that already holds an active session passed a DIFFERENT
   * (fabricated/typo'd/stale) `sessionUuid` and was auto-assigned a SECOND,
   * foreign device (`#6019`/`#6045` behind an active-session precondition).
   */
  boundDeviceSessionUuid(mcpSessionId: string | undefined): string | undefined {
    return this.boundSessionUuid(mcpSessionId);
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

  bind(mcpSessionId: string | undefined, sessionUuid: string | undefined): boolean {
    if (!sessionUuid?.trim()) {
      return false;
    }
    if (this.initialSessionUuid && sessionUuid !== this.initialSessionUuid) {
      return false;
    }
    let acquired = this.acquiredSessions.get(mcpSessionId);
    if (!acquired) {
      acquired = new Set<string>();
      this.acquiredSessions.set(mcpSessionId, acquired);
    }
    acquired.add(sessionUuid);
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
    for (const acquired of this.acquiredSessions.values()) {
      removed = acquired.delete(sessionUuid) || removed;
    }
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
