import type { Timer } from "../../utils/SystemTimer";
import type { ListChangedKind } from "../../server/listChangedBroadcast";
import {
  declaresDeviceSessionInvalid,
  getDeviceSessionIdFromResult,
  getDevicePlatformFromResult,
  getDeviceIdFromResult,
  isDeviceSessionAcquisitionTool,
} from "../../server/deviceSessionResult";
import {
  foreignOwnedSessionUuidFromResult,
  routedSessionUuidFromResult,
} from "../../server/routedSessionMeta";
import { SET_TOOL_ENABLED_TOOL_NAME } from "../../features/toolSelection/toolSelectionControl";
import { isDeviceInventoryTool } from "../daemonMcpProxy";
import type { SessionReleaseSnapshot } from "../sessionManager";
import { DaemonBoundSessionExpiredError } from "./daemonErrors";
import type { ProxySessionState } from "./ProxySessionState";

/**
 * Proxy operations shared with routing, release handling and heartbeat ownership:
 * - startBoundSessionHeartbeat, stopBoundSessionHeartbeat and establishBoundSessionHeartbeat share keeper lifecycle.
 * - forwardedSessionReleaseReasonSince, sessionReleaseReasonSince and throwIfSessionReleasedSince share release evidence.
 * - fenceReleasedForwardedSession shares terminal release policy.
 * - invalidateListCache and notifyListChanged share client list publication.
 * - holdPreviousBinding and clearHeldSessionLossesForSelection share held-session selection.
 * - syncHeartbeatKeeper shares keeper reconciliation after an interrupted rebind.
 * - isHeartbeatKeeperStarted reads the live mutable keeper flag.
 * - failureNeverReachedLiveSession and toolAcceptsSessionUuid retain admission and routing policy.
 */
export interface SessionBindingPort {
  startBoundSessionHeartbeat(): void;
  forwardedSessionReleaseReasonSince(
    forwardedArgs: Record<string, unknown>,
    forwardEpoch: number,
  ): string | undefined;
  fenceReleasedForwardedSession(forwardedArgs: Record<string, unknown>, reason: string): void;
  throwIfSessionReleasedSince(sessionUuid: string, forwardEpoch: number): void;
  sessionReleaseReasonSince(sessionUuid: string, forwardEpoch: number): string | undefined;
  invalidateListCache(kind: ListChangedKind): void;
  notifyListChanged(kind: ListChangedKind): void;
  holdPreviousBinding(nextSessionUuid: string): void;
  clearHeldSessionLossesForSelection(sessionUuid: string, callPlatform?: unknown): void;
  syncHeartbeatKeeper(): void;
  stopBoundSessionHeartbeat(): Promise<boolean>;
  establishBoundSessionHeartbeat(): Promise<void>;
  failureNeverReachedLiveSession(error: unknown): boolean;
  toolAcceptsSessionUuid(name: string): boolean;
  isHeartbeatKeeperStarted(): boolean;
}

export interface SessionBindingDependencies {
  timer: Timer;
  state: ProxySessionState;
  ownedDeviceSessions: Set<string>;
  sessionPlatforms: Map<string, "android" | "ios">;
  sessionDeviceIds: Map<string, string>;
  sessionBrokerSessions: ReadonlyMap<string, string>;
  plainRestartSessionLosses: Map<string, string>;
  pendingHeldSessionPlatformLosses: Map<
    string,
    {
      platform: "android" | "ios";
      reason: string;
      release?: SessionReleaseSnapshot;
      proxyJudged?: true;
    }
  >;
  initialSessionUuid: () => string | undefined;
  port: SessionBindingPort;
}

export function sessionUuidFromArgs(args: Record<string, unknown>): string | undefined {
  return typeof args.sessionUuid === "string" && args.sessionUuid.trim().length > 0
    ? args.sessionUuid.trim()
    : undefined;
}

/** Learn which device a session runs on so a liveness handover can name it (#10053). */
export function rememberSessionDeviceId(
  sessionDeviceIds: Map<string, string>,
  sessionUuid: string,
  deviceId: unknown,
): void {
  if (typeof deviceId === "string" && deviceId.trim().length > 0) {
    sessionDeviceIds.set(sessionUuid, deviceId);
  }
}

export class SessionBinding {
  constructor(private readonly deps: SessionBindingDependencies) {}

  // Bind and heartbeat the device session an acquisition call
  // minted in its RESULT — the proxy equivalent of the direct-path bind in
  // src/server/index.ts. Without this the daemon never sees an ownership heartbeat
  // for a result-minted session and reaps it under the pre-first-heartbeat grace
  // (issue #5689). Acquisition also clears any terminal fence: the connection is
  // usable again once a fresh session is established (AC2).
  async bindResultMintedDeviceSession(
    name: string,
    result: unknown,
    acquisitionReleaseEpoch: number,
  ): Promise<void> {
    if (!isDeviceSessionAcquisitionTool(name)) {
      return;
    }
    const mintedSessionUuid = getDeviceSessionIdFromResult(result);
    if (!mintedSessionUuid) {
      return;
    }
    if (mintedSessionUuid !== this.deps.state.boundSessionUuid) {
      this.deps.port.throwIfSessionReleasedSince(mintedSessionUuid, acquisitionReleaseEpoch);
    }
    const platform = getDevicePlatformFromResult(result);
    if (mintedSessionUuid === this.deps.state.boundSessionUuid) {
      if (platform) {
        this.deps.sessionPlatforms.set(mintedSessionUuid, platform);
      }
      this.deps.port.clearHeldSessionLossesForSelection(mintedSessionUuid);
      return;
    }
    rememberSessionDeviceId(
      this.deps.sessionDeviceIds,
      mintedSessionUuid,
      getDeviceIdFromResult(result),
    );
    // A prior binding's keeper must not outlive the rebind to a fresh session.
    // (A terminal fence already stopped it; this covers re-acquiring over a live
    // binding.)
    if (this.deps.port.isHeartbeatKeeperStarted()) {
      await this.deps.port.stopBoundSessionHeartbeat();
    }
    // Stopping the previous binding's keeper may yield. Recheck before publishing
    // the new binding so a release delivered during that await cannot be missed.
    const releasedWhileStopping = this.deps.port.sessionReleaseReasonSince(
      mintedSessionUuid,
      acquisitionReleaseEpoch,
    );
    if (releasedWhileStopping) {
      // The keeper was stopped for a binding that is never published: the sessions this proxy
      // still holds keep their heartbeats (#11411).
      this.deps.port.syncHeartbeatKeeper();
      throw new DaemonBoundSessionExpiredError(mintedSessionUuid, releasedWhileStopping);
    }
    if (platform) {
      this.deps.sessionPlatforms.set(mintedSessionUuid, platform);
    }
    this.deps.port.clearHeldSessionLossesForSelection(mintedSessionUuid);
    this.deps.state.terminalBoundSession = undefined;
    this.deps.port.holdPreviousBinding(mintedSessionUuid);
    this.deps.state.boundSessionUuid = mintedSessionUuid;
    this.deps.state.boundSessionUuidAt = this.deps.timer.now();
    this.deps.ownedDeviceSessions.add(mintedSessionUuid);
    this.deps.state.claimableSessions.add(mintedSessionUuid);
    this.deps.state.boundSessionFromResultMint = true;
    this.deps.state.initialSessionBindingConfigured = false;
    this.deps.state.livenessOwnershipClaimSent = false;
    // `tools/list` is forwarded under the bound session, so the binding just
    // published invalidates every cached definition fetched under the previous
    // scope. Drop it BEFORE the awaited heartbeat: the daemon's own
    // `tools/list_changed` for an `enableTools` grant is relayed while this
    // acquisition is still in flight, so a client that re-listed on it cached a
    // list scoped to the OLD binding and nothing else would clear it
    // (#6886 review).
    this.deps.port.invalidateListCache("tools");
    // `resources/list` and `resources/templates/list` are forwarded under the
    // bound session too, so a list cached under the previous scope (an unbound
    // list, or the prior binding's) must not be served for the new session.
    this.deps.port.invalidateListCache("resources");
    // Deliver the first ownership heartbeat as part of the acquisition so the
    // daemon records ownership before the pre-first-heartbeat grace fires
    // (mirrors the establishment guarantee in issue #5637).
    await this.deps.port.establishBoundSessionHeartbeat();
    // Prompt the client to re-fetch only once the daemon has recorded ownership
    // of the new session, so the re-list it triggers is already routable.
    this.deps.port.notifyListChanged("tools");
    // The first heartbeat is an awaited daemon round-trip. A shutdown release
    // can arrive while it is in flight, fence and clear the binding, and make
    // this acquisition result stale before it reaches the caller.
    this.deps.port.throwIfSessionReleasedSince(mintedSessionUuid, acquisitionReleaseEpoch);
  }

  // Called with the FORWARDED args (post-withBoundSessionUuid), so an implicit
  // sessionless call that had the bound UUID injected refreshes the replay lease
  // just like an explicit-sessionUuid call, matching the daemon session it just
  // extended (issue #4610).
  // `selectsDefault` is a setActiveDevice selection: with an acquisition result (bound by
  // bindResultMintedDeviceSession) it is the only thing that moves an existing binding (#11347).
  rememberSessionUuid(
    name: string,
    forwardedArgs: Record<string, unknown>,
    callReleaseEpoch: number,
    selectsDefault: boolean,
  ): void {
    if (name === "executePlan") {
      // The daemon owns plan-session release. Preserve the binding until its
      // release notification fences this transport, or, when that notification is
      // missed, the not-found heartbeat naming `plan-auto-release` does
      // (releaseKeepsBinding classifies both alike).
      return;
    }
    if (name === SET_TOOL_ENABLED_TOOL_NAME) {
      return;
    }
    if (isDeviceInventoryTool(name)) {
      // Inventory observation must not bind or heartbeat a session it does not own.
      return;
    }
    // A release for the FORWARDED UUID observed WHILE this call was in flight
    // already recorded that UUID's release (handleDaemonNotification).
    // Re-remembering it now would resurrect the freed session and let the next
    // sessionless call recreate it (issue #4611). Scoped to the forwarded UUID so
    // an unrelated session's mid-call release does NOT block this remember (issue
    // #4655); a later explicit call re-binds normally.
    const releaseReason = this.deps.port.forwardedSessionReleaseReasonSince(
      forwardedArgs,
      callReleaseEpoch,
    );
    if (releaseReason) {
      this.deps.port.fenceReleasedForwardedSession(forwardedArgs, releaseReason);
      return;
    }
    const rememberedSessionUuid = sessionUuidFromArgs(forwardedArgs);
    if (
      rememberedSessionUuid &&
      (rememberedSessionUuid === this.deps.state.boundSessionUuid ||
        this.deps.port.toolAcceptsSessionUuid(name))
    ) {
      rememberSessionDeviceId(
        this.deps.sessionDeviceIds,
        rememberedSessionUuid,
        forwardedArgs.deviceId,
      );
      this.bindRememberedSession(rememberedSessionUuid, selectsDefault);
    }
  }

  /** A remembered session preserves a released binding until an explicit selection replaces it. */
  private bindRememberedSession(sessionUuid: string, selectsDefault: boolean): void {
    if (this.deps.state.terminalBoundSession) {
      if (!selectsDefault) {
        // The binding was released and the agent has not chosen another (#11656): a call naming
        // a session this proxy still holds ran on it and changes nothing else. The fence stays,
        // so the release is reported to the next sessionless control call, in whatever order the
        // release and this call's completion arrived, and nothing sessionless reaches a sibling.
        return;
      }
      if (
        sessionUuid !== this.deps.state.terminalBoundSession.sessionUuid &&
        this.deps.ownedDeviceSessions.has(sessionUuid)
      ) {
        // setActiveDevice chose a session this proxy still holds: that is the new binding.
        this.deps.state.terminalBoundSession = undefined;
      }
    }
    if (this.keepsBindingFor(sessionUuid, selectsDefault)) {
      return;
    }
    this.updateBoundSessionUuid(sessionUuid);
    this.deps.port.startBoundSessionHeartbeat();
  }

  /**
   * An explicit `sessionUuid` other than the connection's binding targets that one call (#11347):
   * the binding, and with it every later sessionless call, stays where setActiveDevice or an
   * acquisition put it. A connection that never had a binding still adopts the first session it
   * names; one whose binding was released does not (the fence in {@link rememberSessionUuid}
   * answers first), so a named call never moves a binding nor replaces a released one (#11656).
   */
  private keepsBindingFor(sessionUuid: string, selectsDefault: boolean): boolean {
    if (this.keepsStartupBindingFor(sessionUuid)) {
      return true;
    }
    return (
      !selectsDefault &&
      this.deps.state.boundSessionUuid !== undefined &&
      sessionUuid !== this.deps.state.boundSessionUuid
    );
  }

  /**
   * A call on another session this proxy holds under its token does not move a startup binding:
   * that binding stays authoritative for sessionless calls, and the held session keeps being
   * heartbeated with its idle clock restarted when the call ended (#10990).
   */
  private keepsStartupBindingFor(sessionUuid: string): boolean {
    return (
      this.deps.state.initialSessionBindingConfigured &&
      sessionUuid !== this.deps.state.boundSessionUuid &&
      this.deps.state.otherHeldSessions.has(sessionUuid)
    );
  }

  /**
   * Whether `sessionUuid` was minted by an acquisition RESULT on this proxy, as opposed to
   * declared at startup (`--initial-session-uuid`) or only named by a caller.
   * Provenance belongs to the session, not to how the binding last reached it (#11483): a
   * connection that minted the session recovers in-band however the agent addressed it since.
   * A session resumed under this proxy's stable owner token (#10990) counts: the same owner
   * acquired it before a restart. A startup binding is never displaced by one, so the declared
   * fence is not loosened.
   */
  private wasMintedThroughThisProxy(sessionUuid: string): boolean {
    return (
      this.deps.state.claimableSessions.has(sessionUuid) &&
      sessionUuid !== this.deps.initialSessionUuid()?.trim() &&
      !this.deps.sessionBrokerSessions.has(sessionUuid)
    );
  }

  // Bind `sessionUuid`, refreshing the replay lease. A change to a different UUID
  // takes that session's provenance: client-declared when the UUID is known only
  // from a call's args, result-minted when this proxy minted it earlier and the
  // binding is returning to it (setActiveDevice, or naming it once the latest
  // binding is gone). A sessionless refresh re-binds the same UUID and preserves
  // its provenance (issue #5689).
  private updateBoundSessionUuid(sessionUuid: string): void {
    this.deps.pendingHeldSessionPlatformLosses.delete(sessionUuid);
    this.deps.plainRestartSessionLosses.delete(sessionUuid);
    // A held session that becomes the binding again keeps its idle clock: the call that named it
    // may be a read, and the daemon's echo already credited it when it was use (#11348).
    const heldLastUsedAt = this.deps.state.otherHeldSessions.get(sessionUuid)?.lastUsedAt;
    if (sessionUuid !== this.deps.state.boundSessionUuid) {
      this.deps.port.holdPreviousBinding(sessionUuid);
      this.deps.state.boundSessionFromResultMint = this.wasMintedThroughThisProxy(sessionUuid);
      this.deps.state.livenessOwnershipClaimSent = false;
    }
    // Re-binding the session that is already bound is not use: a read naming it must not restart
    // the idle clock (#10964, #11348); the daemon's echo credits control calls.
    const rebindsSameSession =
      sessionUuid === this.deps.state.boundSessionUuid &&
      this.deps.state.boundSessionUuidAt !== undefined;
    this.deps.state.boundSessionUuid = sessionUuid;
    if (!rebindsSameSession) {
      this.deps.state.boundSessionUuidAt = heldLastUsedAt ?? this.deps.timer.now();
    }
    this.deps.ownedDeviceSessions.add(sessionUuid);
    // A call reached the session, so the daemon may know it again: heartbeat it (#10702). Its
    // window stays: this call proves nothing about the session (a read restores none), so the
    // next not-found answer is decided inside the same window, never a new one (#11570).
    this.deps.state.notFoundStopped.delete(sessionUuid);
  }

  // Refresh the replay lease for a call that was ADMITTED and forwarded to the
  // daemon handler but then REJECTED. getOrCreateSession() already refreshed the
  // live daemon session before the handler ran, so the proxy lease must track
  // that liveness even on failure — otherwise repeated admitted-but-failed calls
  // retire a still-live session and a reconnect seeds an unbound transport
  // (issue #4610). Excluded, because none of them refreshed a live session:
  //   - executePlan owns its own binding lifecycle via the release signal; leave
  //     it untouched so a pre-handler plan rejection does not strand the binding.
  //   - inventory tools are observation-only and their read-only admission did not
  //     acquire or refresh the forwarded session.
  //   - a recoverable error (DaemonUnavailableError transport/connect failure,
  //     "Session not found", or an unknown-tool build-skew), or a device-control
  //     connect-phase failure never reached the handler with a live session; a
  //     response failure with sessionValid=false confirms the session is stale.
  //     Neither may refresh or establish the replay lease.
  refreshReplayLeaseAfterAdmittedFailure(
    name: string,
    forwardedArgs: Record<string, unknown>,
    error: unknown,
    callReleaseEpoch: number,
  ): void {
    if (
      name === "executePlan" ||
      name === "setActiveDevice" ||
      name === SET_TOOL_ENABLED_TOOL_NAME ||
      isDeviceInventoryTool(name) ||
      this.deps.port.failureNeverReachedLiveSession(error)
    ) {
      return;
    }
    // As in rememberSessionUuid: a release of the forwarded UUID observed
    // mid-flight already recorded it, so an admitted-then-rejected call must not
    // re-refresh the released UUID's lease (issue #4611/#4655). The session is
    // gone; resurrecting the lease would replay it on the next sessionless call.
    const releaseReason = this.deps.port.forwardedSessionReleaseReasonSince(
      forwardedArgs,
      callReleaseEpoch,
    );
    if (releaseReason) {
      this.deps.port.fenceReleasedForwardedSession(forwardedArgs, releaseReason);
      return;
    }
    // A thrown failure carries no routed-session echo, so it proves nothing about whose session
    // the call named: it refreshes the lease of the session already bound and never establishes
    // or switches a binding (#11344). Otherwise one rejected call naming another connection's
    // session would send this connection's later sessionless calls to that session's device.
    const admittedSessionUuid = sessionUuidFromArgs(forwardedArgs);
    if (
      this.deps.state.terminalBoundSession !== undefined ||
      (admittedSessionUuid !== undefined &&
        this.deps.state.otherHeldSessions.has(admittedSessionUuid))
    ) {
      // A rejection never switches the binding, as on the error-result path
      // (bindForwardedSessionOnErrorResult): under a terminal fence the rebound session would
      // not be heartbeated, and a held session is heartbeated where it is (#11411).
      return;
    }
    if (admittedSessionUuid && admittedSessionUuid === this.deps.state.boundSessionUuid) {
      this.updateBoundSessionUuid(admittedSessionUuid);
      this.deps.port.startBoundSessionHeartbeat();
    }
  }

  /**
   * Own the forwarded device session behind an `isError: true` RESULT.
   *
   * A failed interaction tool answers with an ordinary MCP error envelope rather
   * than a rejection, so the handler DID run against the forwarded session and
   * that session is still live — exactly what
   * {@link refreshReplayLeaseAfterAdmittedFailure} assumes on the throwing path.
   * Binding it here too is what lets a `--cli --session-uuid` invocation whose
   * very first call fails still declare the session CLI-owned before exiting;
   * without it the session stayed on the 10 s heartbeat policy and the retry
   * after ordinary think-time got `session_ownership_lost` (issue #6870).
   *
   * An error result may only ESTABLISH a first binding, never SWITCH one, and only
   * when the daemon echoed the forwarded session as the one it admitted the call
   * under (`automobile/routedSessionUuid`, #11344): a call
   * that names some OTHER session and fails leaves the connection on the session
   * it already had, so an unissued UUID cannot steal the binding (issue #2737).
   * executePlan is excluded before checking for a released forwarded session:
   * the daemon owns plan-session release, and its notification fences only an
   * already-bound connection. A failed plan on an unbound connection must leave
   * it unbound, matching rememberSessionUuid on successful results.
   * Three further answers establish nothing:
   *   - a connection already fenced terminally — its session is gone;
   *   - a tool that does not route by device session (`setToolEnabled`,
   *     `setActiveDevice`), only observes inventory, or mints its session in the RESULT
   *     (the acquisition tools, handled above);
   *   - an envelope that declares the named session gone
   *     ({@link declaresDeviceSessionInvalid}) — resurrecting it would heartbeat
   *     a dead session instead of leaving the connection unbound.
   * Refreshing the lease of the ALREADY-bound session keeps its prior behaviour,
   * minus the session-invalid case, which was never a live session to refresh.
   */
  bindForwardedSessionOnErrorResult(
    name: string,
    forwardedArgs: Record<string, unknown>,
    result: unknown,
    callReleaseEpoch: number,
  ): void {
    if (name === "executePlan") {
      return;
    }
    const releaseReason = this.deps.port.forwardedSessionReleaseReasonSince(
      forwardedArgs,
      callReleaseEpoch,
    );
    if (releaseReason) {
      this.deps.port.fenceReleasedForwardedSession(forwardedArgs, releaseReason);
      return;
    }
    const forwardedSessionUuid = sessionUuidFromArgs(forwardedArgs);
    if (
      !forwardedSessionUuid ||
      declaresDeviceSessionInvalid(result) ||
      this.namesForeignOwnedSession(forwardedArgs, result)
    ) {
      return;
    }
    const alreadyBound = forwardedSessionUuid === this.deps.state.boundSessionUuid;
    if (
      !alreadyBound &&
      (this.deps.state.boundSessionUuid !== undefined ||
        this.deps.state.terminalBoundSession !== undefined ||
        !this.mayBindSessionFromErrorResult(name) ||
        // Only the daemon's echo proves the call was admitted under the session it named; a
        // refusal or a prose error establishes nothing (#11344).
        routedSessionUuidFromResult(result) !== forwardedSessionUuid)
    ) {
      return;
    }
    this.updateBoundSessionUuid(forwardedSessionUuid);
    this.deps.port.startBoundSessionHeartbeat();
  }

  /**
   * The daemon reports the session this call named as another connection's autolock (#11235):
   * the call may run on it, but naming it is not ownership, so this connection never binds it
   * and its later sessionless calls keep their own routing.
   */
  namesForeignOwnedSession(forwardedArgs: Record<string, unknown>, result: unknown): boolean {
    const forwardedSessionUuid = sessionUuidFromArgs(forwardedArgs);
    return (
      forwardedSessionUuid !== undefined &&
      foreignOwnedSessionUuidFromResult(result) === forwardedSessionUuid
    );
  }

  private mayBindSessionFromErrorResult(name: string): boolean {
    if (
      name === "executePlan" ||
      name === "setActiveDevice" ||
      name === SET_TOOL_ENABLED_TOOL_NAME ||
      isDeviceInventoryTool(name) ||
      isDeviceSessionAcquisitionTool(name)
    ) {
      return false;
    }
    return this.deps.port.toolAcceptsSessionUuid(name);
  }
}
