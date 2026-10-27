import { raceWithDeadline } from "../../utils/raceWithDeadline";
import { type BuildIdentity } from "../wire/buildIdentity";
import { type DaemonClientLike } from "../client";
import { DAEMON_HEARTBEAT_METHOD, SOCKET_PATH } from "../wire/constants";
import { SessionOutsideBoundSessionError } from "../deviceOutsideBoundSessionRefusal";
import {
  type DeviceSessionSuspectRefusal,
  isDeviceBindingTool,
  isDeviceSessionAcquisitionTool,
} from "../deviceSessionResult";
import { type ListChangedKind } from "../listChangedBroadcast";
import { type DaemonRestartResult } from "../manager";
import { type BoundSessionFenceGatePort } from "../proxy/BoundSessionFenceGate";
import { type BoundSessionHeartbeatPort } from "../proxy/BoundSessionHeartbeat";
import { BrokerSessions, type BrokerSessionsPort } from "../proxy/BrokerSessions";
import { type ConnectionRecoveryPort } from "../proxy/ConnectionRecovery";
import { type DaemonLifecycleReconcilerDeps } from "../proxy/DaemonLifecycleReconciler";
import { DaemonShutdownBarrier } from "../proxy/DaemonShutdownBarrier";
import { DiscoveryListCache } from "../proxy/DiscoveryListCache";
import {
  ForwardedResultApplier,
  type ForwardedResultApplierPort,
} from "../proxy/ForwardedResultApplier";
import { type HandoverResolutionPort } from "../proxy/HandoverResolution";
import { type HeartbeatKeeperPort } from "../proxy/HeartbeatKeeper";
import {
  HeldSessionHeartbeatOutcomes,
  type HeldSessionHeartbeatOutcomesPort,
} from "../proxy/HeldSessionHeartbeatOutcomes";
import { HeldSessionLosses, type HeldSessionLossesPort } from "../proxy/HeldSessionLosses";
import { type LatestBindingKeeperPort } from "../proxy/LatestBindingKeeper";
import { type StallHandoverRecord } from "../proxy/ProxySessionState";
import { type SessionBindingDependencies, type SessionBindingPort } from "../proxy/SessionBinding";
import { type StallProbePort } from "../proxy/StallProbe";
import { ToolCallForwarder, type ToolCallForwarderPort } from "../proxy/ToolCallForwarder";
import {
  type BuildMismatchReason,
  DaemonBoundSessionExpiredError,
  DaemonBuildMismatchError,
  DaemonVersionMismatchError,
  type VersionMismatchReason,
} from "../proxy/daemonErrors";
import { type LivenessHandover, runWithoutDaemonLifecycle } from "../proxyLivenessRecovery";
import { type SessionReleaseSnapshot } from "../sessionManager/releaseTypes";
import { type DaemonStatus } from "../types";
import { isDeviceInventoryTool } from "./ProxyContracts";
import type { ProxyRuntime } from "./ProxyRuntime";
/** Operations supplied by the proxy's composition root. */
export interface ProxyCollaboratorsPort {
  resetConnection(): Promise<void>;
  invalidateCache(): void;
  assertDaemonLifecycleUnfenced(): void;
  reconciliationStatus(): Promise<DaemonStatus>;
  isSameDaemonGeneration(current: DaemonStatus, expected: DaemonStatus): boolean;
  waitForJoinedRestartSuccessor(expected: DaemonStatus, deadline: number): Promise<DaemonStatus>;
  waitForRunningReconciliationStatus(deadline: number): Promise<DaemonStatus>;
  readSocketReconciliationStatus(): Promise<DaemonStatus>;
  assertAutomaticRestartAllowed(status: DaemonStatus, reason: string): void;
  ensureVersionMatches(
    reconciliationDeadline?: number,
    observedStatus?: DaemonStatus,
  ): Promise<void>;
  verifyRestartedVersion(): Promise<void>;
  requiresVersionRestart(status: DaemonStatus, runningVersion: string): boolean;
  assertNewerClientVersion(
    status: DaemonStatus,
    runningVersion: string,
    runningBase: string,
    clientBase: string,
    sameRelease: boolean,
  ): void;
  assertVersionRestartCooldownExpired(status: DaemonStatus, runningVersion: string): void;
  versionMismatchError(
    runningVersion: string,
    reason: VersionMismatchReason,
    detail: string,
    retryAfterMs?: number,
    daemonBuild?: BuildIdentity,
  ): DaemonVersionMismatchError;
  ensureBuildMatches(reconciliationDeadline?: number, observedStatus?: DaemonStatus): Promise<void>;
  finishBuildRestart(
    restartResult: DaemonRestartResult,
    status: DaemonStatus,
    reconciliationDeadline: number,
  ): Promise<void>;
  buildMismatchError(
    daemon: BuildIdentity,
    reason: BuildMismatchReason,
    detail: string,
    retryAfterMs?: number,
  ): DaemonBuildMismatchError;
  recordHeldSessionTerminalLoss(...args: Parameters<HeldSessionLosses["recordTerminalLoss"]>): void;
  dropHeldSession(sessionUuid: string, keepHandover?: boolean, keepNotFoundHistory?: boolean): void;
  ensureConnected(): Promise<void>;
  throwIfBoundSessionFenced(allowReleasedSession?: boolean, namedSessionUuid?: string): void;
  boundSessionExpiredError(namedSessionUuid?: string): DaemonBoundSessionExpiredError;
  fenceBoundSessionUuid(
    sessionUuid: string,
    reason: string,
    release?: SessionReleaseSnapshot,
  ): void;
  hasRecoverableBoundSessionHandoff(): boolean;
  releaseKeepsBinding(sessionUuid: string, releaseReason: string | undefined): boolean;
  requireClient(): DaemonClientLike;
  boundSessionHeartbeatParams(
    sessionUuid: string,
    claimLivenessOwnership?: boolean,
    reportIdleRelease?: boolean,
  ): {
    sessionId: string;
    livenessPolicy: string;
    idleTimeoutMs?: number;
    livenessOwnerToken: string;
    claimLivenessOwnership?: true;
    reportIdleRelease?: true;
    reportDaemonInstance?: true;
  };
  answersOwnershipReestablishment(client: DaemonClientLike | null, sessionUuid: string): boolean;
  noteHeartbeatDaemonInstance(sessionUuid: string, daemonInstance: string | undefined): boolean;
  noteDaemonIdleEvidence(sessionUuid: string, ack: unknown): void;
  creditRoutedSession(result: unknown, forwardedSessionUuid: string | undefined): void;
  rememberToolSelectionProfile(
    name: string,
    requestedArgs: Record<string, unknown>,
    result: unknown,
  ): void;
  rememberActiveDeviceSession(
    name: string,
    args: Record<string, unknown>,
    result: unknown,
    releaseEpoch: number,
  ): void;
  noteSuspectSessionResult(
    name: string,
    result: unknown,
    forwardedArgs: Record<string, unknown>,
    allowRetry: boolean,
  ): DeviceSessionSuspectRefusal | undefined;
  noteReleaseSurfacedBy(answer: unknown): void;
  hasLivenessLifecycleFence(): boolean;
  waitForLivenessRecovery(signal?: AbortSignal): Promise<void>;
  withFencedControlDeviceSession(
    name: string,
    args: Record<string, unknown>,
  ): Record<string, unknown>;
  ownSessionForPlatformSelector(
    name: string,
    args: Record<string, unknown>,
    siblingOnly?: boolean,
  ): string | undefined;
  refuseAmbiguousSessionSelector(name: string, args: Record<string, unknown>): void;
  reportToolSessionLoss(name: string, args: Record<string, unknown>): void;
  prepareToolRoutingArgs(
    name: string,
    callerArgs: Record<string, unknown>,
    isSessionAcquisition: boolean,
  ): {
    forwardedArgs: Record<string, unknown>;
    allowReleasedSession: boolean;
  };
  sessionUuidFromArgs(args: Record<string, unknown>): string | undefined;
  withOneShotCliMarker(args: Record<string, unknown>): Record<string, unknown>;
  withAcceptanceConfiguration(args: Record<string, unknown>): Record<string, unknown>;
  withToolSelectionProfile(args: Record<string, unknown>): Record<string, unknown>;
  beginSessionCall(name: string, sessionUuids: readonly string[]): readonly string[];
  sessionsUsedByCall(forwardedSessionUuid: string | undefined): string[];
  endSessionCall(sessionUuids: readonly string[]): void;
  throwIfForwardedSessionReleasedSince(
    forwardedArgs: Record<string, unknown>,
    forwardEpoch: number,
  ): void;
  trackToolCallInFlight<T>(client: DaemonClientLike, send: () => Promise<T>): Promise<T>;
  removeProgressListener(client: DaemonClientLike | undefined, requestId: string | undefined): void;
  toolUnavailableError(
    name: string,
    daemonRejection?: string,
    daemonGated?: boolean,
  ): Promise<Error>;
  withBoundSessionUuid(
    args: Record<string, unknown>,
    usesDeviceSelector?: boolean,
    toolName?: string,
  ): Record<string, unknown>;
  notifyListChanged(kind: ListChangedKind): void;
  sendStalledSessionResumeHeartbeat(sessionUuid: string): Promise<unknown>;
  currentHandover(sessionUuid: string, record: StallHandoverRecord): LivenessHandover;
  reportPendingSessionLoss(args: Record<string, unknown>, terminalRouted?: boolean): void;
  notifyLivenessHandoverListeners(handover: LivenessHandover): void;
  forgetSessionLivenessState(
    sessionUuid: string,
    keepHandover?: boolean,
    keepNotFoundHistory?: boolean,
  ): void;
  heartbeatWithStallDetection(
    sessionUuid: string,
    send: (isCurrent: () => boolean) => Promise<void>,
  ): Promise<void>;
  isBoundSessionReplayExpired(): boolean;
  retireIdleBinding(sessionUuid: string): void;
  heartbeatRequestTimeoutMs(): number;
  isSessionlessControlDeviceTool(name: string, args?: Record<string, unknown>): boolean;
  toolTargetsDevice(name: string): boolean;
  isDeviceReadOnlyTool(name: string, args?: Record<string, unknown>): boolean;
  hasSessionCallInFlight(sessionUuid: string): boolean;
  clearBoundSessionUuid(): void;
  withOwnedSessionCapabilities(
    args: Record<string, unknown>,
    restore: boolean,
    namesOwnedSession: boolean | undefined,
    isSessionAcquisition: boolean,
  ): Record<string, unknown>;
  namesOwnedSession(callerArgs: Record<string, unknown>): boolean;
  bindStartupSession(sessionUuid: string): void;
  establishBoundSessionHeartbeat(established?: DaemonClientLike): Promise<void>;
  forwardedSessionReleaseReasonSince(
    forwardedArgs: Record<string, unknown>,
    forwardEpoch: number,
  ): string | undefined;
  fenceReleasedForwardedSession(forwardedArgs: Record<string, unknown>, reason: string): void;
  throwIfSessionReleasedSince(sessionUuid: string, forwardEpoch: number): void;
  invalidateListCache(kind: ListChangedKind): void;
  holdPreviousBinding(nextSessionUuid: string): void;
  failureNeverReachedLiveSession(error: unknown): boolean;
  toolAcceptsSessionUuid(name: string): boolean;
  daemonKeepsSessionInUse(sessionUuid: string): boolean;
  idleSessionReleaseReason(sessionUuid: string): string;
  recordHeldSessionHeartbeatSuccess(
    ...args: Parameters<HeldSessionHeartbeatOutcomes["recordHeldSessionHeartbeatSuccess"]>
  ): void;
  handleHeldSessionHeartbeatError(
    ...args: Parameters<HeldSessionHeartbeatOutcomes["handleHeldSessionHeartbeatError"]>
  ): void;
}

type Runtime = Pick<
  ProxyRuntime,
  | "boundHeartbeat"
  | "boundSessionReplayTtlMs"
  | "boundSessionUuid"
  | "brokerSessions"
  | "buildIdentity"
  | "claimableSessions"
  | "client"
  | "clientAssetVersion"
  | "clientVersion"
  | "closing"
  | "config"
  | "connected"
  | "connectionRecovery"
  | "daemonAvailabilityProbe"
  | "daemonManager"
  | "daemonShutdownBarrier"
  | "daemonStatusProbe"
  | "deadSocketClients"
  | "discovery"
  | "errorClassifier"
  | "forwardedResultApplier"
  | "handoverResolution"
  | "heartbeatKeeperStarted"
  | "heartbeatOutcomes"
  | "heldSessionLosses"
  | "latestBindingKeeper"
  | "listPoller"
  | "livenessOwnerToken"
  | "livenessRecovery"
  | "otherHeldSessions"
  | "ownedDeviceSessions"
  | "pendingHeldSessionPlatformLosses"
  | "plainRestartSessionLosses"
  | "progressListeners"
  | "reconciliationSnapshot"
  | "readCheckoutVersion"
  | "recoverableBoundSessionHandoff"
  | "recoverableBoundSessionHandoffIsDeviceRestart"
  | "releaseLedger"
  | "sessionBinding"
  | "sessionDeviceIds"
  | "sessionPlatforms"
  | "sessionState"
  | "stallHandovers"
  | "stallResumeProbe"
  | "terminalBoundSession"
  | "timer"
  | "toolCallsInFlight"
  | "toolCallsSettled"
  | "toolSelectionProfileUuid"
  | "transportLive"
>;

/** Collaborators operations on a single proxy runtime. */
export class ProxyCollaborators {
  constructor(
    private readonly runtime: Runtime,
    private readonly port: ProxyCollaboratorsPort,
  ) {}

  createDaemonShutdownBarrier(): DaemonShutdownBarrier {
    const proxy = this.runtime;
    return new DaemonShutdownBarrier(
      {
        hasClient: () => this.runtime.client !== null,
        clientReportsPeerClose: () => typeof this.runtime.client?.onConnectionClosed === "function",
        markQuiesced: () => {
          this.runtime.connected = false;
        },
        resetConnection: () => this.port.resetConnection(),
        isClosing: () => this.runtime.closing,
        socketPath: () => this.runtime.config.socketPath ?? SOCKET_PATH,
        autoStartDaemon: () => this.runtime.config.autoStartDaemon === true,
      },
      {
        // Read lazily: field initializers run before the constructor assigns these.
        get timer() {
          return proxy.timer;
        },
        get daemonManager() {
          return proxy.daemonManager;
        },
        daemonAvailabilityProbe: (socketPath) => proxy.daemonAvailabilityProbe(socketPath),
      },
    );
  }

  createLifecycleReconcilerDeps(): DaemonLifecycleReconcilerDeps {
    const proxy = this.runtime;
    return {
      get config() {
        return proxy.config;
      },
      get daemonManager() {
        return proxy.daemonManager;
      },
      get daemonStatusProbe() {
        return proxy.daemonStatusProbe;
      },
      get timer() {
        return proxy.timer;
      },
      get clientVersion() {
        return proxy.clientVersion;
      },
      get readCheckoutVersion() {
        return proxy.readCheckoutVersion;
      },
      get clientAssetVersion() {
        return proxy.clientAssetVersion;
      },
      get buildIdentity() {
        return proxy.buildIdentity;
      },
      get reconciliationSnapshot() {
        return proxy.reconciliationSnapshot;
      },
      set reconciliationSnapshot(value) {
        proxy.reconciliationSnapshot = value;
      },
      invalidateCache: () => this.port.invalidateCache(),
      assertDaemonLifecycleUnfenced: () => this.port.assertDaemonLifecycleUnfenced(),

      reconciliationStatus: () => this.port.reconciliationStatus(),
      isSameDaemonGeneration: (current, expected) =>
        this.port.isSameDaemonGeneration(current, expected),
      waitForJoinedRestartSuccessor: (expected, deadline) =>
        this.port.waitForJoinedRestartSuccessor(expected, deadline),
      waitForRunningReconciliationStatus: (deadline) =>
        this.port.waitForRunningReconciliationStatus(deadline),
      readSocketReconciliationStatus: () => this.port.readSocketReconciliationStatus(),
      assertAutomaticRestartAllowed: (status, reason) =>
        this.port.assertAutomaticRestartAllowed(status, reason),
      ensureVersionMatches: (reconciliationDeadline, observedStatus) =>
        this.port.ensureVersionMatches(reconciliationDeadline, observedStatus),
      verifyRestartedVersion: () => this.port.verifyRestartedVersion(),
      requiresVersionRestart: (status, runningVersion) =>
        this.port.requiresVersionRestart(status, runningVersion),
      assertNewerClientVersion: (status, runningVersion, runningBase, clientBase, sameRelease) =>
        this.port.assertNewerClientVersion(
          status,
          runningVersion,
          runningBase,
          clientBase,
          sameRelease,
        ),
      assertVersionRestartCooldownExpired: (status, runningVersion) =>
        this.port.assertVersionRestartCooldownExpired(status, runningVersion),
      versionMismatchError: (runningVersion, reason, detail, retryAfterMs, daemonBuild) =>
        this.port.versionMismatchError(runningVersion, reason, detail, retryAfterMs, daemonBuild),

      ensureBuildMatches: (reconciliationDeadline, observedStatus) =>
        this.port.ensureBuildMatches(reconciliationDeadline, observedStatus),
      finishBuildRestart: (restartResult, status, reconciliationDeadline) =>
        this.port.finishBuildRestart(restartResult, status, reconciliationDeadline),
      buildMismatchError: (daemon, reason, detail, retryAfterMs) =>
        this.port.buildMismatchError(daemon, reason, detail, retryAfterMs),
    };
  }

  createHeldSessionHeartbeatOutcomesPort(): HeldSessionHeartbeatOutcomesPort {
    return {
      isClosing: () => this.runtime.closing,
      isDaemonSessionNotFoundError: (...args) =>
        this.runtime.errorClassifier.isDaemonSessionNotFoundError(...args),
      applyNotFoundOutcome: (...args) => this.runtime.boundHeartbeat.applyNotFoundOutcome(...args),
      recordHeldSessionTerminalLoss: (...args) => this.port.recordHeldSessionTerminalLoss(...args),
      dropHeldSession: (...args) => this.port.dropHeldSession(...args),
    };
  }

  createConnectionRecoveryPort(): ConnectionRecoveryPort {
    return {
      isClosing: () => this.runtime.closing,
      isConnected: () => this.runtime.connected,
      client: () => this.runtime.client,
      isDeadSocket: (client) => this.runtime.deadSocketClients.has(client),
      toolCallsInFlight: (client) => this.runtime.toolCallsInFlight.get(client) ?? 0,
      toolCallsSettled: (client) => this.runtime.toolCallsSettled.get(client),
      setToolCallsSettled: (client, settled) => {
        this.runtime.toolCallsSettled.set(client, settled);
      },
      daemonShutdownDisconnect: () => this.runtime.daemonShutdownBarrier.pending,
      boundSessionUuid: () => this.runtime.boundSessionUuid,
      ensureConnected: () => this.port.ensureConnected(),
      resetConnection: () => this.port.resetConnection(),
      waitForDaemonShutdownDisconnect: () => this.runtime.daemonShutdownBarrier.arm(),
      throwIfBoundSessionFenced: (...args) => this.port.throwIfBoundSessionFenced(...args),
      boundSessionExpiredError: () => this.port.boundSessionExpiredError(),
      fenceBoundSessionUuid: (...args) => this.port.fenceBoundSessionUuid(...args),
      hasRecoverableBoundSessionHandoff: () => this.port.hasRecoverableBoundSessionHandoff(),
      clearRecoverableBoundSessionHandoff: () => {
        this.runtime.recoverableBoundSessionHandoff = undefined;
        this.runtime.recoverableBoundSessionHandoffIsDeviceRestart = false;
      },
      releaseKeepsBinding: (...args) => this.port.releaseKeepsBinding(...args),
    };
  }

  createBoundSessionHeartbeatPort(): BoundSessionHeartbeatPort {
    return {
      requireClient: () => this.port.requireClient(),
      boundSessionHeartbeatParams: (...args) => this.port.boundSessionHeartbeatParams(...args),
      answersOwnershipReestablishment: (...args) =>
        this.port.answersOwnershipReestablishment(...args),
      noteHeartbeatDaemonInstance: (...args) => this.port.noteHeartbeatDaemonInstance(...args),
      noteDaemonIdleEvidence: (...args) => this.port.noteDaemonIdleEvidence(...args),
      isDaemonSessionNotFoundError: (...args) =>
        this.runtime.errorClassifier.isDaemonSessionNotFoundError(...args),
      isHeldSession: (...args) => this.runtime.latestBindingKeeper.isHeldSession(...args),
      latestBindingClaimable: () => this.runtime.latestBindingKeeper.latestBindingClaimable(),
      withRecoverableReconnect: (...args) =>
        this.runtime.connectionRecovery.withRecoverableReconnect(...args),
      fenceBoundSessionUuid: (...args) => this.port.fenceBoundSessionUuid(...args),
      dropHeldSession: (...args) => this.port.dropHeldSession(...args),
      syncHeartbeatKeeper: () => this.runtime.latestBindingKeeper.syncHeartbeatKeeper(),
      isClosing: () => this.runtime.closing,
    };
  }

  createForwardedResultApplier(): ForwardedResultApplier {
    return new ForwardedResultApplier({
      timer: this.runtime.timer,
      releaseLedger: this.runtime.releaseLedger,
      sessionBinding: this.runtime.sessionBinding,
      port: this.createForwardedResultApplierPort(),
    });
  }

  createForwardedResultApplierPort(): ForwardedResultApplierPort {
    return {
      creditRoutedSession: (...args) => this.port.creditRoutedSession(...args),
      rememberToolSelectionProfile: (...args) => this.port.rememberToolSelectionProfile(...args),
      rememberActiveDeviceSession: (...args) => this.port.rememberActiveDeviceSession(...args),
      noteSuspectSessionResult: (...args) => this.port.noteSuspectSessionResult(...args),
      noteReleaseSurfacedBy: (...args) => this.port.noteReleaseSurfacedBy(...args),
      isDeviceBindingTool: (name) => isDeviceBindingTool(name),
    };
  }

  createToolCallForwarder(): ToolCallForwarder {
    return new ToolCallForwarder({
      timer: this.runtime.timer,
      progressListeners: this.runtime.progressListeners,
      releaseLedger: this.runtime.releaseLedger,
      heldSessionLosses: this.runtime.heldSessionLosses,
      handoverResolution: this.runtime.handoverResolution,
      sessionBinding: this.runtime.sessionBinding,
      errorClassifier: this.runtime.errorClassifier,
      port: this.createToolCallForwarderPort(),
    });
  }

  createToolCallForwarderPort(): ToolCallForwarderPort {
    return {
      hasStallHandovers: () => this.runtime.stallHandovers.size > 0,
      hasLivenessLifecycleFence: (...args) => this.port.hasLivenessLifecycleFence(...args),
      waitForLivenessRecovery: (...args) => this.port.waitForLivenessRecovery(...args),
      withFencedControlDeviceSession: (...args) =>
        this.port.withFencedControlDeviceSession(...args),
      ownSessionForPlatformSelector: (...args) => this.port.ownSessionForPlatformSelector(...args),
      refuseAmbiguousSessionSelector: (...args) =>
        this.port.refuseAmbiguousSessionSelector(...args),
      reportToolSessionLoss: (...args) => this.port.reportToolSessionLoss(...args),
      prepareToolRoutingArgs: (...args) => this.port.prepareToolRoutingArgs(...args),
      sessionUuidFromArgs: (...args) => this.port.sessionUuidFromArgs(...args),
      withOneShotCliMarker: (...args) => this.port.withOneShotCliMarker(...args),
      withAcceptanceConfiguration: (...args) => this.port.withAcceptanceConfiguration(...args),
      withToolSelectionProfile: (...args) => this.port.withToolSelectionProfile(...args),
      beginSessionCall: (...args) => this.port.beginSessionCall(...args),
      sessionsUsedByCall: (...args) => this.port.sessionsUsedByCall(...args),
      endSessionCall: (...args) => this.port.endSessionCall(...args),
      throwIfForwardedSessionReleasedSince: (...args) =>
        this.port.throwIfForwardedSessionReleasedSince(...args),
      requireClient: (...args) => this.port.requireClient(...args),
      trackToolCallInFlight: (...args) => this.port.trackToolCallInFlight(...args),
      withRecoverableReconnect: (...args) =>
        this.runtime.connectionRecovery.withRecoverableReconnect(...args),
      deferredToTask: (...args) => this.runtime.forwardedResultApplier.deferredToTask(...args),
      applyForwardedResult: (...args) =>
        this.runtime.forwardedResultApplier.applyForwardedResult(...args),
      noteReleaseSurfacedBy: (...args) => this.port.noteReleaseSurfacedBy(...args),
      removeProgressListener: (...args) => this.port.removeProgressListener(...args),
      toolUnavailableError: (...args) => this.port.toolUnavailableError(...args),
    };
  }

  createDiscoveryListCache(): DiscoveryListCache {
    return new DiscoveryListCache({
      recovery: {
        withRecoverableReconnect: (...args) =>
          this.runtime.connectionRecovery.withRecoverableReconnect(...args),
      },
      port: {
        boundParams: (released) => (released ? {} : this.port.withBoundSessionUuid({})),
        withToolSelectionProfile: (args) => this.port.withToolSelectionProfile(args),
        sessionUuidFromArgs: (args) => this.port.sessionUuidFromArgs(args),
        callDaemonMethod: (method, params) =>
          this.port.requireClient().callDaemonMethod(method, params),
        observeList: (kind, list) => this.runtime.listPoller.observe(kind, list),
      },
    });
  }

  createHandoverResolutionPort(): HandoverResolutionPort {
    return {
      bumpDiscoveryEpoch: () => {
        this.runtime.discovery.bumpEpoch();
      },
      invalidateCache: (...args) => this.port.invalidateCache(...args),
      notifyListChanged: (...args) => this.port.notifyListChanged(...args),
      syncHeartbeatKeeper: () => this.runtime.latestBindingKeeper.syncHeartbeatKeeper(),
      stopStallProbeInterval: () => {
        void this.runtime.stallResumeProbe.stop();
      },
      sendResumeHeartbeat: (...args) => this.port.sendStalledSessionResumeHeartbeat(...args),
      sessionUuidFromArgs: (...args) => this.port.sessionUuidFromArgs(...args),
      noteDaemonIdleEvidence: (...args) => this.port.noteDaemonIdleEvidence(...args),
      currentHandover: (...args) => this.port.currentHandover(...args),
      reportPendingSessionLoss: (...args) => this.port.reportPendingSessionLoss(...args),
      notifyLivenessHandoverListeners: (...args) =>
        this.port.notifyLivenessHandoverListeners(...args),
      fenceBoundSessionUuid: (...args) => this.port.fenceBoundSessionUuid(...args),
      forgetSessionLivenessState: (...args) => this.port.forgetSessionLivenessState(...args),
    };
  }

  createLatestBindingKeeperPort(): LatestBindingKeeperPort {
    return {
      isClosing: () => this.runtime.closing,
      isTransportLive: () => this.runtime.transportLive,
      heartbeatWithStallDetection: (...args) => this.port.heartbeatWithStallDetection(...args),
      isBoundSessionReplayExpired: () => this.port.isBoundSessionReplayExpired(),
      retireIdleBinding: (...args) => this.port.retireIdleBinding(...args),
    };
  }

  createStallProbePort(): StallProbePort {
    return {
      isClosing: () => this.runtime.closing,
      sendResumeHeartbeat: (...args) => this.port.sendStalledSessionResumeHeartbeat(...args),
      sendProbeHeartbeat: (sessionUuid, expectedDaemonInstance) =>
        runWithoutDaemonLifecycle(() =>
          raceWithDeadline(
            async () => {
              await this.port.ensureConnected();
              return this.port.requireClient().callDaemonMethod(DAEMON_HEARTBEAT_METHOD, {
                ...this.port.boundSessionHeartbeatParams(sessionUuid, false, true),
                expectedDaemonInstance,
              });
            },
            {
              timer: this.runtime.timer,
              timeoutMs: this.port.heartbeatRequestTimeoutMs(),
              label: "Stalled-daemon probe",
            },
          ),
        ),
      restoreResumedSession: (...args) =>
        this.runtime.handoverResolution.restoreResumedSession(...args),
      noteDaemonIdleEvidence: (...args) => this.port.noteDaemonIdleEvidence(...args),
      endLostSessionHandover: (...args) =>
        this.runtime.handoverResolution.endLostSessionHandover(...args),
      isDefinitiveSessionLoss: (...args) =>
        this.runtime.handoverResolution.isDefinitiveSessionLoss(...args),
      isDaemonSessionNotFoundError: (...args) =>
        this.runtime.errorClassifier.isDaemonSessionNotFoundError(...args),
      startProbeInterval: () => this.runtime.stallResumeProbe.start(),
      stopProbeInterval: () => {
        void this.runtime.stallResumeProbe.stop();
      },
    };
  }

  createBoundSessionFenceGatePort(): BoundSessionFenceGatePort {
    return {
      state: this.runtime.sessionState,
      pendingHeldSessionPlatformLosses: this.runtime.pendingHeldSessionPlatformLosses,
      ownedDeviceSessions: this.runtime.ownedDeviceSessions,
      sessionDeviceIds: this.runtime.sessionDeviceIds,
      sessionPlatforms: this.runtime.sessionPlatforms,
      releaseLedger: this.runtime.releaseLedger,
      timer: this.runtime.timer,
      livenessRecovery: this.runtime.livenessRecovery,
      keeper: { syncHeartbeatKeeper: () => this.runtime.latestBindingKeeper.syncHeartbeatKeeper() },
      initialSessionUuid: () => this.runtime.config.initialSessionUuid,
      boundSessionReplayTtlMs: () => this.runtime.boundSessionReplayTtlMs,
      transportLive: () => this.runtime.connected && this.runtime.client !== null,
      toolSelectionProfileUuid: () => this.runtime.toolSelectionProfileUuid,
      bumpDiscoveryEpoch: () => {
        this.runtime.discovery.bumpEpoch();
      },
      isDeviceSessionAcquisitionTool,
      isDeviceInventoryTool,
      isDeviceBindingTool,
      isSessionlessControlDeviceTool: (...args) =>
        this.port.isSessionlessControlDeviceTool(...args),
      toolTargetsDevice: (...args) => this.port.toolTargetsDevice(...args),
      isDeviceReadOnlyTool: (...args) => this.port.isDeviceReadOnlyTool(...args),
      hasSessionCallInFlight: (...args) => this.port.hasSessionCallInFlight(...args),
      noteReleaseSurfacedBy: (...args) => this.port.noteReleaseSurfacedBy(...args),
      currentHandover: (...args) => this.port.currentHandover(...args),
      outsideBoundSessionError: (...args) => new SessionOutsideBoundSessionError(...args),
      dropHeldSession: (...args) => this.port.dropHeldSession(...args),
      forgetSessionLivenessState: (...args) => this.port.forgetSessionLivenessState(...args),
      invalidateCache: () => this.port.invalidateCache(),
      clearBoundSessionUuid: () => this.port.clearBoundSessionUuid(),
      notifyListChanged: (...args) => this.port.notifyListChanged(...args),
      withToolSelectionProfile: (...args) => this.port.withToolSelectionProfile(...args),
      withOwnedSessionCapabilities: (...args) => this.port.withOwnedSessionCapabilities(...args),
      namesOwnedSession: (...args) => this.port.namesOwnedSession(...args),
      sessionUuidFromArgs: (...args) => this.port.sessionUuidFromArgs(...args),
    };
  }

  createHeldSessionLossesPort(): HeldSessionLossesPort {
    return {
      boundSessionUuid: () => this.runtime.boundSessionUuid,
      terminalBoundSessionUuid: () => this.runtime.terminalBoundSession?.sessionUuid,
      isOtherHeldSession: (sessionUuid) => this.runtime.otherHeldSessions.has(sessionUuid),
      otherHeldSessionUuids: () => this.runtime.otherHeldSessions.keys(),
      stallHandover: (sessionUuid) => this.runtime.stallHandovers.get(sessionUuid),
      isSessionlessControlDeviceTool: (...args) =>
        this.port.isSessionlessControlDeviceTool(...args),
      sessionUuidFromArgs: (...args) => this.port.sessionUuidFromArgs(...args),
      reportPendingSessionLoss: (...args) => this.port.reportPendingSessionLoss(...args),
      noteReleaseSurfacedBy: (...args) => this.port.noteReleaseSurfacedBy(...args),
    };
  }

  createBrokerSessions(): BrokerSessions {
    return new BrokerSessions({
      timer: this.runtime.timer,
      livenessOwnerToken: this.runtime.livenessOwnerToken,
      port: this.createBrokerSessionsPort(),
    });
  }

  createBrokerSessionsPort(): BrokerSessionsPort {
    return {
      ensureConnected: () => this.port.ensureConnected(),
      requireClient: () => this.port.requireClient(),
      client: () => this.runtime.client,
      isClosing: () => this.runtime.closing,
      boundSessionUuid: () => this.runtime.boundSessionUuid,
      terminalBoundSessionUuid: () => this.runtime.terminalBoundSession?.sessionUuid,
      bindStartupSession: (sessionUuid) => this.port.bindStartupSession(sessionUuid),
      establishBoundSessionHeartbeat: () => this.port.establishBoundSessionHeartbeat(),
      fenceBoundSession: (sessionUuid, code) => this.port.fenceBoundSessionUuid(sessionUuid, code),
      forgetBoundSession: (sessionUuid) => {
        this.runtime.ownedDeviceSessions.delete(sessionUuid);
        this.runtime.claimableSessions.delete(sessionUuid);
        this.port.dropHeldSession(sessionUuid);
        if (this.runtime.boundSessionUuid === sessionUuid) {
          this.port.clearBoundSessionUuid();
        }
        this.runtime.latestBindingKeeper.syncHeartbeatKeeper();
      },
    };
  }

  createSessionBindingDependencies(): SessionBindingDependencies {
    return {
      timer: this.runtime.timer,
      state: this.runtime.sessionState,
      ownedDeviceSessions: this.runtime.ownedDeviceSessions,
      sessionPlatforms: this.runtime.sessionPlatforms,
      sessionDeviceIds: this.runtime.sessionDeviceIds,
      sessionBrokerSessions: this.runtime.brokerSessions.sessions,
      plainRestartSessionLosses: this.runtime.plainRestartSessionLosses,
      pendingHeldSessionPlatformLosses: this.runtime.pendingHeldSessionPlatformLosses,
      initialSessionUuid: () => this.runtime.config.initialSessionUuid,
      port: this.createSessionBindingPort(),
    };
  }

  createSessionBindingPort(): SessionBindingPort {
    return {
      startBoundSessionHeartbeat: (...args) =>
        this.runtime.latestBindingKeeper.startBoundSessionHeartbeat(...args),
      forwardedSessionReleaseReasonSince: (...args) =>
        this.port.forwardedSessionReleaseReasonSince(...args),
      fenceReleasedForwardedSession: (...args) => this.port.fenceReleasedForwardedSession(...args),
      throwIfSessionReleasedSince: (...args) => this.port.throwIfSessionReleasedSince(...args),
      sessionReleaseReasonSince: (sessionUuid, forwardEpoch) =>
        this.runtime.forwardedResultApplier.deviceBindingTasksAbandoned
          ? "proxy_closing"
          : this.runtime.releaseLedger.sessionReleaseReasonSince(sessionUuid, forwardEpoch),
      invalidateListCache: (...args) => this.port.invalidateListCache(...args),
      notifyListChanged: (...args) => this.port.notifyListChanged(...args),
      holdPreviousBinding: (...args) => this.port.holdPreviousBinding(...args),
      clearHeldSessionLossesForSelection: (...args) =>
        this.runtime.heldSessionLosses.clearForSelection(...args),
      syncHeartbeatKeeper: (...args) =>
        this.runtime.latestBindingKeeper.syncHeartbeatKeeper(...args),
      stopBoundSessionHeartbeat: (...args) =>
        this.runtime.latestBindingKeeper.stopBoundSessionHeartbeat(...args),
      establishBoundSessionHeartbeat: (...args) =>
        this.port.establishBoundSessionHeartbeat(...args),
      failureNeverReachedLiveSession: (...args) =>
        this.port.failureNeverReachedLiveSession(...args),
      toolAcceptsSessionUuid: (...args) => this.port.toolAcceptsSessionUuid(...args),
      isHeartbeatKeeperStarted: () => this.runtime.heartbeatKeeperStarted,
    };
  }

  createHeartbeatKeeperPort(): HeartbeatKeeperPort {
    return {
      runLatestBindingHeartbeatTick: (...args) =>
        this.runtime.latestBindingKeeper.runLatestBindingHeartbeatTick(...args),
      hasSessionCallInFlight: (...args) => this.port.hasSessionCallInFlight(...args),
      daemonKeepsSessionInUse: (...args) => this.port.daemonKeepsSessionInUse(...args),
      recordHeldSessionTerminalLoss: (...args) => this.port.recordHeldSessionTerminalLoss(...args),
      idleSessionReleaseReason: (...args) => this.port.idleSessionReleaseReason(...args),
      dropHeldSession: (...args) => this.port.dropHeldSession(...args),
      withRecoverableReconnect: (...args) =>
        this.runtime.connectionRecovery.withRecoverableReconnect(...args),
      askSessionHeartbeat: (...args) => this.runtime.boundHeartbeat.askSessionHeartbeat(...args),
      recordHeldSessionHeartbeatSuccess: (...args) =>
        this.port.recordHeldSessionHeartbeatSuccess(...args),
      noteLateHeartbeatAck: (...args) =>
        this.runtime.heartbeatOutcomes.noteLateHeartbeatAck(...args),
      handleHeldSessionHeartbeatError: (...args) =>
        this.port.handleHeldSessionHeartbeatError(...args),
      isMissingHeartbeatAcknowledgement: (...args) =>
        this.runtime.heartbeatOutcomes.isMissingHeartbeatAcknowledgement(...args),
      heldSessionUuids: (...args) => this.runtime.latestBindingKeeper.heldSessionUuids(...args),
      isClosing: () => this.runtime.closing,
    };
  }
}
