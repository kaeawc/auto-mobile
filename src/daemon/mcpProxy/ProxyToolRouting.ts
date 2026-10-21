import {
  SET_TOOL_ENABLED_TOOL_NAME,
  toolSelectionProfileUuidFromResponse,
} from "../../features/toolSelection/toolSelectionControl";
import {
  DAEMON_OWNED_SESSIONS_OWNER_TOKEN_PARAM,
  DAEMON_OWNED_SESSIONS_PARAM,
  DAEMON_TOOL_SELECTION_PROFILE_PARAM,
} from "../constants";
import { anyDeviceReadOnlyArgShapeMatches } from "../deviceReadOnlyArgShapes";
import {
  getActiveDeviceSelectionFromResult,
  isDeviceBindingTool,
  readTerminalSessionRefusal,
} from "../deviceSessionResult";
import { type ListChangedKind } from "../listChangedBroadcast";
import { DaemonBoundSessionExpiredError } from "../proxy/daemonErrors";
import { HeldSessionLosses } from "../proxy/HeldSessionLosses";
import { ackDaemonInstance } from "../proxy/livenessErrorPredicates";
import { rememberSessionDeviceId, sessionUuidFromArgs } from "../proxy/SessionBinding";
import { routedSessionUuidFromResult } from "../routedSessionMeta";
import { type SessionReleaseSnapshot } from "../sessionManager/releaseTypes";
import {
  DEVICE_READ_ONLY_ARGS_META_KEY,
  DEVICE_READ_ONLY_META_KEY,
  isDeviceInventoryTool,
} from "./ProxyContracts";
import type { ProxyRuntime } from "./ProxyRuntime";
/** Operations supplied by the proxy's composition root. */
export interface ProxyToolRoutingPort {
  notifyListChanged(kind: ListChangedKind): void;
  noteSessionRestoredByCall(sessionUuid: string): void;
  clearNotFoundHistory(sessionUuid: string): void;
}

type Runtime = Pick<
  ProxyRuntime,
  | "ackedDaemonInstance"
  | "boundSessionFenceGate"
  | "boundSessionFromResultMint"
  | "boundSessionUuid"
  | "boundSessionUuidAt"
  | "cliSessionLivenessDeclared"
  | "config"
  | "daemonIdleReports"
  | "discovery"
  | "heldSessionLosses"
  | "initialSessionAwaitingFirstCall"
  | "initialSessionBindingConfigured"
  | "latestBindingConflict"
  | "latestBindingKeeper"
  | "livenessOwnerToken"
  | "livenessOwnershipClaimSent"
  | "notFoundWindows"
  | "otherHeldSessions"
  | "ownedDeviceSessions"
  | "pendingHeldSessionPlatformLosses"
  | "recoverableBoundSessionHandoff"
  | "recoverableBoundSessionHandoffIsDeviceRestart"
  | "releaseSurfacedFor"
  | "sessionBinding"
  | "sessionCallsInFlight"
  | "sessionDaemonInstances"
  | "sessionDeviceIds"
  | "staticToolDefinitionsProvider"
  | "terminalBoundSession"
  | "timer"
  | "toolSelectionProfileUuid"
>;

/** ToolRouting operations on a single proxy runtime. */
export class ProxyToolRouting {
  constructor(
    private readonly runtime: Runtime,
    private readonly port: ProxyToolRoutingPort,
  ) {}

  isSessionlessControlDeviceTool(name: string, args?: Record<string, unknown>): boolean {
    return (
      !this.runtime.config.initialSessionUuid &&
      !isDeviceBindingTool(name) &&
      !isDeviceInventoryTool(name) &&
      name !== SET_TOOL_ENABLED_TOOL_NAME &&
      this.toolTargetsDevice(name) &&
      !this.isDeviceReadOnlyTool(name, args)
    );
  }

  withFencedControlDeviceSession(
    name: string,
    args: Record<string, unknown>,
  ): Record<string, unknown> {
    return this.runtime.boundSessionFenceGate.withFencedControlDeviceSession(name, args);
  }

  refuseAmbiguousSessionSelector(name: string, args: Record<string, unknown>): void {
    return this.runtime.boundSessionFenceGate.refuseAmbiguousSessionSelector(name, args);
  }

  prepareToolRoutingArgs(
    name: string,
    callerArgs: Record<string, unknown>,
    isSessionAcquisition: boolean,
  ): {
    forwardedArgs: Record<string, unknown>;
    allowReleasedSession: boolean;
  } {
    return this.runtime.boundSessionFenceGate.prepareToolRoutingArgs(
      name,
      callerArgs,
      isSessionAcquisition,
    );
  }

  /**
   * Record that a tool call's answer named the fenced binding as released (#11483), as the entry
   * gate does: `answer` is a terminal refusal the daemon answered and this proxy relayed, or the
   * fence error raised while the call was in flight. A held session's terminal answer also
   * cancels its pending platform report: the caller has already been told about that loss.
   */
  noteReleaseSurfacedBy(answer: unknown): void {
    const sessionUuid =
      answer instanceof DaemonBoundSessionExpiredError
        ? answer.sessionUuid
        : readTerminalSessionRefusal(answer)?.sessionUuid;
    if (sessionUuid !== undefined) {
      this.runtime.pendingHeldSessionPlatformLosses.delete(sessionUuid);
    }
    if (
      sessionUuid !== undefined &&
      sessionUuid === this.runtime.terminalBoundSession?.sessionUuid
    ) {
      this.runtime.releaseSurfacedFor = sessionUuid;
    }
  }

  // Kept as a named method: the liveness-clock guard follows the keeper's port to it.
  recordHeldSessionTerminalLoss(
    ...args: Parameters<HeldSessionLosses["recordTerminalLoss"]>
  ): void {
    this.runtime.heldSessionLosses.recordTerminalLoss(...args);
  }

  isDeviceReadOnlyTool(name: string, args?: Record<string, unknown>): boolean {
    const definition =
      this.runtime.discovery.tools?.find((tool) => tool.name === name) ??
      this.runtime.staticToolDefinitionsProvider().find((tool) => tool.name === name);
    return (
      definition?._meta?.[DEVICE_READ_ONLY_META_KEY] === true ||
      (args !== undefined &&
        anyDeviceReadOnlyArgShapeMatches(definition?._meta?.[DEVICE_READ_ONLY_ARGS_META_KEY], args))
    );
  }

  toolTargetsDevice(name: string): boolean {
    if (name === "setActiveDevice") {
      return true;
    }
    const schema =
      this.runtime.discovery.tools?.find((definition) => definition.name === name)?.inputSchema ??
      this.runtime.staticToolDefinitionsProvider().find((definition) => definition.name === name)
        ?.inputSchema;
    // Device-targeting schemas expose the device-label contract. Plain
    // platform filters do not have it and must retain their session policy.
    return (
      typeof schema?.properties === "object" &&
      schema.properties !== null &&
      "device" in schema.properties
    );
  }

  /**
   * The caller explicitly named a session this proxy owns. After a reconnect the daemon may still
   * record a stale connection of this proxy as the session's owner, and it refuses a control call
   * naming a session another connection owns (#11344): such a call carries the owned sessions and
   * the owner token, so the daemon restores ownership to this connection first.
   */
  namesOwnedSession(callerArgs: Record<string, unknown>): boolean {
    const named = this.sessionUuidFromArgs(callerArgs);
    return (
      named !== undefined &&
      named !== this.runtime.terminalBoundSession?.sessionUuid &&
      this.runtime.ownedDeviceSessions.has(named)
    );
  }

  withOwnedSessionCapabilities(
    args: Record<string, unknown>,
    restore: boolean,
    namesOwnedSession = false,
    isSessionAcquisition: boolean,
  ): Record<string, unknown> {
    // Acquisition identity is independent of retained-session restoration. CLI callers keep
    // their existing wire, including the owner token when restoration itself requires it.
    const acquisitionIdentity = (): Record<string, unknown> =>
      this.runtime.config.oneShotCli || this.runtime.cliSessionLivenessDeclared
        ? args
        : { ...args, [DAEMON_OWNED_SESSIONS_OWNER_TOKEN_PARAM]: this.runtime.livenessOwnerToken };
    args = acquisitionIdentity();
    if (!namesOwnedSession && (!restore || this.sessionUuidFromArgs(args))) {
      return args;
    }
    const retained = [...this.runtime.ownedDeviceSessions].filter(
      (id) =>
        id !== this.runtime.terminalBoundSession?.sessionUuid &&
        id !== this.runtime.boundSessionUuid,
    );
    const bound = this.restoredBoundSession(isSessionAcquisition);
    if (bound !== undefined) {
      // Restoration uses the first "if-absent" attachment as the fresh socket's
      // default, so the current binding must precede older owned sessions.
      retained.unshift(bound);
    }
    // The owner token lets the daemon move ownership to this connection even while a stale
    // connection of this proxy still holds it; a bare UUID only restores an unowned session (#11107).
    return retained.length
      ? {
          ...args,
          [DAEMON_OWNED_SESSIONS_PARAM]: retained,
          [DAEMON_OWNED_SESSIONS_OWNER_TOKEN_PARAM]: this.runtime.livenessOwnerToken,
        }
      : args;
  }

  /**
   * The live binding a restoring call presents among its owned sessions, if any. Under a
   * recoverable handoff of the binding, these arguments are built before
   * `withRecoverableReconnect` reclaims it on a fresh connection and clears the marker, so they
   * must already say what that reclaimed connection owns:
   * - a daemon shutdown or restart handoff: the successor holds the session rehydrated, awaiting
   *   this owner, and only the restore attaches it to the new connection. Without it the owner's
   *   first selector call after a restart reaches the successor sessionless and is refused on its
   *   own device (#14668). An acquisition keeps its existing wire.
   * - a device-restart handoff: only an acquisition resumes the reserved session.
   */
  private restoredBoundSession(isSessionAcquisition: boolean): string | undefined {
    const bound = this.runtime.boundSessionUuid;
    if (!bound || bound === this.runtime.terminalBoundSession?.sessionUuid) {
      return undefined;
    }
    const presented =
      bound !== this.runtime.recoverableBoundSessionHandoff ||
      this.runtime.recoverableBoundSessionHandoffIsDeviceRestart === isSessionAcquisition;
    return presented ? bound : undefined;
  }

  rememberActiveDeviceSession(
    name: string,
    args: Record<string, unknown>,
    result: unknown,
    releaseEpoch: number,
  ): void {
    if (name !== "setActiveDevice") {
      return;
    }
    const selection = getActiveDeviceSelectionFromResult(result);
    if (selection) {
      this.throwIfSessionReleasedSince(selection.sessionUuid, releaseEpoch);
      this.runtime.sessionBinding.rememberSessionUuid(name, selection, releaseEpoch, true);
      this.runtime.heldSessionLosses.clearForSelection(selection.sessionUuid, args.platform);
    }
  }

  ownSessionForPlatformSelector(
    name: string,
    args: Record<string, unknown>,
    siblingOnly = false,
  ): string | undefined {
    return this.runtime.boundSessionFenceGate.ownSessionForPlatformSelector(
      name,
      args,
      siblingOnly,
    );
  }

  withBoundSessionUuid(
    args: Record<string, unknown>,
    usesDeviceSelector = false,
    toolName?: string,
  ): Record<string, unknown> {
    return this.runtime.boundSessionFenceGate.withBoundSessionUuid(
      args,
      usesDeviceSelector,
      toolName,
    );
  }

  sessionUuidFromArgs(args: Record<string, unknown>): string | undefined {
    return sessionUuidFromArgs(args);
  }

  withToolSelectionProfile(args: Record<string, unknown>): Record<string, unknown> {
    if (!this.runtime.toolSelectionProfileUuid) {
      return args;
    }
    return {
      ...args,
      [DAEMON_TOOL_SELECTION_PROFILE_PARAM]: this.runtime.toolSelectionProfileUuid,
    };
  }

  rememberToolSelectionProfile(
    name: string,
    requestedArgs: Record<string, unknown>,
    result: unknown,
  ): void {
    if (name !== SET_TOOL_ENABLED_TOOL_NAME) {
      return;
    }
    const explicitSessionUuid =
      typeof requestedArgs.sessionUuid === "string" && requestedArgs.sessionUuid.trim().length > 0
        ? requestedArgs.sessionUuid
        : undefined;
    const responseProfileUuid = toolSelectionProfileUuidFromResponse(result);
    if (!explicitSessionUuid) {
      if (responseProfileUuid) {
        this.runtime.toolSelectionProfileUuid = responseProfileUuid;
      }
    } else if (responseProfileUuid === explicitSessionUuid) {
      // toolSelectionProfileUuidFromResponse only returns server-confirmed
      // connection-profile responses. Retain a successful self-reaffirm so
      // withToolSelectionProfile() can attach it to later acquisitions.
      this.runtime.toolSelectionProfileUuid = responseProfileUuid;
    }
    // Do not depend solely on the daemon's best-effort list_changed delivery.
    // The successful update has already changed the authoritative tool surface.
    this.port.notifyListChanged("tools");
  }

  isBoundSessionReplayExpired(): boolean {
    return this.runtime.boundSessionFenceGate.isBoundSessionReplayExpired();
  }

  /** Record reported heartbeat evidence only while tracking the session; absence proves nothing. */
  noteHeartbeatDaemonInstance(sessionUuid: string, daemonInstance: string | undefined): boolean {
    if (
      daemonInstance === undefined ||
      !this.runtime.latestBindingKeeper.isHeldSession(sessionUuid)
    ) {
      return false;
    }
    const previousInstance = this.runtime.sessionDaemonInstances.get(sessionUuid);
    this.runtime.sessionDaemonInstances.set(sessionUuid, daemonInstance);
    return previousInstance !== undefined && previousInstance !== daemonInstance;
  }

  /** Keep the daemon's idle deadline or explicit exemption; absence alone permits fallback. */
  noteDaemonIdleEvidence(sessionUuid: string, ack: unknown): void {
    // An ack can arrive after a held session was dropped. End its retained history without
    // creating process evidence for a session that is no longer heartbeated.
    if (!this.runtime.latestBindingKeeper.isHeldSession(sessionUuid)) {
      this.runtime.notFoundWindows.delete(sessionUuid);
      this.runtime.sessionDaemonInstances.delete(sessionUuid);
    }
    const daemonInstance = ackDaemonInstance(ack);
    if (daemonInstance !== undefined) {
      this.runtime.ackedDaemonInstance = daemonInstance;
      this.noteHeartbeatDaemonInstance(sessionUuid, daemonInstance);
    }
    const releaseAt = (ack as { idleReleaseAt?: unknown } | null | undefined)?.idleReleaseAt;
    if (releaseAt === null || (typeof releaseAt === "number" && Number.isFinite(releaseAt))) {
      this.runtime.daemonIdleReports.set(sessionUuid, {
        releaseAt,
        reportedAt: this.runtime.timer.now(),
      });
    } else {
      this.runtime.daemonIdleReports.delete(sessionUuid);
    }
  }

  daemonKeepsSessionInUse(sessionUuid: string): boolean {
    return this.runtime.boundSessionFenceGate.daemonKeepsSessionInUse(sessionUuid);
  }

  hasSessionCallInFlight(sessionUuid: string): boolean {
    return (this.runtime.sessionCallsInFlight.get(sessionUuid) ?? 0) > 0;
  }

  /**
   * Count a forwarded call against the sessions it uses; returns the UUIDs to pass to
   * {@link endSessionCall}. Inventory observation and every other plain (non-device) read never
   * use the session they name, so they neither hold nor refresh it (#11107).
   */
  beginSessionCall(name: string, sessionUuids: readonly string[]): readonly string[] {
    if (
      isDeviceInventoryTool(name) ||
      (this.isDeviceReadOnlyTool(name) && !this.toolTargetsDevice(name))
    ) {
      return [];
    }
    for (const sessionUuid of sessionUuids) {
      this.runtime.sessionCallsInFlight.set(
        sessionUuid,
        (this.runtime.sessionCallsInFlight.get(sessionUuid) ?? 0) + 1,
      );
    }
    return sessionUuids;
  }

  /**
   * The session a forwarded call names, when it names one. Naming a session is not use (#10964).
   */
  sessionsUsedByCall(forwardedSessionUuid: string | undefined): string[] {
    return forwardedSessionUuid !== undefined ? [forwardedSessionUuid] : [];
  }

  /**
   * Credit the session the daemon says it admitted a call under and used (#10974): exactly that
   * session, when it is the latest binding or one this proxy holds. The daemon omits the echo for
   * reads, refused calls and sessionless calls, so those credit nothing. The echo is the only
   * credit from the first call on: the proxy and daemon versions match exactly, so there is no
   * daemon that cannot echo, and crediting what a call named would let a read move the idle clock
   * (#11348). A binding declared in a call's args is credited too: it is not heartbeated, but its
   * replay lease follows its use (#4610).
   */
  creditRoutedSession(result: unknown, forwardedSessionUuid: string | undefined): void {
    const routed = routedSessionUuidFromResult(result);
    // A non-terminal answer clears only that session's proxy-judged idle eviction;
    // daemon-confirmed losses survive. Reads have no routed-use echo, so use their
    // forwarded UUID without restarting protection.
    const answeredSessionUuid = routed ?? forwardedSessionUuid;
    if (
      answeredSessionUuid !== undefined &&
      this.runtime.pendingHeldSessionPlatformLosses.get(answeredSessionUuid)?.proxyJudged ===
        true &&
      readTerminalSessionRefusal(result)?.sessionUuid !== answeredSessionUuid
    ) {
      this.runtime.pendingHeldSessionPlatformLosses.delete(answeredSessionUuid);
    }
    if (routed !== undefined) {
      this.port.noteSessionRestoredByCall(routed);
      this.creditSessionUse(routed);
    }
  }

  /**
   * A call forwarded under `sessionUuid` ended: it no longer holds the session in flight. Ending
   * credits nothing. A read naming a session is watching, not use (#10964), so the idle window
   * restarts only from the daemon's echo of admitted use ({@link creditRoutedSession}).
   */
  endSessionCall(sessionUuids: readonly string[]): void {
    for (const sessionUuid of sessionUuids) {
      const remaining = (this.runtime.sessionCallsInFlight.get(sessionUuid) ?? 1) - 1;
      if (remaining > 0) {
        this.runtime.sessionCallsInFlight.set(sessionUuid, remaining);
      } else {
        this.runtime.sessionCallsInFlight.delete(sessionUuid);
      }
    }
  }

  /** Restart a session's idle window now: a tool call used it. */
  creditSessionUse(sessionUuid: string): void {
    const now = this.runtime.timer.now();
    if (sessionUuid === this.runtime.boundSessionUuid && !this.runtime.terminalBoundSession) {
      this.runtime.boundSessionUuidAt = now;
    }
    const held = this.runtime.otherHeldSessions.get(sessionUuid);
    if (held) {
      held.lastUsedAt = now;
    }
  }

  clearBoundSessionUuid(): void {
    if (this.runtime.boundSessionUuid !== undefined) {
      this.port.clearNotFoundHistory(this.runtime.boundSessionUuid);
    }
    this.runtime.boundSessionUuid = undefined;
    this.runtime.boundSessionUuidAt = undefined;
    this.runtime.initialSessionBindingConfigured = false;
    this.runtime.initialSessionAwaitingFirstCall = false;
    this.runtime.boundSessionFromResultMint = false;
    this.runtime.livenessOwnershipClaimSent = false;
    this.runtime.latestBindingConflict = undefined;
    this.runtime.recoverableBoundSessionHandoff = undefined;
    this.runtime.recoverableBoundSessionHandoffIsDeviceRestart = false;
  }

  retireIdleBinding(sessionUuid: string): void {
    return this.runtime.boundSessionFenceGate.retireIdleBinding(sessionUuid);
  }

  idleSessionReleaseReason(sessionUuid: string): string {
    return this.runtime.boundSessionFenceGate.idleSessionReleaseReason(sessionUuid);
  }

  fenceBoundSessionUuid(
    sessionUuid: string,
    reason: string,
    release?: SessionReleaseSnapshot,
  ): void {
    return this.runtime.boundSessionFenceGate.fenceBoundSessionUuid(sessionUuid, reason, release);
  }

  discoveryAfterResultMintRelease(): boolean {
    return this.runtime.boundSessionFenceGate.discoveryAfterResultMintRelease();
  }

  throwIfBoundSessionFenced(allowReleasedSession = false, namedSessionUuid?: string): void {
    return this.runtime.boundSessionFenceGate.throwIfBoundSessionFenced(
      allowReleasedSession,
      namedSessionUuid,
    );
  }

  boundSessionExpiredError(namedSessionUuid?: string): DaemonBoundSessionExpiredError {
    return this.runtime.boundSessionFenceGate.boundSessionExpiredError(namedSessionUuid);
  }

  forwardedSessionReleaseReasonSince(
    forwardedArgs: Record<string, unknown>,
    forwardEpoch: number,
  ): string | undefined {
    return this.runtime.boundSessionFenceGate.forwardedSessionReleaseReasonSince(
      forwardedArgs,
      forwardEpoch,
    );
  }

  throwIfSessionReleasedSince(sessionUuid: string, forwardEpoch: number): void {
    return this.runtime.boundSessionFenceGate.throwIfSessionReleasedSince(
      sessionUuid,
      forwardEpoch,
    );
  }

  fenceReleasedForwardedSession(forwardedArgs: Record<string, unknown>, reason: string): void {
    return this.runtime.boundSessionFenceGate.fenceReleasedForwardedSession(forwardedArgs, reason);
  }

  throwIfForwardedSessionReleasedSince(
    forwardedArgs: Record<string, unknown>,
    forwardEpoch: number,
  ): void {
    return this.runtime.boundSessionFenceGate.throwIfForwardedSessionReleasedSince(
      forwardedArgs,
      forwardEpoch,
    );
  }

  /** Learn which device a session runs on so a liveness handover can name it (#10053). */
  rememberSessionDevice(sessionUuid: string, deviceId: unknown): void {
    return rememberSessionDeviceId(this.runtime.sessionDeviceIds, sessionUuid, deviceId);
  }

  toolAcceptsSessionUuid(name: string): boolean {
    const tool =
      this.runtime.discovery.tools?.find((definition) => definition.name === name) ??
      this.runtime.staticToolDefinitionsProvider().find((definition) => definition.name === name);
    const properties = tool?.inputSchema.properties;
    return typeof properties === "object" && properties !== null && "sessionUuid" in properties;
  }
}
