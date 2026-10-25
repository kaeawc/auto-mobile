import {
  DaemonBoundSessionExpiredError,
  DaemonSessionStalledError,
  DaemonConnectionSessionReleasedError,
  DaemonAmbiguousSessionSelectorError,
} from "./daemonErrors";
import type { ProxySessionState, StallHandoverRecord } from "./ProxySessionState";
import type { PendingHeldSessionLoss } from "./HeldSessionLosses";
import type { ReleaseEpochLedger } from "./ReleaseEpochLedger";
import type { Timer } from "../../utils/SystemTimer";
import type { SessionReleaseSnapshot } from "../sessionManager/releaseTypes";
import { DAEMON_BOUND_SESSION_PARAM } from "../wire/constants";
import { SET_TOOL_ENABLED_TOOL_NAME } from "../../features/toolSelection/toolSelectionControl";
import {
  DAEMON_STALLED_CODE,
  PROXY_STALLED_CODE,
  type LivenessHandover,
} from "../proxyLivenessRecovery";
import { IDLE_WINDOW_RELEASE_REASON, REPLAY_LEASE_EXPIRED_REASON } from "../releaseReasons";

/** Live proxy-owned state and the routing/lifecycle operations shared with other collaborators. */
export interface BoundSessionFenceGatePort {
  readonly state: Pick<
    ProxySessionState,
    | "terminalBoundSession"
    | "boundSessionUuid"
    | "boundSessionUuidAt"
    | "initialSessionBindingConfigured"
    | "boundSessionFromResultMint"
    | "releaseSurfacedFor"
    | "stallHandovers"
    | "plainRestartSessionLosses"
    | "pendingSessionLosses"
    | "daemonIdleReports"
    | "otherHeldSessions"
  >;
  readonly pendingHeldSessionPlatformLosses: Map<string, PendingHeldSessionLoss>;
  readonly ownedDeviceSessions: ReadonlySet<string>;
  readonly sessionDeviceIds: ReadonlyMap<string, string>;
  readonly sessionPlatforms: ReadonlyMap<string, "android" | "ios">;
  readonly releaseLedger: Pick<
    ReleaseEpochLedger,
    "sessionReleaseReasonSince" | "releasedSessionReasons"
  >;
  readonly timer: Timer;
  readonly livenessRecovery: { isRecovering(sessionUuid: string): boolean };
  readonly keeper: { syncHeartbeatKeeper(): void };
  initialSessionUuid(): string | undefined;
  boundSessionReplayTtlMs(): number;
  transportLive(): boolean;
  toolSelectionProfileUuid(): string | undefined;
  bumpDiscoveryEpoch(): void;
  isDeviceSessionAcquisitionTool(name: string): boolean;
  isDeviceInventoryTool(name: string): boolean;
  isDeviceBindingTool(name: string): boolean;
  isSessionlessControlDeviceTool(name: string, args?: Record<string, unknown>): boolean;
  toolTargetsDevice(name: string): boolean;
  isDeviceReadOnlyTool(name: string, args?: Record<string, unknown>): boolean;
  hasSessionCallInFlight(sessionUuid: string): boolean;
  noteReleaseSurfacedBy(answer: unknown): void;
  currentHandover(sessionUuid: string, record: StallHandoverRecord): LivenessHandover;
  outsideBoundSessionError(boundSessionUuid: string, sessionUuid: string): Error;
  dropHeldSession(sessionUuid: string, keepHandover?: boolean): void;
  forgetSessionLivenessState(sessionUuid: string, keepHandover?: boolean): void;
  invalidateCache(): void;
  clearBoundSessionUuid(): void;
  notifyListChanged(kind: "tools"): void;
  withToolSelectionProfile(args: Record<string, unknown>): Record<string, unknown>;
  withOwnedSessionCapabilities(
    args: Record<string, unknown>,
    restore: boolean,
    namesOwnedSession: boolean,
    isSessionAcquisition: boolean,
  ): Record<string, unknown>;
  namesOwnedSession(args: Record<string, unknown>): boolean;
  sessionUuidFromArgs(args: Record<string, unknown>): string | undefined;
}

// A tool-output artifact read (`automobile:tool-output/<id>`) is a plain host
// file read routed through the session-independent resource registry — no device
// access and no session data. So unlike the fresh-screenshot exemption it is not
// scoped to any session, and it must stay retrievable after a terminal release
// (e.g. executePlan auto-releases its bound session, then emits an artifact
// resourceUri that would otherwise be fenced). Kept in lockstep with the
// `automobile:tool-output/` prefix in src/server/toolOutputResources.ts.
export function isToolOutputResourceUri(uri: string): boolean {
  return uri.startsWith("automobile:tool-output/");
}

// The session UUID embedded in a session-scoped observation resource URI, or
// undefined for any other URI. Kept in lockstep with RESOURCE_URIS in
// src/server/observationResources.ts.
function sessionScopedObservationUriSessionUuid(uri: string): string | undefined {
  const match = uri.match(
    /^automobile:(?:observation\/session\/([^/]+)\/latest(?:\/screenshot)?|device-session\/([^/]+)\/screenshot)$/,
  );
  return match?.[1] ?? match?.[2];
}

/**
 * Whether a resource URI names a device session at all: every `automobile:device-session/<id>/...`
 * and `automobile:observation/session/<id>/...` form, whatever follows the session segment. These
 * two prefixes are where the server registers its session-scoped templates
 * (test/daemon/proxySessionNamingResourceFence.test.ts checks every registered template against
 * this), so a new session-scoped resource is covered without listing it here.
 */
export function resourceUriNamesSession(uri: string): boolean {
  return /^automobile:(?:device-session|observation\/session)\/[^/?#]+/.test(uri);
}

/** Terminal binding refusals and survivor routing; all state remains owned by DaemonMcpProxy. */
export class BoundSessionFenceGate {
  constructor(private readonly port: BoundSessionFenceGatePort) {}

  private sessionUuidFromArgs(args: Record<string, unknown>): string | undefined {
    return this.port.sessionUuidFromArgs(args);
  }

  throwIfLivenessHandedOver(): void {
    const first = this.port.state.stallHandovers.entries().next().value;
    if (first) {
      const [sessionUuid, record] = first;
      throw new DaemonSessionStalledError(
        sessionUuid,
        this.port.currentHandover(sessionUuid, record),
      );
    }
  }

  /** A fenced control must name a held session or its known, unique device (#11656). */
  withFencedControlDeviceSession(
    name: string,
    args: Record<string, unknown>,
  ): Record<string, unknown> {
    if (!this.port.isSessionlessControlDeviceTool(name, args)) {
      return args;
    }
    // A selector call may itself discover the idle release. Fence before resolving its device,
    // so loss reporting, stall recovery and routing all see the same named survivor.
    if (!this.port.state.terminalBoundSession && this.isBoundSessionReplayExpired()) {
      this.retireIdleBinding(this.port.state.boundSessionUuid!);
    }
    const terminal = this.port.state.terminalBoundSession;
    if (!terminal) {
      return args;
    }
    const holder = this.sessionUuidFromArgs(args) ?? this.survivingSessionHoldingDevice(args);
    // The daemon must preserve its default as well: the fenced UUID marks this as one call
    // on a sibling, even though terminal fencing cleared the proxy's live binding.
    return holder === undefined
      ? args
      : { ...args, sessionUuid: holder, [DAEMON_BOUND_SESSION_PARAM]: terminal.sessionUuid };
  }

  refuseAmbiguousSessionSelector(name: string, args: Record<string, unknown>): void {
    const platform = args.platform;
    const bound = this.port.state.boundSessionUuid;
    if (
      this.port.state.initialSessionBindingConfigured ||
      !this.port.isSessionlessControlDeviceTool(name, args) ||
      (platform !== "android" && platform !== "ios") ||
      typeof args.deviceId === "string" ||
      this.sessionUuidFromArgs(args) !== undefined ||
      args.device ||
      !bound ||
      this.port.state.terminalBoundSession
    ) {
      return;
    }
    // Unknown platforms cannot truthfully count as matches (#11714).
    const candidates = [...new Set([bound, ...this.port.state.otherHeldSessions.keys()])]
      .filter((id) => this.port.sessionPlatforms.get(id) === platform)
      .map((sessionUuid) => {
        const deviceId = this.port.sessionDeviceIds.get(sessionUuid);
        return { sessionUuid, ...(deviceId === undefined ? {} : { deviceId }) };
      });
    if (candidates.length > 1) {
      throw new DaemonAmbiguousSessionSelectorError(platform, candidates);
    }
  }

  private survivingSessionHoldingDevice(args: Record<string, unknown>): string | undefined {
    if (!this.hasImplicitDeviceSelector(args, false) || typeof args.deviceId !== "string") {
      return undefined;
    }
    let holder: string | undefined;
    for (const id of this.port.ownedDeviceSessions) {
      if (id === this.port.state.terminalBoundSession?.sessionUuid) {
        continue;
      }
      const deviceId = this.port.sessionDeviceIds.get(id);
      // An unknown device might be a second holder: do not guess uniqueness.
      if (deviceId === undefined) {
        return undefined;
      }
      if (deviceId === args.deviceId) {
        if (holder !== undefined) {
          return undefined;
        }
        holder = id;
      }
    }
    return holder;
  }

  prepareToolRoutingArgs(
    name: string,
    callerArgs: Record<string, unknown>,
    isSessionAcquisition: boolean,
  ): {
    forwardedArgs: Record<string, unknown>;
    allowReleasedSession: boolean;
  } {
    const isTerminalSessionlessDiscovery =
      this.port.state.terminalBoundSession !== undefined &&
      this.sessionUuidFromArgs(callerArgs) === undefined &&
      (this.port.isDeviceInventoryTool(name) ||
        this.isSessionlessReadAfterRelease(name, callerArgs));
    const usesDeviceSelector =
      this.port.toolTargetsDevice(name) &&
      this.hasImplicitDeviceSelector(callerArgs, name === "setActiveDevice") &&
      !this.platformSelectorTargetsBoundSession(name, callerArgs);
    const omitBoundSession =
      isSessionAcquisition ||
      isTerminalSessionlessDiscovery ||
      this.port.isDeviceInventoryTool(name);
    const routingArgs = this.routingArgsForTool(
      name,
      callerArgs,
      usesDeviceSelector,
      omitBoundSession,
    );
    const canUseSurvivingSession = this.canUseSurvivingSession(
      callerArgs,
      usesDeviceSelector,
      name,
    );
    const forwardedArgs = this.port.withToolSelectionProfile(
      this.port.withOwnedSessionCapabilities(
        routingArgs,
        usesDeviceSelector || isSessionAcquisition,
        this.port.namesOwnedSession(callerArgs),
        isSessionAcquisition,
      ),
    );
    return {
      forwardedArgs,
      allowReleasedSession:
        isSessionAcquisition || isTerminalSessionlessDiscovery || canUseSurvivingSession,
    };
  }

  private routingArgsForTool(
    name: string,
    callerArgs: Record<string, unknown>,
    usesDeviceSelector: boolean,
    omitBoundSession: boolean,
  ): Record<string, unknown> {
    if (name === SET_TOOL_ENABLED_TOOL_NAME) {
      return this.withAcquiredDeviceRoute(callerArgs);
    }
    // Inventory retains an explicit caller route but never inherits the proxy's binding.
    return omitBoundSession
      ? callerArgs
      : this.withBoundSessionUuid(callerArgs, usesDeviceSelector, name);
  }

  /**
   * Read-only access never requires a session (owner decision 2026-10-09, #10971). After the
   * binding is released, a managed read-only tool naming a deviceId and no session is forwarded
   * without a session immediately, without marking the release as reported. Non-managed reads
   * require one call to report the release first. The daemon serves these on its read-only device
   * path. Control tools and managed reads without a deviceId keep the fence, as does a liveness
   * handover, which every call reports until the harness acts on it.
   */
  private isSessionlessReadAfterRelease(name: string, args: Record<string, unknown>): boolean {
    const terminal = this.port.state.terminalBoundSession;
    return (
      terminal !== undefined &&
      !this.port.state.stallHandovers.has(terminal.sessionUuid) &&
      this.port.state.releaseSurfacedFor === terminal.sessionUuid &&
      this.port.isDeviceReadOnlyTool(name, args)
    );
  }

  private hasImplicitDeviceSelector(
    args: Record<string, unknown>,
    selectingActiveDevice: boolean,
  ): boolean {
    if (this.port.state.initialSessionBindingConfigured || args.device) {
      return false;
    }
    if (selectingActiveDevice) {
      return true;
    }
    return (
      typeof args.deviceId === "string" || args.platform === "android" || args.platform === "ios"
    );
  }

  /** A platform-only call uses the default only when it is the unique known held match. */
  private platformSelectorTargetsBoundSession(
    name: string,
    args: Record<string, unknown>,
  ): boolean {
    const ownSession = this.ownSessionForPlatformSelector(name, args);
    return ownSession !== undefined && ownSession === this.port.state.boundSessionUuid;
  }

  /**
   * Route platform-only device calls to their unique held session when every held platform is
   * known. Sibling-only selection preserves startup binding and expired-default routing;
   * default selection leaves injection and release reporting to the existing bound-session path.
   */
  ownSessionForPlatformSelector(
    name: string,
    args: Record<string, unknown>,
    siblingOnly = false,
  ): string | undefined {
    const bound = this.port.state.boundSessionUuid;
    if (
      this.port.isDeviceBindingTool(name) ||
      !this.port.toolTargetsDevice(name) ||
      !this.hasImplicitDeviceSelector(args, false) ||
      typeof args.deviceId === "string" ||
      this.sessionUuidFromArgs(args) !== undefined ||
      (siblingOnly && this.shouldPreserveSiblingSelectorRouting()) ||
      !bound ||
      this.port.state.terminalBoundSession
    ) {
      return undefined;
    }
    const held = [...new Set([bound, ...this.port.state.otherHeldSessions.keys()])];
    if (held.some((id) => this.port.sessionPlatforms.get(id) === undefined)) {
      return undefined;
    }
    const candidates = held.filter((id) => this.port.sessionPlatforms.get(id) === args.platform);
    return candidates.find((id) => candidates.length === 1 && (!siblingOnly || id !== bound));
  }

  private shouldPreserveSiblingSelectorRouting(): boolean {
    return !!this.port.initialSessionUuid() || this.isBoundSessionReplayExpired();
  }

  /**
   * A session this proxy holds under its own token (#10990) is routable beside the startup
   * binding. So is a `${bound}:${label}` name (#11602): whether it is a live label of the bound
   * session's plan is the daemon's to judge, which alone knows the label map.
   */
  private routableBesideStartupBinding(sessionUuid: string): boolean {
    return (
      this.port.state.otherHeldSessions.has(sessionUuid) ||
      sessionUuid.startsWith(`${this.port.state.boundSessionUuid}:`)
    );
  }

  withBoundSessionUuid(
    args: Record<string, unknown>,
    usesDeviceSelector = false,
    toolName?: string,
  ): Record<string, unknown> {
    // A daemon session released by ordinary heartbeat/idle expiry leaves this
    // remembered binding dangling; replaying its UUID on a later sessionless call
    // would silently recreate the session and reacquire a device without the
    // caller asking for it (issue #4610). Once the replay window has elapsed with
    // no forwarded call (explicit or implicit) refreshing the binding, treat it
    // as retired.
    const explicitSessionUuid = this.sessionUuidFromArgs(args);
    if (!this.canUseSurvivingSession(args, usesDeviceSelector, toolName)) {
      this.throwIfBoundSessionUnavailable(explicitSessionUuid, () =>
        this.canUseSurvivingSession(args, usesDeviceSelector, toolName),
      );
    }
    const normalizedArgs =
      explicitSessionUuid && explicitSessionUuid !== args.sessionUuid
        ? { ...args, sessionUuid: explicitSessionUuid }
        : args;
    if (
      !this.port.state.boundSessionUuid ||
      explicitSessionUuid === this.port.state.boundSessionUuid
    ) {
      return normalizedArgs;
    }
    const enforcesStartupBinding = () =>
      this.port.state.initialSessionBindingConfigured &&
      (toolName === undefined || !this.port.isDeviceReadOnlyTool(toolName, args));
    if (
      explicitSessionUuid &&
      enforcesStartupBinding() &&
      !this.routableBesideStartupBinding(explicitSessionUuid)
    ) {
      throw this.port.outsideBoundSessionError(
        this.port.state.boundSessionUuid,
        explicitSessionUuid,
      );
    }
    if (explicitSessionUuid) {
      // The call targets the named session only. Carrying the binding beside it tells the daemon
      // socket that this connection's default is unchanged, so its route stays put (#11347).
      return { ...normalizedArgs, [DAEMON_BOUND_SESSION_PARAM]: this.port.state.boundSessionUuid };
    }
    // A caller's device selector must reach daemon autolock resolution without
    // being disguised as an explicitly supplied session UUID (#6807).
    if (usesDeviceSelector) {
      return normalizedArgs;
    }
    return {
      ...args,
      sessionUuid: this.port.state.boundSessionUuid,
      [DAEMON_BOUND_SESSION_PARAM]: this.port.state.boundSessionUuid,
    };
  }

  private canUseSurvivingSession(
    args: Record<string, unknown>,
    usesDeviceSelector: boolean,
    toolName?: string,
  ): boolean {
    if (!this.port.state.terminalBoundSession || this.port.initialSessionUuid()) {
      return false;
    }
    const explicit = this.sessionUuidFromArgs(args);
    const liveOwned = [...this.port.ownedDeviceSessions].filter(
      (id) => id !== this.port.state.terminalBoundSession?.sessionUuid,
    );
    return explicit
      ? liveOwned.includes(explicit)
      : liveOwned.length > 0 &&
          usesDeviceSelector &&
          (toolName === undefined ||
            toolName === "setActiveDevice" ||
            this.port.isDeviceReadOnlyTool(toolName, args));
  }

  private throwIfBoundSessionUnavailable(
    explicitSessionUuid?: string,
    survivingSessionUsable?: () => boolean,
  ): void {
    this.throwIfFencedForCaller(explicitSessionUuid);
    if (!this.isBoundSessionReplayExpired()) {
      return;
    }
    this.retireIdleBinding(this.port.state.boundSessionUuid!);
    // The latest binding idled out, but a selector call may still reach another live session
    // this proxy holds (#10692): only the idle binding is retired, not the caller's device.
    if (survivingSessionUsable?.()) {
      return;
    }
    this.throwIfFencedForCaller(explicitSessionUuid);
  }

  private throwIfPlainRestartSessionLost(sessionUuid?: string): void {
    if (sessionUuid === undefined) {
      return;
    }
    const reason = this.port.state.plainRestartSessionLosses.get(sessionUuid);
    if (reason === undefined) {
      return;
    }
    const terminal = this.port.state.terminalBoundSession;
    const release =
      this.port.pendingHeldSessionPlatformLosses.get(sessionUuid)?.release ??
      (terminal?.sessionUuid === sessionUuid ? terminal.release : undefined);
    const answer = new DaemonBoundSessionExpiredError(sessionUuid, reason, release);
    this.port.noteReleaseSurfacedBy(answer);
    throw answer;
  }

  // Surface a terminal fence to a caller, distinguishing whether the caller
  // referenced the fenced session. A client-declared binding (explicit
  // `sessionUuid`, or the same UUID named again) — or any explicit reference to
  // the fenced UUID — yields the ownership-lost-for-UUID error. A call that never
  // named the session and whose binding was minted by a device-acquisition RESULT
  // instead gets the current connection state, not a stale UUID (issue #5689).
  //
  // This is the entry-gate check for calls arriving at an ALREADY-fenced
  // connection. A session released WHILE a call is actively holding it (the
  // narrow mid-flight-release race) still surfaces the generic ownership-lost
  // error for that UUID via the in-flight fence checks in
  // withRecoverableReconnect — consistent with the established mid-flight-release
  // semantics for every binding — and self-heals: the next call reaches this gate
  // and gets the provenance-aware error.
  private throwIfFencedForCaller(explicitSessionUuid?: string): void {
    this.throwIfPlainRestartSessionLost(explicitSessionUuid);
    const terminal = this.port.state.terminalBoundSession;
    if (!terminal) {
      return;
    }
    // A liveness handover (#10053) is always reported: the harness must be told which sessions
    // and devices it lost and what to do, whichever call reaches the fenced binding first.
    const callerReferencedTerminal =
      !terminal.fromResultMint ||
      this.port.state.stallHandovers.has(terminal.sessionUuid) ||
      (explicitSessionUuid !== undefined && explicitSessionUuid === terminal.sessionUuid);
    // The agent has now been told about this release; later reads go through without a session.
    this.port.state.releaseSurfacedFor = terminal.sessionUuid;
    if (callerReferencedTerminal) {
      const answer = this.boundSessionExpiredError(explicitSessionUuid);
      this.port.noteReleaseSurfacedBy(answer);
      throw answer;
    }
    throw new DaemonConnectionSessionReleasedError(terminal.reason);
  }

  /**
   * A `setToolEnabled` that reaffirms THIS connection's profile keeps that
   * profile as its routing session, but the daemon would otherwise seed the
   * loopback it lands on with the profile as a DEVICE binding, so the update's
   * readback enumerated labels from the profile (none) instead of from the
   * device session this connection acquired. Carry the acquired device route
   * separately so the daemon seeds the loopback with it (#7005). A profile
   * update on a connection with no live device carries nothing extra.
   */
  private withAcquiredDeviceRoute(args: Record<string, unknown>): Record<string, unknown> {
    const explicitSessionUuid = this.sessionUuidFromArgs(args);
    if (
      !explicitSessionUuid ||
      explicitSessionUuid !== this.port.toolSelectionProfileUuid() ||
      !this.port.state.boundSessionUuid ||
      this.port.state.boundSessionUuid === explicitSessionUuid ||
      this.port.state.terminalBoundSession ||
      this.isBoundSessionReplayExpired()
    ) {
      return args;
    }
    return { ...args, [DAEMON_BOUND_SESSION_PARAM]: this.port.state.boundSessionUuid };
  }

  isBoundSessionReplayExpired(): boolean {
    if (
      this.port.state.initialSessionBindingConfigured ||
      this.port.state.boundSessionUuid === undefined ||
      this.port.state.boundSessionUuidAt === undefined ||
      // A call still running on the binding is use: the idle window counts from when it ends.
      this.port.hasSessionCallInFlight(this.port.state.boundSessionUuid)
    ) {
      return false;
    }
    return (
      this.port.timer.now() - this.port.state.boundSessionUuidAt >=
        this.port.boundSessionReplayTtlMs() &&
      !this.daemonKeepsSessionInUse(this.port.state.boundSessionUuid)
    );
  }

  /**
   * The daemon is authoritative for idle release (#10823, #10972): the proxy's own idle clock (its
   * environment, its call bookkeeping) only stands in for a daemon that reports nothing. Once the
   * daemon has reported null, idleness never retires it locally. Once it reports an instant,
   * the local window never retires the session on its
   * own. It is kept:
   * - while liveness recovery runs for it: a missed ack is not evidence of idleness;
   * - while the reported instant is in the future, however long ago the last ack arrived;
   * - while the report predates its instant: a tool call since then (inside the daemon's grace)
   *   may have moved it, so only a heartbeat answered at or after the instant proves it passed.
   * A not-found answer or a release notification ends the session through their own paths.
   */
  daemonKeepsSessionInUse(sessionUuid: string): boolean {
    if (this.port.livenessRecovery.isRecovering(sessionUuid)) {
      return true;
    }
    const report = this.port.state.daemonIdleReports.get(sessionUuid);
    if (report === undefined) {
      return false;
    }
    return (
      report.releaseAt === null ||
      this.port.timer.now() < report.releaseAt ||
      report.reportedAt < report.releaseAt
    );
  }

  /**
   * The one place this proxy retires its own idle binding, called by
   * withFencedControlDeviceSession, throwIfBoundSessionUnavailable,
   * discoveryAfterResultMintRelease and retireIdleLatestBinding.
   *
   * A daemon idle report still held here means isBoundSessionReplayExpired saw a heartbeat
   * answered at or after the daemon's reported idle instant. This is the session's idle end,
   * named with the reason the daemon records for it. Without a report, the proxy's own clock
   * judged the binding idle, so its reason is proxy-local. Read the reason before fencing:
   * fenceBoundSessionUuid forgets the report through forgetSessionLivenessState.
   *
   * A one-shot CLI's cli-idle-timeout report cannot reach here: adoptCliSessionLiveness stops
   * and drains the keeper, sends the CLI declaration without recording its acknowledgement
   * through noteDaemonIdleEvidence, then the CLI closes without another tool call.
   */
  retireIdleBinding(sessionUuid: string): void {
    this.fenceBoundSessionUuid(sessionUuid, this.idleSessionReleaseReason(sessionUuid));
  }

  idleSessionReleaseReason(sessionUuid: string): string {
    return this.port.state.daemonIdleReports.has(sessionUuid)
      ? IDLE_WINDOW_RELEASE_REASON
      : REPLAY_LEASE_EXPIRED_REASON;
  }

  fenceBoundSessionUuid(
    sessionUuid: string,
    reason: string,
    release?: SessionReleaseSnapshot,
  ): void {
    const handedOver = reason === DAEMON_STALLED_CODE || reason === PROXY_STALLED_CODE;
    this.port.dropHeldSession(sessionUuid, handedOver);
    this.port.forgetSessionLivenessState(sessionUuid, handedOver);
    if (this.port.state.terminalBoundSession) {
      if (this.port.state.terminalBoundSession.sessionUuid === sessionUuid) {
        if (reason !== "released") {
          this.port.state.terminalBoundSession.reason = reason;
        }
        this.port.state.terminalBoundSession.release =
          release ?? this.port.state.terminalBoundSession.release;
      }
      return;
    }
    // A surfaced release belongs to this fence alone, even when a later fence reuses its UUID.
    this.port.state.releaseSurfacedFor = undefined;
    this.port.state.terminalBoundSession = {
      sessionUuid,
      reason,
      fromResultMint: this.port.state.boundSessionFromResultMint,
      ...(release ? { release } : {}),
    };
    // A terminal release changes the scope of in-flight discovery and prevents
    // its stale response from repopulating a cleared cache.
    this.port.bumpDiscoveryEpoch();
    this.port.invalidateCache();
    this.port.clearBoundSessionUuid();
    // Other held sessions keep depending on this keeper after the latest binding
    // is fenced, so it only stops once nothing is left to heartbeat (#9335).
    this.port.keeper.syncHeartbeatKeeper();
    // A result-minted binding scoped the tool list the client last fetched; the
    // connection is now unbound, so prompt a re-list (binding does the same).
    // A declared binding's discovery keeps failing, so there is nothing to refresh.
    if (this.port.state.terminalBoundSession.fromResultMint) {
      this.port.notifyListChanged("tools");
    }
  }

  /**
   * Entry gate for tools/list, resources/list and resources/templates/list.
   * Returns true when the only fence is a RESULT-MINTED session that was
   * released: the connection is then unbound and recovers in-band through
   * getAndroid/getApple, so discovery must keep working and list the surface that
   * contains those tools (#9997). A client-declared binding cannot recover on its
   * transport, so its fence still raises the ownership-lost error (#5689).
   */
  discoveryAfterResultMintRelease(): boolean {
    if (!this.port.state.terminalBoundSession && this.isBoundSessionReplayExpired()) {
      this.retireIdleBinding(this.port.state.boundSessionUuid!);
    }
    const terminal = this.port.state.terminalBoundSession;
    if (!terminal) {
      return false;
    }
    if (!terminal.fromResultMint) {
      throw this.boundSessionExpiredError();
    }
    return true;
  }

  /**
   * Refuse an operation because the latest binding is fenced. A fence is that session's alone
   * (#11570): an operation naming another session this proxy still owns goes on, as it would
   * had the fence been there when the operation started ({@link canUseSurvivingSession}), instead
   * of being refused under the fenced session's reason because the fence landed while it waited
   * for the connection.
   */
  throwIfBoundSessionFenced(allowReleasedSession = false, namedSessionUuid?: string): void {
    if (!allowReleasedSession) {
      this.throwIfPlainRestartSessionLost(namedSessionUuid);
    }
    if (
      this.port.state.terminalBoundSession &&
      !allowReleasedSession &&
      !(
        namedSessionUuid !== undefined &&
        this.canUseSurvivingSession({ sessionUuid: namedSessionUuid }, false)
      )
    ) {
      throw this.boundSessionExpiredError(namedSessionUuid);
    }
  }

  /**
   * The ownership-lost error for the fenced binding. `namedSessionUuid` is the session the failing
   * call referenced: when it is not the fenced binding (this proxy fences only its latest one) the
   * error reports the named session, never the unrelated latest binding (#10991).
   */
  boundSessionExpiredError(namedSessionUuid?: string): DaemonBoundSessionExpiredError {
    const terminal = this.port.state.terminalBoundSession;
    if (!terminal) {
      throw new Error("Bound session is not terminal");
    }
    if (namedSessionUuid !== undefined && namedSessionUuid !== terminal.sessionUuid) {
      const namedStall = this.port.state.stallHandovers.get(namedSessionUuid);
      if (namedStall) {
        namedStall.delivered = true;
        return new DaemonSessionStalledError(
          namedSessionUuid,
          this.port.currentHandover(namedSessionUuid, namedStall),
        );
      }
      if (!this.port.state.stallHandovers.has(terminal.sessionUuid)) {
        return new DaemonBoundSessionExpiredError(
          namedSessionUuid,
          this.port.releaseLedger.releasedSessionReasons.get(namedSessionUuid) ?? terminal.reason,
        );
      }
    }
    const stall = this.port.state.stallHandovers.get(terminal.sessionUuid);
    if (stall) {
      stall.delivered = true;
      return new DaemonSessionStalledError(
        terminal.sessionUuid,
        this.port.currentHandover(terminal.sessionUuid, stall),
      );
    }
    return new DaemonBoundSessionExpiredError(
      terminal.sessionUuid,
      terminal.reason,
      terminal.release,
    );
  }

  reportToolSessionLoss(name: string, args: Record<string, unknown>): void {
    if (this.port.state.pendingSessionLosses.size === 0) {
      return;
    }
    const sessionless =
      this.port.isDeviceSessionAcquisitionTool(name) ||
      this.port.isDeviceInventoryTool(name) ||
      name === SET_TOOL_ENABLED_TOOL_NAME;
    const usesDeviceSelector =
      this.port.toolTargetsDevice(name) &&
      this.hasImplicitDeviceSelector(args, name === "setActiveDevice");
    this.reportPendingSessionLoss(
      args,
      !sessionless && !this.canUseSurvivingSession(args, usesDeviceSelector, name),
    );
  }

  reportPendingSessionLoss(args: Record<string, unknown>, terminalRouted = true): void {
    const sessionUuid =
      this.sessionUuidFromArgs(args) ??
      (terminalRouted ? this.port.state.terminalBoundSession?.sessionUuid : undefined);
    const loss = sessionUuid ? this.port.state.pendingSessionLosses.get(sessionUuid) : undefined;
    if (sessionUuid && loss) {
      this.port.state.pendingSessionLosses.delete(sessionUuid);
      const answer = new DaemonSessionStalledError(sessionUuid, loss);
      // The stall-loss answer tells the caller its session is gone, like any terminal refusal.
      this.port.noteReleaseSurfacedBy(answer);
      throw answer;
    }
  }

  forwardedSessionReleaseReasonSince(
    forwardedArgs: Record<string, unknown>,
    forwardEpoch: number,
  ): string | undefined {
    const forwardedUuid = this.sessionUuidFromArgs(forwardedArgs);
    if (!forwardedUuid) {
      return undefined;
    }
    return this.port.releaseLedger.sessionReleaseReasonSince(forwardedUuid, forwardEpoch);
  }

  throwIfSessionReleasedSince(sessionUuid: string, forwardEpoch: number): void {
    const releaseReason = this.port.releaseLedger.sessionReleaseReasonSince(
      sessionUuid,
      forwardEpoch,
    );
    if (releaseReason) {
      throw new DaemonBoundSessionExpiredError(sessionUuid, releaseReason);
    }
  }

  fenceReleasedForwardedSession(forwardedArgs: Record<string, unknown>, reason: string): void {
    const forwardedUuid = this.sessionUuidFromArgs(forwardedArgs) ?? "";
    if (
      forwardedUuid.length > 0 &&
      (!this.port.state.boundSessionUuid || this.port.state.boundSessionUuid === forwardedUuid)
    ) {
      this.fenceBoundSessionUuid(forwardedUuid, reason);
    }
  }

  throwIfForwardedSessionReleasedSince(
    forwardedArgs: Record<string, unknown>,
    forwardEpoch: number,
  ): void {
    const reason = this.forwardedSessionReleaseReasonSince(forwardedArgs, forwardEpoch);
    if (!reason) {
      return;
    }
    const forwardedUuid = this.sessionUuidFromArgs(forwardedArgs)!;
    this.fenceReleasedForwardedSession(forwardedArgs, reason);
    if (this.port.state.terminalBoundSession?.sessionUuid === forwardedUuid) {
      throw this.boundSessionExpiredError();
    }
    throw new DaemonBoundSessionExpiredError(forwardedUuid, reason);
  }

  // Route a session-scoped observation read to the session named in its URI when
  // this connection owns that session but has since bound a newer one (e.g.
  // getApple after getAndroid). Forwarding the URI's session — not the latest
  // binding — makes the daemon seed the loopback SessionToolBinding with the
  // owning session, so the just-established owner is authorized instead of denied
  // with SCREENSHOT_ACCESS_DENIED (issue #5663). Returns undefined for any other
  // URI, a foreign/unowned session (which must keep forwarding this connection's
  // own binding and stay denied), or the current binding (already handled by
  // withBoundSessionUuid). A terminally fenced connection can still forward to a
  // different live owned session through canUseSurvivingSession, including its
  // still-owned configured initial session after a later binding is released.
  freshScreenshotOwnerForwardParams(uri: string): Record<string, unknown> | undefined {
    const uriSessionUuid = sessionScopedObservationUriSessionUuid(uri);
    if (
      !uriSessionUuid ||
      uriSessionUuid === this.port.state.boundSessionUuid ||
      !this.port.ownedDeviceSessions.has(uriSessionUuid)
    ) {
      return undefined;
    }
    const configuredInitialSessionUuid = this.port.initialSessionUuid()?.trim();
    const isLiveConfiguredInitialSession =
      uriSessionUuid === configuredInitialSessionUuid &&
      uriSessionUuid !== this.port.state.terminalBoundSession?.sessionUuid;
    if (
      this.port.state.terminalBoundSession &&
      !this.canUseSurvivingSession({ sessionUuid: uriSessionUuid }, false) &&
      !isLiveConfiguredInitialSession
    ) {
      return undefined;
    }
    return {
      sessionUuid: uriSessionUuid,
      [DAEMON_BOUND_SESSION_PARAM]: uriSessionUuid,
    };
  }

  throwIfResourceSessionHandedOver(uri: string): void {
    if (!this.port.transportLive()) {
      this.throwIfLivenessHandedOver();
    }
    if (isToolOutputResourceUri(uri)) {
      return;
    }
    const sessionUuid =
      sessionScopedObservationUriSessionUuid(uri) ??
      this.port.state.boundSessionUuid ??
      this.port.state.terminalBoundSession?.sessionUuid;
    const record = sessionUuid ? this.port.state.stallHandovers.get(sessionUuid) : undefined;
    if (sessionUuid && record) {
      throw new DaemonSessionStalledError(
        sessionUuid,
        this.port.currentHandover(sessionUuid, record),
      );
    }
  }

  /**
   * Whether a resource read is forwarded with no session. A tool-output artifact always is. The
   * rest is the resource form of {@link isSessionlessReadAfterRelease} (#11483): once the binding is
   * released and one call has been told so, a read of a resource that names no session (the
   * booted-device inventory, anything `resources/list` still lists while unbound) is forwarded
   * without one, as `listDevices` and `observe {deviceId}` are. A URI that names a session, in
   * any session-scoped resource family, is never read without one: it keeps its own routing and,
   * for the released session, the typed terminal answer (its data is gone with it, apart from the
   * fresh screenshot). A liveness handover is reported until the harness acts on it.
   */
  isSessionlessResourceRead(uri: string): boolean {
    if (isToolOutputResourceUri(uri)) {
      // Session-independent at any time, fenced or not (#5917).
      return true;
    }
    const terminal = this.port.state.terminalBoundSession;
    return (
      terminal !== undefined &&
      this.port.state.releaseSurfacedFor === terminal.sessionUuid &&
      !this.port.state.stallHandovers.has(terminal.sessionUuid) &&
      !resourceUriNamesSession(uri)
    );
  }
}
