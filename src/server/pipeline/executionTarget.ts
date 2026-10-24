import { resolveSessionDevicePlatform } from "./resolveSessionDevicePlatform";
import type { DeviceAwareToolOptions, SessionlessDeviceRead } from "../toolRegistry";
import {
  DeviceReadiness,
  isScanAuthoritativeFor,
  type ConnectedPlatformScan,
} from "../../daemon/readiness/DeviceReadiness";
import { defaultTimer, type Timer } from "../../utils/SystemTimer";
import { ActionableError, BootedDevice, SomePlatform } from "../../models";
import { defaultDaemonContext } from "../../daemon/daemonContext";
import { logger, type Logger } from "../../utils/logger";
import {
  defaultDisplayInventoryProvider,
  type DisplayInventoryProvider,
} from "../../devices/DisplayInventoryProvider";
import {
  defaultDeviceObservationAccess,
  sessionlessDeviceReadFor,
  type DeviceObservationAccess,
} from "../deviceObservationAccess";
import {
  admitReadSession,
  adoptHolderConnectionSession,
  canonicalizeCallDeviceId,
  ensureReadTargetOrWatch,
  findExplicitReadTarget,
  findHeldReadIdentity,
  findRunningExplicitReadTarget,
  foreignDeviceRead,
  gatedReadSessionDevice,
  isDeviceReadOnlyCall,
  isSessionlessReadTargetHeld,
  lateReadSessionDevice,
  multipleDevicesError,
  resolveSessionlessDeviceRead,
} from "./readTarget";
import { getToolSelectionContext } from "../../features/toolSelection/toolSelectionContext";
import {
  bindingAccessFor,
  createTargetResolution,
  declaredDeviceReadiness,
  toolContextSessionOptions,
  type TargetResolution,
} from "./targetResolutionState";
import { getDeviceLabelMap } from "../deviceLabelMapping";
import { executionTracker } from "../../daemon/executionTracker";
import {
  assertBindingControlAccess,
  assertSessionDeviceRouting,
  assertToolCallerHoldsDevice,
  assertToolControlTargetIdentity,
  markDeviceCallKind,
  predictReadinessTarget,
  refuseControlCallBeforeAdmission,
} from "./deviceCallDispatch";
import { createToolExecutionContext } from "../ToolExecutionContext";
import { resolveDirectSessionDevice } from "../../utils/directSessionDeviceRegistry";
import { serverConfig } from "../../utils/ServerConfig";
import { AndroidCtrlProxyClient } from "../../features/observe/android";
import { IOSCtrlProxyClient } from "../../features/observe/ios";
import { AmbiguousDeviceTargetError } from "../../daemon/ambiguousDeviceTargetRefusal";
import { DeviceOutsideBoundSessionError } from "../../daemon/deviceOutsideBoundSessionRefusal";
import { DirectSessionNotActiveError } from "../../models/DirectSessionNotActiveError";

export interface ExecutionTargetInput {
  name: string;
  args: any;
  options: DeviceAwareToolOptions;
  deviceReadiness: DeviceReadiness;
  signal?: AbortSignal;
  /** The registry's clock; rate-limits the first-sighting transport probe (#11618). */
  timer?: Timer;
}

export interface ExecutionTargetContext {
  args: any;
  baseSessionUuid: string | undefined;
  device: BootedDevice | undefined;
  internalCall: boolean;
  sessionUuid: string | undefined;
  shouldResolveDevice: boolean;
  /** Resolved through the read-only device path: the handler runs without recording or audit. */
  deviceRead?: SessionlessDeviceRead;
}

export interface ExecutionTargetResolver {
  resolveExecutionTarget(input: ExecutionTargetInput): Promise<ExecutionTargetContext>;
}

export class DefaultExecutionTargetResolver implements ExecutionTargetResolver {
  private readonly defaultDeviceRead: SessionlessDeviceRead;

  private refuseEndedPlanBase(sessionUuid: string, executionId?: string): void {
    const ended = defaultDaemonContext
      .sessionManager()
      ?.terminalAnswerForEndedSession(sessionUuid, executionId);
    if (ended) {
      throw ended;
    }
  }

  constructor(
    private readonly log: Logger = logger,
    private readonly displayInventory: DisplayInventoryProvider = defaultDisplayInventoryProvider,
    deviceReadAccess: DeviceObservationAccess = defaultDeviceObservationAccess,
  ) {
    this.defaultDeviceRead = sessionlessDeviceReadFor(deviceReadAccess);
  }
  async resolveExecutionTarget(input: ExecutionTargetInput): Promise<ExecutionTargetContext> {
    // Awaited only when a first-seen transport must be probed: every other call resolves its id
    // from the pool's cached fold and stays on this turn.
    const firstSighting = canonicalizeCallDeviceId(input);
    if (firstSighting) {
      await firstSighting;
    }
    adoptHolderConnectionSession(input.args);
    if (
      input.options.sessionlessDeviceRead &&
      getToolSelectionContext()?.explicitObserveDeviceRead &&
      input.args.deviceId &&
      !input.args.sessionUuid
    ) {
      const read = input.options.sessionlessDeviceRead;
      const running = await findExplicitReadTarget(input, read, input.args.platform || "either");
      if (running) {
        // A running explicit observe keeps its lightweight handler readiness.
        return resolveSessionlessDeviceRead(input, read, running.deviceId, running);
      }
      // Only absence falls through to the manager's existing named-image boot and errors.
      const target = await this.resolveNormalExecutionTarget(input, true);
      if (target.device && !target.sessionUuid) {
        read.assertAuthorized(target.device);
        return { ...target, deviceRead: read };
      }
      return target;
    }
    return this.resolveNormalExecutionTarget(input);
  }

  private async resolveNormalExecutionTarget(
    input: ExecutionTargetInput,
    runningReadAlreadyChecked = false,
  ): Promise<ExecutionTargetContext> {
    const state = createTargetResolution(input, runningReadAlreadyChecked);
    this.applyDeviceLabel(state);
    if (state.shouldResolveDevice) {
      await this.resolveImplicitSession(state);
    }
    const sessionlessRead =
      (await this.admitReadOnlyCall(state)) ?? (await this.foreignDeviceReadTarget(state));
    if (sessionlessRead) {
      return sessionlessRead;
    }
    await this.assertExplicitTargetAccess(state);
    await this.resolveSessionDevice(state);
    const earlyRead = await this.resolveDevice(state);
    if (earlyRead) {
      return earlyRead;
    }
    await this.assertResolvedDeviceAccess(state);
    this.bindCtrlProxySession(state);
    return {
      args: input.args,
      baseSessionUuid: state.baseSessionUuid,
      device: state.device,
      internalCall: state.internalCall,
      sessionUuid: state.sessionUuid,
      shouldResolveDevice: state.shouldResolveDevice,
    };
  }

  /** Maps a device label to its allocated session (executePlan labels), refusing unknown ones. */
  private applyDeviceLabel(state: TargetResolution): void {
    const { args } = state.input;
    const deviceLabel = typeof args.device === "string" ? args.device : undefined;
    if (!deviceLabel || !state.shouldResolveDevice) {
      return;
    }
    const baseSessionUuid = state.baseSessionUuid;
    if (!defaultDaemonContext.sessionManager()) {
      throw new ActionableError("Device labels require an active daemon session.");
    }
    if (!baseSessionUuid) {
      throw new ActionableError(
        `Device label '${deviceLabel}' requires sessionUuid to be provided.`,
      );
    }
    state.sessionUuid = this.labelSession(state, baseSessionUuid, deviceLabel);

    if (state.providedDeviceId) {
      logger.warn(
        `[ToolRegistry] Ignoring deviceId because device label '${deviceLabel}' was provided.`,
      );
      state.providedDeviceId = undefined;
    }
  }

  private labelSession(
    state: TargetResolution,
    baseSessionUuid: string,
    deviceLabel: string,
  ): string {
    const { name, args } = state.input;
    const declaredDeviceLabels = Array.isArray(args.devices) ? args.devices : undefined;
    const deviceLabelMap = getDeviceLabelMap(baseSessionUuid);
    if (deviceLabelMap) {
      const mappedSession = deviceLabelMap[deviceLabel];
      if (!mappedSession) {
        const available = Object.keys(deviceLabelMap);
        const suffix = available.length > 0 ? ` Available labels: ${available.join(", ")}` : "";
        throw new ActionableError(`Unknown device label '${deviceLabel}'.${suffix}`);
      }
      return mappedSession;
    }
    if (name === "executePlan" && declaredDeviceLabels?.includes(deviceLabel)) {
      return baseSessionUuid;
    }
    // The base's end ends its labels (#11640): a step whose base has ended, or is past its
    // idle deadline, fails with the base's terminal release, not as an unallocated label.
    this.refuseEndedPlanBase(baseSessionUuid, state.execution?.executionId);
    throw new ActionableError(
      `Device label '${deviceLabel}' is not allocated. Provide a devices list to executePlan before using device labels.`,
    );
  }

  /** Resolves the implicit autolock session and enforces a session when several devices exist. */
  private async resolveImplicitSession(state: TargetResolution): Promise<void> {
    const { args, options, deviceReadiness, signal } = state.input;
    const { platform, providedDeviceId, execution, mcpSessionId, autolockEnabled } = state;
    const implicitSessionUuid = this.resolveImplicitAutolockSession(
      platform,
      state.sessionUuid,
      providedDeviceId,
      mcpSessionId,
      execution,
      autolockEnabled,
    );
    if (implicitSessionUuid) {
      state.sessionUuid = implicitSessionUuid;
      if (execution) {
        executionTracker.setResolvedAutolockSessionUuid(execution.executionId, implicitSessionUuid);
      }
      logger.info(
        `[ToolRegistry] Resolved implicit autolock session for MCP session ${mcpSessionId}: ${implicitSessionUuid}`,
      );
    }
    if (state.sessionUuid) {
      // Handlers must use the resolved label or implicit session, not the
      // caller's base session, so session-scoped state stays on the device
      // that ToolRegistry selected.
      args.sessionUuid = state.sessionUuid;
    }
    await this.enforceSessionUuidForMultipleDevices({
      platform,
      connectionId: state.deviceConnectionId,
      sessionUuid: state.sessionUuid,
      providedDeviceId,
      deviceReadiness,
      signal,
      getConnectedPlatforms: state.getConnectedPlatforms,
      readOnly: isDeviceReadOnlyCall(options, args),
    });
    await this.enforceSessionUuidForAutolock({
      platform,
      connectionId: state.deviceConnectionId,
      sessionUuid: state.sessionUuid,
      providedDeviceId,
      deviceReadiness,
      signal,
      getConnectedPlatforms: state.getConnectedPlatforms,
      autolockEnabled,
      readOnly: isDeviceReadOnlyCall(options, args),
    });
  }

  /**
   * Admits a read-only call without claiming its session (#10964), answering from the sessionless
   * read path when the session is gated, not live, or past its idle deadline.
   */
  private async admitReadOnlyCall(
    state: TargetResolution,
  ): Promise<ExecutionTargetContext | undefined> {
    const { name, args, options } = state.input;
    const { execution, shouldResolveDevice } = state;
    state.readOnly = isDeviceReadOnlyCall(options, args);
    if (execution) {
      markDeviceCallKind(execution.executionId, name, state.readOnly);
    }
    const gatedReadDeviceId =
      state.readOnly && shouldResolveDevice ? gatedReadSessionDevice(state.sessionUuid) : undefined;
    if (gatedReadDeviceId) {
      delete args.sessionUuid;
      return resolveSessionlessDeviceRead(
        state.input,
        options.sessionlessDeviceRead ?? this.defaultDeviceRead,
        state.providedDeviceId ?? gatedReadDeviceId,
      );
    }
    // A read is admitted read-only (#10964): it never refreshes or claims the session, and its end
    // is not use. Only control calls extend a session's idle deadline.
    state.readSession =
      state.readOnly && state.sessionUuid && shouldResolveDevice
        ? await admitReadSession(state.sessionUuid, execution)
        : undefined;
    return state.readSession === null ? this.readWithoutLiveSession(state) : undefined;
  }

  /** A read naming no live device session (an IDE observer session) runs as a sessionless read. */
  private async readWithoutLiveSession(
    state: TargetResolution,
  ): Promise<ExecutionTargetContext | undefined> {
    const { name, args, options } = state.input;
    // Read-only access never requires a session (#10968): a read carrying an id that names no
    // live device session (an IDE observer session) runs as a sessionless read.
    logger.info(
      `[ToolRegistry] ${name}: ${state.sessionUuid} is not a live device session; reading sessionlessly`,
    );
    const lateReadDeviceId = state.providedDeviceId
      ? undefined
      : lateReadSessionDevice(state.sessionUuid, state.execution);
    state.sessionUuid = undefined;
    delete args.sessionUuid;
    if (options.sessionlessDeviceRead && state.providedDeviceId) {
      // The same contract as a sessionless `observe {deviceId}`: no session, no readiness.
      return resolveSessionlessDeviceRead(
        state.input,
        options.sessionlessDeviceRead,
        state.providedDeviceId,
      );
    }
    if (lateReadDeviceId) {
      // A read that named a session still held by earlier work past its idle deadline (#11361)
      // reads that session's device, not whichever device a sessionless call would select.
      return resolveSessionlessDeviceRead(
        state.input,
        options.sessionlessDeviceRead ?? this.defaultDeviceRead,
        lateReadDeviceId,
      );
    }
    return undefined;
  }

  /**
   * A read naming another device than its own session's watches that device (#10970): it is not
   * this session's work, so it runs sessionless on the read-only device path.
   */
  private foreignDeviceReadTarget(
    state: TargetResolution,
  ): Promise<ExecutionTargetContext> | undefined {
    const { args, options } = state.input;
    const foreignReadDeviceId =
      state.readOnly && state.shouldResolveDevice
        ? foreignDeviceRead(state.sessionUuid, state.providedDeviceId)
        : undefined;
    if (!foreignReadDeviceId) {
      return undefined;
    }
    delete args.sessionUuid;
    return resolveSessionlessDeviceRead(
      state.input,
      options.sessionlessDeviceRead ?? this.defaultDeviceRead,
      foreignReadDeviceId,
    );
  }

  /**
   * An explicit target held by another session is refused before admission or any device work, so
   * a non-holder (including an observer-only or sessionless caller) gets the typed code.
   */
  private async assertExplicitTargetAccess(state: TargetResolution): Promise<void> {
    const { name, signal } = state.input;
    const { options } = state.input;
    const { providedDeviceId, sessionUuid } = state;
    options.assertHeldDeviceStart?.(providedDeviceId, sessionUuid, false);
    await assertBindingControlAccess({ ...bindingAccessFor(state), deviceId: providedDeviceId });
    await assertToolControlTargetIdentity(
      { ...bindingAccessFor(state), deviceId: providedDeviceId },
      signal,
    );
    assertToolCallerHoldsDevice(
      name,
      state.readOnly,
      providedDeviceId,
      sessionUuid,
      state.autolockEnabled,
    );
    if (providedDeviceId && !sessionUuid) {
      options.assertHeldDeviceStart?.(providedDeviceId, sessionUuid);
    }

    logger.info(
      `[ToolRegistry] Tool ${name} called, sessionUuid=${sessionUuid}, daemonInitialized=${defaultDaemonContext.isInitialized()}`,
    );
  }

  /** Resolves the device and platform a session already holds. */
  private resolveSessionDevice(state: TargetResolution): Promise<void> | undefined {
    const { sessionUuid } = state;
    const resolvingSessionManager =
      state.shouldResolveDevice && sessionUuid ? defaultDaemonContext.sessionManager() : undefined;
    const resolvingDevicePool = resolvingSessionManager
      ? defaultDaemonContext.fullDevicePool()
      : undefined;
    if (
      state.shouldResolveDevice &&
      sessionUuid &&
      resolvingSessionManager &&
      resolvingDevicePool
    ) {
      return this.resolveDaemonSessionDevice(
        state,
        sessionUuid,
        resolvingSessionManager,
        resolvingDevicePool,
      );
    }
    if (state.shouldResolveDevice && sessionUuid) {
      // Direct mode (--no-proxy): DaemonState is not initialized, so the
      // session-based branch above never runs. Recover the acquired device and
      // its platform from the direct-session registry (#5893) so a sessionUuid
      // is sufficient on its own — without this, a client that omits `platform`
      // (now optional) with both platforms connected falls through to
      // ensureDeviceReady("either", undefined) and hits an ambiguity error.
      this.adoptDirectSessionDevice(state, sessionUuid);
    } else if (sessionUuid) {
      logger.warn(`[ToolRegistry] SessionUuid provided but DaemonState not initialized!`);
    }
    return undefined;
  }

  private async resolveDaemonSessionDevice(
    state: TargetResolution,
    sessionUuid: string,
    sessionManager: NonNullable<ReturnType<typeof defaultDaemonContext.sessionManager>>,
    devicePool: NonNullable<ReturnType<typeof defaultDaemonContext.fullDevicePool>>,
  ): Promise<void> {
    const { name, signal } = state.input;
    const { execution, readSession, providedDeviceId } = state;
    logger.info(`[ToolRegistry] Entering session-based device assignment for ${sessionUuid}`);
    if (!readSession) {
      refuseControlCallBeforeAdmission(name, providedDeviceId, sessionUuid);
    }
    // A terminal ID keeps its durable TerminalSessionError. Only an ID that
    // was live during daemon restart can reach context creation without a
    // live session; never-issued IDs are rejected before assignment.
    const admittedSession =
      readSession ??
      (await sessionManager.admitIssuedSessionForAutomation(sessionUuid, execution, { signal }));
    if (execution && !readSession) {
      // Only an admitted control call's end is session use (#10824, #10964).
      executionTracker.markSessionAdmitted(execution.executionId);
    }
    assertSessionDeviceRouting(
      name,
      providedDeviceId,
      sessionUuid,
      admittedSession?.assignedDevice,
      admittedSession?.platform,
    );
    await this.assertAdmittedSessionHeld(state, sessionUuid, admittedSession);
    const context = await createToolExecutionContext(
      sessionUuid,
      sessionManager,
      devicePool,
      toolContextSessionOptions(state),
      {
        execution,
        admittedSession,
        // #6069: defense-in-depth. On this path `admitIssuedSessionForAutomation`
        // above already partitions every state, so this flag rejects nothing
        // admit does not already reject HERE. It exists so the pool-minting
        // primitive itself refuses to mint a never-issued id.
        requireIssuedSession: true,
        signal,
      },
    );
    assertSessionDeviceRouting(
      name,
      providedDeviceId,
      sessionUuid,
      context.deviceId,
      context.devicePlatform,
    );
    if (context.deviceId && !providedDeviceId) {
      state.providedDeviceId = context.deviceId;
      logger.info(`[ToolRegistry] Resolved device from session: ${state.providedDeviceId}`);
    }
    if (context.devicePlatform) {
      state.platform = context.devicePlatform;
    }
  }

  private async assertAdmittedSessionHeld(
    state: TargetResolution,
    sessionUuid: string,
    admittedSession: Awaited<ReturnType<typeof admitReadSession>>,
  ): Promise<void> {
    const { options } = state.input;
    if (!admittedSession || !options.assertHeldDeviceStart) {
      return;
    }
    options.assertHeldDeviceStart(admittedSession.assignedDevice || undefined, sessionUuid, false);
    await assertBindingControlAccess({
      ...bindingAccessFor(state),
      deviceId: admittedSession.assignedDevice || state.providedDeviceId,
    });
    options.assertHeldDeviceStart(admittedSession.assignedDevice || undefined, sessionUuid);
  }

  private adoptDirectSessionDevice(state: TargetResolution, sessionUuid: string): void {
    const directSession = resolveDirectSessionDevice(sessionUuid);
    if (!directSession) {
      throw new DirectSessionNotActiveError(sessionUuid);
    }
    if (state.providedDeviceId && state.providedDeviceId !== directSession.device.deviceId) {
      throw new DeviceOutsideBoundSessionError(
        sessionUuid,
        directSession.device,
        { deviceId: state.providedDeviceId },
        `${state.input.name} deviceId '${state.providedDeviceId}' does not match session '${sessionUuid}' device '${directSession.device.deviceId}'. ` +
          "Omit deviceId to target the session's device.",
      );
    }
    if (!state.providedDeviceId) {
      state.providedDeviceId = directSession.device.deviceId;
      logger.info(
        `[ToolRegistry] Resolved device from direct session ${sessionUuid}: ${state.providedDeviceId}`,
      );
      state.platform = directSession.device.platform;
    }
  }

  /** Resolves the device this call runs on, or answers early from the read-only device path. */
  private resolveDevice(state: TargetResolution): Promise<ExecutionTargetContext | undefined> {
    const { name } = state.input;
    if (!state.shouldResolveDevice) {
      logger.info(`[ToolRegistry] ${name}: Skipping device resolution.`);
      return Promise.resolve(undefined);
    }
    const { sessionUuid, providedDeviceId } = state;
    const sessionPool =
      sessionUuid && providedDeviceId ? defaultDaemonContext.devicePool() : undefined;
    if (sessionPool && providedDeviceId) {
      return this.resolvePooledSessionDevice(state, sessionPool, providedDeviceId).then(
        () => undefined,
      );
    }
    return this.resolveLegacyDevice(state);
  }

  /**
   * Daemon session path: device already resolved via createToolExecutionContext. Construct
   * BootedDevice directly to avoid mutating global DeviceReadiness state.
   */
  private async resolvePooledSessionDevice(
    state: TargetResolution,
    sessionPool: NonNullable<ReturnType<typeof defaultDaemonContext.devicePool>>,
    providedDeviceId: string,
  ): Promise<void> {
    const pooledDevice = sessionPool.getDevice(providedDeviceId);
    const device: BootedDevice = {
      deviceId: providedDeviceId,
      name: pooledDevice?.name ?? providedDeviceId,
      platform: resolveSessionDevicePlatform(
        pooledDevice?.platform,
        state.platform,
        providedDeviceId,
      ),
      iosVersion: pooledDevice?.iosVersion,
    };
    state.device = await this.hydrateDisplays(
      state,
      device,
      `${pooledDevice?.incarnation ?? "unknown"}:${pooledDevice?.avdName ?? device.name}`,
    );
    logger.info(
      `[ToolRegistry] ${state.input.name}: Using session-resolved device ${state.device.deviceId}`,
    );
  }

  private async hydrateDisplays(
    state: TargetResolution,
    resolvedDevice: BootedDevice,
    identityToken: string,
  ): Promise<BootedDevice> {
    try {
      return await this.displayInventory.hydrate(resolvedDevice, identityToken, state.input.signal);
    } catch (error) {
      this.log.warn(
        `[ToolRegistry] Display inventory unavailable for ${resolvedDevice.deviceId}: ${error}`,
        error,
      );
      return resolvedDevice;
    }
  }

  /**
   * Legacy single-agent path or no session: use DeviceReadiness (may set global state). Readiness
   * acts on the device it selects (CtrlProxy setup, the current-device pin, settings), so a call
   * without a deviceId is checked against the device it would land on first: a refused call
   * leaves the holder's device untouched (#10828).
   */
  private async resolveLegacyDevice(
    state: TargetResolution,
  ): Promise<ExecutionTargetContext | undefined> {
    const { name, deviceReadiness } = state.input;
    const { providedDeviceId, platform } = state;
    let readinessTarget = providedDeviceId;
    if (!providedDeviceId && defaultDaemonContext.isInitialized()) {
      readinessTarget = await predictReadinessTarget(
        platform,
        deviceReadiness,
        state.getConnectedPlatforms,
        state.deviceConnectionId,
      );
    }
    const heldRead = await this.heldReadTarget(state, readinessTarget);
    if (heldRead.early) {
      return heldRead.early;
    }
    readinessTarget = heldRead.readinessTarget;
    await this.assertReadinessTargetAccess(state, readinessTarget);
    logger.info(
      `[ToolRegistry] ${name}: Resolving device for platform=${platform}, providedDeviceId=${providedDeviceId}`,
    );
    const readinessResult = await this.ensureLegacyReadiness(
      state,
      heldRead.runningReadTarget?.deviceId ?? providedDeviceId,
      readinessTarget,
    );
    if (readinessResult.watched) {
      return readinessResult.watched;
    }
    const readyDevice = readinessResult.device;
    const { execution } = state;
    if (
      readinessTarget &&
      execution &&
      !state.readOnly &&
      readinessTarget !== readyDevice.deviceId
    ) {
      // Control readiness settled elsewhere: the post-resolution check marks that device.
      executionTracker.unmarkSessionlessDeviceUse(execution.executionId, readinessTarget);
    }
    // Discovery re-stamps observedAt; the serial/UDID stays stable until
    // the daemon's removal/release hooks invalidate this device.
    state.device = await this.hydrateDisplays(state, readyDevice, readyDevice.deviceId);
    logger.info(`[ToolRegistry] ${name}: Using device ${state.device.deviceId}`);
    return undefined;
  }

  private ensureLegacyReadiness(
    state: TargetResolution,
    deviceId: string | undefined,
    readinessTarget: string | undefined,
  ) {
    const { options, signal } = state.input;
    const { sessionUuid, readOnly } = state;
    return ensureReadTargetOrWatch(
      state.input,
      state.platform,
      deviceId,
      {
        sessionId: sessionUuid,
        connectionId: state.deviceConnectionId,
        // A read never writes settings on a device it does not hold, with one exception: readiness needed to answer the read.
        // (owner decision 2026-10-12, #11964)
        intent: readOnly && !sessionUuid ? "read" : undefined,
        skipCtrlProxyDownload: serverConfig.isSkipCtrlProxyDownloadEnabled(),
        readiness: declaredDeviceReadiness(state),
        signal,
        getConnectedPlatforms: state.getConnectedPlatforms,
      },
      options.sessionlessDeviceRead ?? this.defaultDeviceRead,
      readinessTarget,
    );
  }

  /**
   * A sessionless read that would land on a held device (its explicit deviceId, or the device
   * readiness would select) watches it through the read-only path: no readiness, pin or settings
   * work on the holder's device (#10830, #10970). The holder may also be a managed broker binding
   * or another daemon (#11641). Check the raw id before discovery: a broker binding may know only
   * the AVD name, and a held serial needs no discovery scan.
   */
  private async heldReadTarget(
    state: TargetResolution,
    initialReadinessTarget: string | undefined,
  ): Promise<{
    early?: ExecutionTargetContext;
    readinessTarget: string | undefined;
    runningReadTarget?: BootedDevice;
  }> {
    const { options } = state.input;
    const read = options.sessionlessDeviceRead ?? this.defaultDeviceRead;
    if (await this.isInitialReadTargetHeld(state, initialReadinessTarget)) {
      return {
        early: await resolveSessionlessDeviceRead(state.input, read, initialReadinessTarget!),
        readinessTarget: initialReadinessTarget,
      };
    }
    return this.explicitReadTargets(state, read, initialReadinessTarget);
  }

  /** A sessionless explicit-device read: its running alias, or a late holder, answers it. */
  private async explicitReadTargets(
    state: TargetResolution,
    read: SessionlessDeviceRead,
    initialReadinessTarget: string | undefined,
  ): Promise<{
    early?: ExecutionTargetContext;
    readinessTarget: string | undefined;
    runningReadTarget?: BootedDevice;
  }> {
    const { args } = state.input;
    const { sessionUuid, providedDeviceId, platform, readOnly } = state;
    const sessionlessExplicitRead = readOnly && !sessionUuid && providedDeviceId;
    const runningReadMatch = sessionlessExplicitRead
      ? await findRunningExplicitReadTarget(
          state.input,
          read,
          platform,
          state.getConnectedPlatforms,
          state.runningReadAlreadyChecked,
        )
      : undefined;
    const runningReadTarget = runningReadMatch?.device;
    const readinessTarget = runningReadTarget?.deviceId ?? initialReadinessTarget;
    // Discovery awaits: recheck the given identity and any running alias, even on absence.
    const lateHeldReadTarget = sessionlessExplicitRead
      ? await findHeldReadIdentity(
          state.input,
          [providedDeviceId, readinessTarget ?? providedDeviceId],
          args.platform,
        )
      : undefined;
    if (lateHeldReadTarget) {
      return {
        early: await resolveSessionlessDeviceRead(
          state.input,
          read,
          lateHeldReadTarget,
          runningReadMatch?.fromListing ? runningReadTarget : undefined,
        ),
        readinessTarget,
      };
    }
    return { readinessTarget, runningReadTarget };
  }

  /**
   * A read never writes settings on a device it does not hold, with one exception: readiness
   * needed to answer the read. (owner decision 2026-10-12, #11964)
   */
  private isInitialReadTargetHeld(
    state: TargetResolution,
    readinessTarget: string | undefined,
  ): Promise<boolean> {
    const { name, args, signal } = state.input;
    if (!state.readOnly || state.sessionUuid || !readinessTarget) {
      return Promise.resolve(false);
    }
    return isSessionlessReadTargetHeld(
      name,
      {
        deviceId: readinessTarget,
        platform: args.platform,
        now: (state.input.timer ?? defaultTimer).now(),
      },
      signal,
    );
  }

  /**
   * Check and mark in one turn, before readiness: a session acquiring the target while readiness
   * runs cancels this call, and readiness stops at its next device step (#10905). A read is marked
   * for its readiness phase only (#10970); once ready it watches.
   */
  private async assertReadinessTargetAccess(
    state: TargetResolution,
    readinessTarget: string | undefined,
  ): Promise<void> {
    const { name, options, signal } = state.input;
    const { sessionUuid, providedDeviceId, readOnly, execution } = state;
    if (readinessTarget !== providedDeviceId) {
      options.assertHeldDeviceStart?.(readinessTarget, sessionUuid, false);
      await assertBindingControlAccess({
        ...bindingAccessFor(state),
        deviceId: readinessTarget,
        remedy: !providedDeviceId
          ? "This call named no device and the device it would use is driven by another AutoMobile daemon: pass the deviceId of a device this daemon may drive, or acquire one with getAndroid/getApple and pass its sessionUuid."
          : undefined,
      });
      await assertToolControlTargetIdentity(
        { ...bindingAccessFor(state), deviceId: readinessTarget },
        signal,
      );
    }
    assertToolCallerHoldsDevice(
      name,
      readOnly,
      readinessTarget,
      sessionUuid,
      state.autolockEnabled,
    );
    options.assertHeldDeviceStart?.(readinessTarget, sessionUuid);
    if (readinessTarget && execution && !sessionUuid && !readOnly) {
      executionTracker.markSessionlessDeviceUse(execution.executionId, readinessTarget);
    }
  }

  /** The resolved target too: a call without a deviceId can land on a held device. */
  private async assertResolvedDeviceAccess(state: TargetResolution): Promise<void> {
    const { name, options, signal } = state.input;
    const { device, sessionUuid, readOnly, execution } = state;
    if (device && device.deviceId !== state.providedDeviceId) {
      options.assertHeldDeviceStart?.(device.deviceId, sessionUuid, false);
      await assertBindingControlAccess({
        ...bindingAccessFor(state),
        deviceId: device.deviceId,
        platform: device.platform,
      });
      await assertToolControlTargetIdentity(
        {
          ...bindingAccessFor(state),
          deviceId: device.deviceId,
          platform: device.platform,
          device,
        },
        signal,
      );
    }
    assertToolCallerHoldsDevice(
      name,
      readOnly,
      device?.deviceId,
      sessionUuid,
      state.autolockEnabled,
    );
    if (device) {
      options.assertHeldDeviceStart?.(device.deviceId, sessionUuid);
    }
    if (device && execution && !sessionUuid && !readOnly) {
      // Admitted on a device no session holds: a session acquiring it from here on cancels this
      // call, which may not keep driving the new holder's device (#10829).
      executionTracker.markSessionlessDeviceUse(execution.executionId, device.deviceId);
    }
  }

  /** Bind the session to the device's CtrlProxyClient for multi-agent NavigationGraphManager isolation. */
  private bindCtrlProxySession(state: TargetResolution): void {
    const { device, sessionUuid } = state;
    if (!device || !sessionUuid) {
      return;
    }
    try {
      if (device.platform === "android") {
        AndroidCtrlProxyClient.getInstance(device).bindSession(sessionUuid);
      } else if (device.platform === "ios") {
        IOSCtrlProxyClient.getInstance(device).bindSession(sessionUuid);
      }
    } catch (error) {
      this.log.debug(
        `[ToolRegistry] Best-effort CtrlProxy session bind skipped for ${state.input.name}: ${error}`,
      );
    }
  }

  private async enforceSessionUuidForMultipleDevices(input: {
    platform: SomePlatform;
    connectionId?: string;
    sessionUuid: string | undefined;
    providedDeviceId: string | undefined;
    deviceReadiness: DeviceReadiness;
    signal: AbortSignal | undefined;
    getConnectedPlatforms: () => Promise<ConnectedPlatformScan>;
    readOnly: boolean;
  }): Promise<void> {
    const { platform, sessionUuid, providedDeviceId, deviceReadiness, signal } = input;
    const { getConnectedPlatforms } = input;
    if (sessionUuid || providedDeviceId) {
      return;
    }

    signal?.throwIfAborted();
    const scan = await getConnectedPlatforms();
    const connectedPlatforms = scan.devices;
    const explicitPin = this.getValidExplicitPin(deviceReadiness, scan, input.connectionId);
    if (this.hasActiveDeviceForNamedPlatform(platform, explicitPin)) {
      return;
    }
    const detectedPlatforms = new Set(connectedPlatforms.map((device) => device.platform));
    // Mixed-platform ambiguity belongs to ensureDeviceReady, including its
    // intentional setActiveDevice/current-device bypass (#5870).
    if (platform === "either" && detectedPlatforms.size > 1) {
      return;
    }

    const candidatePlatform = platform === "either" ? connectedPlatforms[0]?.platform : platform;
    if (!candidatePlatform) {
      return;
    }

    const candidateCount = connectedPlatforms.filter(
      (device) => device.platform === candidatePlatform,
    ).length;
    if (candidateCount <= 1) {
      return;
    }

    throw multipleDevicesError(
      candidatePlatform,
      input.readOnly,
      connectedPlatforms.filter((device) => device.platform === candidatePlatform),
    );
  }

  private hasActiveDeviceForNamedPlatform(
    platform: SomePlatform,
    explicitPin: BootedDevice | undefined,
  ): boolean {
    return Boolean(explicitPin && platform !== "either" && explicitPin.platform === platform);
  }

  private getValidExplicitPin(
    deviceReadiness: DeviceReadiness,
    scan: ConnectedPlatformScan,
    connectionId?: string,
  ): BootedDevice | undefined {
    const explicitPin = deviceReadiness.getExplicitDevicePin(connectionId);
    if (!explicitPin) {
      return undefined;
    }
    if (
      scan.devices.some(
        (device) =>
          device.deviceId === explicitPin.deviceId && device.platform === explicitPin.platform,
      )
    ) {
      return explicitPin;
    }
    if (isScanAuthoritativeFor(scan, explicitPin)) {
      // Proven device absence invalidates that device's pins on every connection.
      deviceReadiness.clearExplicitDevicePin(explicitPin.deviceId);
      return undefined;
    }
    return explicitPin;
  }

  private resolveImplicitAutolockSession(
    platform: SomePlatform,
    sessionUuid: string | undefined,
    providedDeviceId: string | undefined,
    mcpSessionId: string | undefined,
    execution: import("../../daemon/sessionManager").SessionExecutionMetadata | undefined,
    autolockEnabled: boolean,
  ): string | undefined {
    if (sessionUuid) {
      return undefined;
    }
    const devicePool = autolockEnabled ? defaultDaemonContext.devicePool() : undefined;
    if (!devicePool) {
      return undefined;
    }

    const platformFilter = platform === "android" || platform === "ios" ? platform : undefined;
    const sessionId = devicePool.resolveAutolockSessionForMcpSession(
      mcpSessionId,
      platformFilter,
      execution,
      providedDeviceId,
    );
    if (!sessionId) {
      return undefined;
    }

    if (!providedDeviceId) {
      return sessionId;
    }

    const session = defaultDaemonContext.sessionManager()?.findSession(sessionId);
    return session?.assignedDevice === providedDeviceId ? sessionId : undefined;
  }

  private async enforceSessionUuidForAutolock({
    platform,
    connectionId,
    sessionUuid,
    providedDeviceId,
    deviceReadiness,
    signal,
    getConnectedPlatforms,
    autolockEnabled,
    readOnly,
  }: {
    platform: SomePlatform;
    connectionId?: string;
    sessionUuid: string | undefined;
    providedDeviceId: string | undefined;
    deviceReadiness: DeviceReadiness;
    signal: AbortSignal | undefined;
    getConnectedPlatforms: () => Promise<ConnectedPlatformScan>;
    autolockEnabled: boolean;
    readOnly: boolean;
  }): Promise<void> {
    if (!autolockEnabled) {
      return;
    }
    if (sessionUuid || providedDeviceId) {
      return;
    }

    signal?.throwIfAborted();
    const scan = await getConnectedPlatforms();
    const connectedPlatforms = scan.devices;
    const explicitPin = this.getValidExplicitPin(deviceReadiness, scan, connectionId);
    if (explicitPin && (platform === "either" || platform === explicitPin.platform)) {
      return;
    }
    const candidates =
      platform === "either"
        ? connectedPlatforms
        : connectedPlatforms.filter((device) => device.platform === platform);

    if (candidates.length <= 1) {
      return;
    }

    // A read never requires a session (#10970, #11351): it is asked for a deviceId only.
    if (readOnly) {
      throw new AmbiguousDeviceTargetError(
        "Device pool autolock is enabled and multiple devices are available. " +
          "Provide a deviceId to target a specific device.",
        candidates,
      );
    }
    throw new AmbiguousDeviceTargetError(
      "Device pool autolock is enabled and multiple devices are available. " +
        "Call getAndroid or getApple first from this MCP session, or provide the returned sessionUuid (or a deviceId) to target a specific device.",
      candidates,
    );
  }
}
