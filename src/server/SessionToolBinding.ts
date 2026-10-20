import { nonBlankSessionUuid } from "./planCallerIdentity";
import {
  DeviceOutsideBoundSessionError,
  SessionOutsideBoundSessionError,
} from "../daemon/deviceOutsideBoundSessionRefusal";
import { defaultIdGenerator, type IdGenerator } from "../utils/IdGenerator";
import {
  SessionToolBindingStore,
  type SessionToolBindingLocalState,
} from "./sessionToolBindingStore";

/**
 * One server's view of the session-tool bindings. The `mcpSessionId` every method
 * takes is the request's session key (#4678): bindings recorded under a key live in
 * the {@link SessionToolBindingStore}, so every server sharing the store sees them.
 * A keyless call uses this instance's direct slot (stdio has one connection).
 */
export class SessionToolBinding implements SessionToolBindingLocalState {
  /** Sessions acquired on the keyless direct slot; keyed acquisitions live in the store. */
  private readonly directAcquiredSessions = new Set<string>();
  private initialSessionUuid?: string;
  private releasedInitialSessionUuid?: string;
  /** The single stdio transport has no MCP session ID, so retain its device session here. */
  private directDeviceSessionUuid?: string;
  private releasedDirectDeviceSessionUuid?: string;
  private initialToolSelectionProfileUuid?: string;
  /** The single stdio transport has no MCP session ID, so retain its profile here. */
  private directToolSelectionProfileUuid?: string;
  private readonly detachFromStore: () => void;

  constructor(
    initialSessionUuid?: string,
    initialToolSelectionProfileUuid?: string,
    private readonly idGenerator: IdGenerator = defaultIdGenerator,
    initialReleasedSessionUuid?: string,
    /**
     * Whether the first session is a live session of the same plan as the second (#11602): a
     * derived `${base}:${label}` session counts as its base. The daemon ingress asks the same
     * question with the same function, so the two cannot disagree.
     */
    private readonly namesLiveSessionOfBoundPlan: (
      sessionUuid: string,
      boundSessionUuid: string,
    ) => boolean = () => false,
    /** Where keyed bindings live; a private store keeps them to this instance. */
    private readonly store: SessionToolBindingStore = new SessionToolBindingStore(),
  ) {
    this.initialSessionUuid = initialSessionUuid;
    this.initialToolSelectionProfileUuid = initialToolSelectionProfileUuid;
    this.releasedInitialSessionUuid = initialReleasedSessionUuid;
    this.detachFromStore = store.attach(this);
  }

  /** Stop receiving the store's release teardown; keyed bindings stay in the store. */
  dispose(): void {
    this.detachFromStore();
  }

  private boundSessionUuid(mcpSessionId: string | undefined): string | undefined {
    if (mcpSessionId) {
      return this.store.boundSessionUuid(mcpSessionId) ?? this.initialSessionUuid;
    }
    return this.directDeviceSessionUuid ?? this.initialSessionUuid;
  }

  effectiveSessionUuid(
    mcpSessionId: string | undefined,
    params?: unknown,
    options?: { readOnly?: boolean; onReadOutsideBoundSession: () => void },
  ): string | undefined {
    const explicit =
      params && typeof params === "object" && !Array.isArray(params)
        ? (params as Record<string, unknown>).sessionUuid
        : undefined;
    const explicitSessionUuid = nonBlankSessionUuid(explicit);
    const boundSessionUuid = this.boundSessionUuid(mcpSessionId);
    // The connection's own tool-selection profile is not a device route: the
    // daemon-proxy loopback for an acquired device carries it as its second
    // seed, and reaffirming it (`setToolEnabled { sessionUuid: <profile> }`)
    // must reach the profile update rather than trip the cross-routing refusal
    // meant for a DIFFERENT device session (#7005).
    if (
      this.initialSessionUuid &&
      explicitSessionUuid &&
      explicitSessionUuid !== this.initialSessionUuid &&
      explicitSessionUuid !== this.connectionToolSelectionProfileUuid(mcpSessionId) &&
      // A connection seeded with the base, or with one of its labels, names its own plan's
      // sessions; whose base it is stays the owner rule's question.
      !this.namesLiveSessionOfBoundPlan(explicitSessionUuid, this.initialSessionUuid)
    ) {
      if (options?.readOnly) {
        options.onReadOutsideBoundSession();
      } else {
        throw new SessionOutsideBoundSessionError(
          this.initialSessionUuid,
          explicitSessionUuid,
          `MCP connection is bound to device session ${this.initialSessionUuid}; ` +
            `cannot route this call to ${explicitSessionUuid} until the binding is released. Use a separate MCP connection for ${explicitSessionUuid}.`,
        );
      }
    }
    return explicitSessionUuid ?? boundSessionUuid;
  }

  /**
   * Resolve selectors only within sessions admitted on this connection. `deferForeignDevice`: when
   * the bound session's device is not the explicitly requested `deviceId`, return the bound session
   * instead of failing on the binding, so the tool registry decides — a read watches the named
   * device sessionless (reads stay open everywhere, owner decision Q6), and a managed connection's
   * control call gets its typed `device_outside_broker_grant` refusal (#11271).
   */
  resolveDeviceSessionUuid(
    mcpSessionId: string | undefined,
    params: Record<string, unknown>,
    lookup: (sessionUuid: string) => { deviceId: string; platform: string } | undefined,
    selectingActiveDevice = false,
    deferForeignDevice = false,
    readOnly?: boolean,
  ): string | undefined {
    const fallback = this.effectiveSessionUuid(mcpSessionId, params, {
      readOnly,
      onReadOutsideBoundSession: () => {},
    });
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
      // A named foreign device may be deferred to the registry; a platform alone cannot.
      assertBoundSessionMatches(
        lookup(this.initialSessionUuid),
        matches,
        fallback,
        deferForeignDevice && deviceId !== undefined,
        { deviceId, platform },
      );
      return fallback;
    }
    return this.resolveAcquiredDeviceSession(
      mcpSessionId,
      lookup,
      matches,
      deviceId,
      fallback,
      selectingActiveDevice,
    );
  }

  private resolveAcquiredDeviceSession(
    mcpSessionId: string | undefined,
    lookup: (sessionUuid: string) => { deviceId: string; platform: string } | undefined,
    matches: (device: { deviceId: string; platform: string }) => boolean,
    deviceId: string | undefined,
    rebindFallback?: string,
    selectingActiveDevice = false,
  ): string | undefined {
    const candidates = [...this.acquiredSessionUuids(mcpSessionId)].flatMap((sessionUuid) => {
      const device = lookup(sessionUuid);
      return device ? [{ sessionUuid, ...device }] : [];
    });
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
    if (selected.length === 0) {
      // Nothing held for the requested platform/device is not ambiguous (#11193):
      // an explicit device outside this connection's sessions, or a platform the
      // connection holds nothing for, continues to ordinary discovery, where the
      // standard admission gate runs.
      return undefined;
    }
    if (selected.length === 1) {
      return selected[0].sessionUuid;
    }
    throw new Error(
      `Cannot resolve requested platform/deviceId unambiguously. Candidate sessions: ${selected
        .map(
          (candidate) => `${candidate.sessionUuid} (${candidate.deviceId}, ${candidate.platform})`,
        )
        .join(", ")}. Pass an explicit sessionUuid/deviceId.`,
    );
  }

  private acquiredSessionUuids(mcpSessionId: string | undefined): ReadonlySet<string> {
    return mcpSessionId
      ? this.store.acquiredSessionUuids(mcpSessionId)
      : this.directAcquiredSessions;
  }

  ownsSession(mcpSessionId: string | undefined, sessionUuid: string): boolean {
    return (
      this.initialSessionUuid === sessionUuid ||
      this.acquiredSessionUuids(mcpSessionId).has(sessionUuid)
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
      return this.store.releasedSessionUuid(mcpSessionId) ?? this.releasedInitialSessionUuid;
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
      ? (this.store.toolSelectionProfileUuid(mcpSessionId) ?? this.initialToolSelectionProfileUuid)
      : (this.directToolSelectionProfileUuid ?? this.initialToolSelectionProfileUuid);
  }

  bind(mcpSessionId: string | undefined, sessionUuid: string | undefined): boolean {
    if (!sessionUuid?.trim()) {
      return false;
    }
    if (this.initialSessionUuid && sessionUuid !== this.initialSessionUuid) {
      return false;
    }
    if (mcpSessionId) {
      return this.store.bind(mcpSessionId, sessionUuid);
    }
    this.directAcquiredSessions.add(sessionUuid);
    if (this.directDeviceSessionUuid === sessionUuid) {
      return false;
    }
    this.directDeviceSessionUuid = sessionUuid;
    this.releasedDirectDeviceSessionUuid = undefined;
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
      return this.store.bindToolSelectionProfile(mcpSessionId, sessionUuid);
    }
    if (this.directToolSelectionProfileUuid === sessionUuid) {
      return false;
    }
    this.directToolSelectionProfileUuid = sessionUuid;
    return true;
  }

  /**
   * Drop every binding whose effective session is the just-released
   * `sessionUuid` (issue #4611 Gap D). After an executePlan (or a heartbeat/idle)
   * release frees a daemon session, the per-transport binding must be torn down
   * so a later sessionless `tools/list`/`tools/call` on the SAME MCP transport
   * stops enforcing the released session's (now stale) tool-selection profile.
   *
   * Both binding origins are cleared: every keyed store entry pointing at the
   * session (for every server sharing the store) AND this instance's seeded
   * `initialSessionUuid` / direct-slot fallback that `effectiveSessionUuid` would
   * otherwise still return. Idempotent — returns whether anything was actually
   * removed, so callers can skip a redundant list-changed notification when a
   * duplicate release signal arrives.
   */
  unbindSession(sessionUuid: string): boolean {
    const removed = this.store.releaseSession(sessionUuid);
    // A detached instance is not reached by the store; an attached one already was.
    return this.releaseLocalSession(sessionUuid) || removed;
  }

  /** Clears this instance's seeded and direct-slot bindings for a released session. */
  releaseLocalSession(sessionUuid: string): boolean {
    if (!sessionUuid) {
      return false;
    }
    let removed = this.directAcquiredSessions.delete(sessionUuid);
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

function assertBoundSessionMatches(
  device: { deviceId: string; platform: string } | undefined,
  matches: (device: { deviceId: string; platform: string }) => boolean,
  sessionUuid: string | undefined,
  deferForeignDevice: boolean,
  requested: { deviceId?: string; platform?: string },
): void {
  if (!device || matches(device) || deferForeignDevice) {
    return;
  }
  throw new DeviceOutsideBoundSessionError(sessionUuid, device, requested);
}
