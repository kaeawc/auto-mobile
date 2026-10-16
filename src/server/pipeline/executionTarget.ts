import { AmbiguousDeviceTargetError } from "../ambiguousDeviceTargetRefusal";
import {
  DeviceSessionManager,
  type ConnectedPlatformScan,
  isScanAuthoritativeFor,
} from "../../devices/DeviceSessionManager";
import { ActionableError, BootedDevice, SomePlatform } from "../../models";
import { serverConfig } from "../../utils/ServerConfig";
import {
  defaultDisplayInventoryProvider,
  type DisplayInventoryProvider,
} from "../../devices/DisplayInventoryProvider";
import { AndroidCtrlProxyClient } from "../../features/observe/android";
import { IOSCtrlProxyClient } from "../../features/observe/ios";
import { logger, type Logger } from "../../utils/logger";
import { DaemonState } from "../../daemon/daemonState";
import {
  defaultDeviceObservationAccess,
  sessionlessDeviceReadFor,
  type DeviceObservationAccess,
} from "../deviceObservationAccess";
import { createToolExecutionContext } from "../ToolExecutionContext";
import { resolveTransportDeadlineMs } from "../formTools";
import { getDeviceLabelMap } from "../deviceLabelMapping";
import { resolveDirectSessionDevice } from "../directSessionDeviceRegistry";
import { captureAutolockPolicy } from "../../daemon/deviceAutolockPolicy";
import { defaultTimer, type Timer } from "../../utils/SystemTimer";
import { INTERNAL_NO_DIFF_PARAM } from "../internalToolCall";
import { getToolSelectionContext } from "../../features/toolSelection/toolSelectionContext";
import { executionTracker } from "../executionTracker";
import { type SessionlessDeviceRead, type DeviceAwareToolOptions } from "../toolRegistry";
import {
  markDeviceCallKind,
  assertSessionDeviceRouting,
  refuseControlCallBeforeAdmission,
  assertToolControlTargetIdentity,
  assertToolCallerHoldsDevice,
  assertBindingControlAccess,
  predictReadinessTarget,
  assertDeviceReadRouting,
} from "./deviceCallDispatch";
import {
  resolveSessionlessDeviceRead,
  findHeldReadIdentity,
  ensureReadTargetOrWatch,
  findExplicitReadTarget,
  findRunningExplicitReadTarget,
  isDeviceReadOnlyCall,
  multipleDevicesError,
  isSessionlessReadTargetHeld,
  foreignDeviceRead,
  gatedReadSessionDevice,
  admitReadSession,
  lateReadSessionDevice,
  canonicalizeCallDeviceId,
  adoptHolderConnectionSession,
} from "./readTarget";

export interface ExecutionTargetInput {
  name: string;
  args: any;
  options: DeviceAwareToolOptions;
  deviceSessionManager: DeviceSessionManager;
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
    const ended = DaemonState.getInstance()
      .getSessionManager()
      .terminalAnswerForEndedSession(sessionUuid, executionId);
    if (ended) {
      throw ended;
    }
  }

  constructor(
    private readonly logger: Logger = logger,
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
    const autolockEnabled = captureAutolockPolicy();
    const { name, args, options, deviceSessionManager, signal } = input;
    signal?.throwIfAborted();
    let connectedPlatformsPromise: Promise<ConnectedPlatformScan> | undefined;
    const getConnectedPlatforms = (refresh = false): Promise<ConnectedPlatformScan> => {
      if (refresh) {
        connectedPlatformsPromise = undefined;
      }
      connectedPlatformsPromise ??= deviceSessionManager.detectConnectedPlatformsWithStatus(
        signal,
        {
          platform: args.platform,
        },
      );
      return connectedPlatformsPromise;
    };
    const shouldResolveDevice = options.shouldEnsureDevice
      ? options.shouldEnsureDevice(args)
      : true;

    // Extract internal routing params from args.
    // If you add new injected params here, also update INTERNAL_PARAMS in
    // src/features/record/ToolCallRecorder.ts so they are stripped from recordings.
    let providedDeviceId = args.deviceId;
    const baseSessionUuid = args.sessionUuid;
    const deviceLabel = typeof args.device === "string" ? args.device : undefined;
    const declaredDeviceLabels = Array.isArray(args.devices) ? args.devices : undefined;
    const mcpSessionId = typeof args.__mcpSessionId === "string" ? args.__mcpSessionId : undefined;
    const execution =
      typeof args.__executionId === "string" && typeof args.__executionStartTime === "number"
        ? {
            executionId: args.__executionId,
            startTime: args.__executionStartTime,
            // The forwarded start is a wall-clock stamp; session expiry judges the session-clock
            // one the tracker took when the call started (#11290).
            sessionClockStartTime: executionTracker.getSessionClockStartTime(args.__executionId),
          }
        : undefined;
    // Internal tool-to-tool marker (#3053 / #3087): internal callers (PlanExecutor
    // steps, navigation/setup replays) set this via `markInternalToolCall` so a
    // plan/navigation step's finalized envelope is never diffed/stripped and never
    // advances the agent-facing diff baseline (a future internal
    // `.observation.viewHierarchy` reader stays correct).
    const internalCall = args[INTERNAL_NO_DIFF_PARAM] === true;
    let sessionUuid = baseSessionUuid;
    const keepScreenAwake =
      typeof args.keepScreenAwake === "boolean" ? args.keepScreenAwake : undefined;

    if (deviceLabel && shouldResolveDevice) {
      if (!DaemonState.getInstance().isInitialized()) {
        throw new ActionableError("Device labels require an active daemon session.");
      }
      if (!baseSessionUuid) {
        throw new ActionableError(
          `Device label '${deviceLabel}' requires sessionUuid to be provided.`,
        );
      }

      const deviceLabelMap = getDeviceLabelMap(baseSessionUuid);
      if (deviceLabelMap) {
        const mappedSession = deviceLabelMap[deviceLabel];
        if (!mappedSession) {
          const available = Object.keys(deviceLabelMap);
          const suffix = available.length > 0 ? ` Available labels: ${available.join(", ")}` : "";
          throw new ActionableError(`Unknown device label '${deviceLabel}'.${suffix}`);
        }
        sessionUuid = mappedSession;
      } else if (name === "executePlan" && declaredDeviceLabels?.includes(deviceLabel)) {
        sessionUuid = baseSessionUuid;
      } else {
        // The base's end ends its labels (#11640): a step whose base has ended, or is past its
        // idle deadline, fails with the base's terminal release, not as an unallocated label.
        this.refuseEndedPlanBase(baseSessionUuid, execution?.executionId);
        throw new ActionableError(
          `Device label '${deviceLabel}' is not allocated. Provide a devices list to executePlan before using device labels.`,
        );
      }

      if (providedDeviceId) {
        logger.warn(
          `[ToolRegistry] Ignoring deviceId because device label '${deviceLabel}' was provided.`,
        );
        providedDeviceId = undefined;
      }
    }

    // Extract platform from args, default to "either" for backward compatibility
    let platform: SomePlatform = args.platform || "either";

    if (shouldResolveDevice) {
      const implicitSessionUuid = this.resolveImplicitAutolockSession(
        platform,
        sessionUuid,
        providedDeviceId,
        mcpSessionId,
        execution,
        autolockEnabled,
      );
      if (implicitSessionUuid) {
        sessionUuid = implicitSessionUuid;
        if (execution) {
          executionTracker.setResolvedAutolockSessionUuid(
            execution.executionId,
            implicitSessionUuid,
          );
        }
        logger.info(
          `[ToolRegistry] Resolved implicit autolock session for MCP session ${mcpSessionId}: ${implicitSessionUuid}`,
        );
      }
      if (sessionUuid) {
        // Handlers must use the resolved label or implicit session, not the
        // caller's base session, so session-scoped state stays on the device
        // that ToolRegistry selected.
        args.sessionUuid = sessionUuid;
      }
      await this.enforceSessionUuidForMultipleDevices({
        platform,
        sessionUuid,
        providedDeviceId,
        deviceSessionManager,
        signal,
        getConnectedPlatforms,
        readOnly: isDeviceReadOnlyCall(options, args),
      });
      await this.enforceSessionUuidForAutolock({
        platform,
        sessionUuid,
        providedDeviceId,
        deviceSessionManager,
        signal,
        getConnectedPlatforms,
        autolockEnabled,
        readOnly: isDeviceReadOnlyCall(options, args),
      });
    }

    const readOnly = isDeviceReadOnlyCall(options, args);
    if (execution) {
      markDeviceCallKind(execution.executionId, name, readOnly);
    }
    const gatedReadDeviceId =
      readOnly && shouldResolveDevice ? gatedReadSessionDevice(sessionUuid) : undefined;
    if (gatedReadDeviceId) {
      delete args.sessionUuid;
      return resolveSessionlessDeviceRead(
        input,
        options.sessionlessDeviceRead ?? this.defaultDeviceRead,
        providedDeviceId ?? gatedReadDeviceId,
      );
    }
    // A read is admitted read-only (#10964): it never refreshes or claims the session, and its end
    // is not use. Only control calls extend a session's idle deadline.
    const readSession =
      readOnly && sessionUuid && shouldResolveDevice
        ? await admitReadSession(sessionUuid, execution)
        : undefined;
    if (readSession === null) {
      // Read-only access never requires a session (#10968): a read carrying an id that names no
      // live device session (an IDE observer session) runs as a sessionless read.
      logger.info(
        `[ToolRegistry] ${name}: ${sessionUuid} is not a live device session; reading sessionlessly`,
      );
      const lateReadDeviceId = providedDeviceId
        ? undefined
        : lateReadSessionDevice(sessionUuid, execution);
      sessionUuid = undefined;
      delete args.sessionUuid;
      if (options.sessionlessDeviceRead && providedDeviceId) {
        // The same contract as a sessionless `observe {deviceId}`: no session, no readiness.
        return resolveSessionlessDeviceRead(input, options.sessionlessDeviceRead, providedDeviceId);
      }
      if (lateReadDeviceId) {
        // A read that named a session still held by earlier work past its idle deadline (#11361)
        // reads that session's device, not whichever device a sessionless call would select.
        return resolveSessionlessDeviceRead(
          input,
          options.sessionlessDeviceRead ?? this.defaultDeviceRead,
          lateReadDeviceId,
        );
      }
    }
    // A read naming another device than its own session's watches that device (#10970): it is
    // not this session's work, so it runs sessionless on the read-only device path.
    const foreignReadDeviceId =
      readOnly && shouldResolveDevice
        ? foreignDeviceRead(sessionUuid, providedDeviceId)
        : undefined;
    if (foreignReadDeviceId) {
      delete args.sessionUuid;
      return resolveSessionlessDeviceRead(
        input,
        options.sessionlessDeviceRead ?? this.defaultDeviceRead,
        foreignReadDeviceId,
      );
    }

    // An explicit target held by another session is refused before admission or any device work,
    // so a non-holder (including an observer-only or sessionless caller) gets the typed code.
    const bindingAccess = {
      toolName: name,
      readOnly,
      sessionUuid,
      mcpSessionId,
      platform: args.platform,
    };
    options.assertHeldDeviceStart?.(providedDeviceId, sessionUuid, false);
    await assertBindingControlAccess({ ...bindingAccess, deviceId: providedDeviceId });
    await assertToolControlTargetIdentity({ ...bindingAccess, deviceId: providedDeviceId }, signal);
    assertToolCallerHoldsDevice(name, readOnly, providedDeviceId, sessionUuid, autolockEnabled);
    if (providedDeviceId && !sessionUuid) {
      options.assertHeldDeviceStart?.(providedDeviceId, sessionUuid);
    }

    logger.info(
      `[ToolRegistry] Tool ${name} called, sessionUuid=${sessionUuid}, daemonInitialized=${DaemonState.getInstance().isInitialized()}`,
    );

    // If session UUID provided, resolve device from session
    if (shouldResolveDevice && sessionUuid && DaemonState.getInstance().isInitialized()) {
      logger.info(`[ToolRegistry] Entering session-based device assignment for ${sessionUuid}`);
      const sessionManager = DaemonState.getInstance().getSessionManager();
      const devicePool = DaemonState.getInstance().getDevicePool();
      if (!readSession) {
        refuseControlCallBeforeAdmission(name, providedDeviceId, sessionUuid);
      }
      // A terminal ID keeps its durable TerminalSessionError. Only an ID that
      // was live during daemon restart can reach context creation without a
      // live session; never-issued IDs are rejected before assignment.
      const admittedSession =
        readSession ??
        (await sessionManager.admitIssuedSessionForAutomation(sessionUuid, execution));
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
      if (admittedSession && options.assertHeldDeviceStart) {
        options.assertHeldDeviceStart(
          admittedSession.assignedDevice || undefined,
          sessionUuid,
          false,
        );
        await assertBindingControlAccess({
          ...bindingAccess,
          deviceId: admittedSession.assignedDevice || providedDeviceId,
        });
        options.assertHeldDeviceStart(admittedSession.assignedDevice || undefined, sessionUuid);
      }
      const context = await createToolExecutionContext(
        sessionUuid,
        sessionManager,
        devicePool,
        {
          keepScreenAwake,
          requestDeadlineMs: resolveTransportDeadlineMs(args),
          platform: platform === "android" || platform === "ios" ? platform : undefined,
          // #6227: the persisted/daemon-session path must honor a tool's declared
          // deviceReadiness the same way the legacy/no-session path below does
          // (ensureDeviceReady's `readiness` option), so a `booted`-only tool
          // (e.g. listApps, videoRecordingTools) doesn't pay for (or fail on)
          // full CtrlProxy accessibility-service setup.
          deviceReadiness:
            typeof options.deviceReadiness === "function"
              ? options.deviceReadiness(args)
              : options.deviceReadiness,
        },
        execution,
        admittedSession,
        // #6069: defense-in-depth. On this path `admitIssuedSessionForAutomation`
        // above already partitions every state (throws for a never-issued id,
        // returns a live session so the fallback is skipped, returns undefined
        // only for a persisted non-terminal row — restart recovery — which the
        // createUnseenSession guard also admits), so this flag rejects nothing
        // admit does not already reject HERE. It exists so the pool-minting
        // primitive itself refuses to mint a never-issued id: if a future route
        // reaches createToolExecutionContext for a caller-provided sessionUuid
        // without going through admit, issuance is still enforced. See the PR
        // discussion for why the reported #6069 bound-connection bypass could not
        // be reproduced through any current public route in-harness.
        true,
        signal,
      );
      assertSessionDeviceRouting(
        name,
        providedDeviceId,
        sessionUuid,
        context.deviceId,
        context.devicePlatform,
      );
      if (context.deviceId && !providedDeviceId) {
        providedDeviceId = context.deviceId;
        logger.info(`[ToolRegistry] Resolved device from session: ${providedDeviceId}`);
      }
      if (context.devicePlatform) {
        platform = context.devicePlatform;
      }
    } else if (shouldResolveDevice && sessionUuid) {
      // Direct mode (--no-proxy): DaemonState is not initialized, so the
      // session-based branch above never runs. Recover the acquired device and
      // its platform from the direct-session registry (#5893) so a sessionUuid
      // is sufficient on its own — without this, a client that omits `platform`
      // (now optional) with both platforms connected falls through to
      // ensureDeviceReady("either", undefined) and hits an ambiguity error.
      const directSession = resolveDirectSessionDevice(sessionUuid);
      assertDeviceReadRouting(args, options, directSession?.device.deviceId);
      if (!directSession) {
        logger.warn(`[ToolRegistry] SessionUuid provided but DaemonState not initialized!`);
      } else if (!providedDeviceId) {
        providedDeviceId = directSession.device.deviceId;
        logger.info(
          `[ToolRegistry] Resolved device from direct session ${sessionUuid}: ${providedDeviceId}`,
        );
        // Adopt the session's platform only when we also adopted its device. An
        // explicitly-provided deviceId names the target unambiguously, so leave
        // platform as "either" and let ensureDeviceReady infer it from the id —
        // narrowing to the session's platform here would send an explicit
        // cross-platform deviceId to the wrong platform's search and fail
        // (mirrors the #5870 deviceId-resolves-platform rule).
        platform = directSession.device.platform;
      }
    } else if (sessionUuid) {
      logger.warn(`[ToolRegistry] SessionUuid provided but DaemonState not initialized!`);
    }

    let device: BootedDevice | undefined;
    if (shouldResolveDevice) {
      const hydrateDisplays = async (
        resolvedDevice: BootedDevice,
        identityToken: string,
      ): Promise<BootedDevice> => {
        try {
          return await this.displayInventory.hydrate(resolvedDevice, identityToken, signal);
        } catch (error) {
          this.logger.warn(
            `[ToolRegistry] Display inventory unavailable for ${resolvedDevice.deviceId}: ${error}`,
            error,
          );
          return resolvedDevice;
        }
      };
      if (sessionUuid && DaemonState.getInstance().isInitialized() && providedDeviceId) {
        // Daemon session path: device already resolved via createToolExecutionContext.
        // Construct BootedDevice directly to avoid mutating global DeviceSessionManager state.
        const resolvedPlatform =
          platform === "android" || platform === "ios" ? platform : "android";
        const pooledDevice = DaemonState.getInstance().getDevicePool().getDevice(providedDeviceId);
        device = {
          deviceId: providedDeviceId,
          name: pooledDevice?.name ?? providedDeviceId,
          platform: pooledDevice?.platform ?? resolvedPlatform,
          iosVersion: pooledDevice?.iosVersion,
        };
        device = await hydrateDisplays(
          device,
          `${pooledDevice?.incarnation ?? "unknown"}:${pooledDevice?.avdName ?? device.name}`,
        );
        logger.info(`[ToolRegistry] ${name}: Using session-resolved device ${device.deviceId}`);
      } else {
        // Legacy single-agent path or no session: use DeviceSessionManager (may set global state).
        // Readiness acts on the device it selects (CtrlProxy setup, the current-device pin,
        // settings), so a call without a deviceId is checked against the device it would land
        // on first: a refused call leaves the holder's device untouched (#10828).
        let readinessTarget = providedDeviceId;
        if (!providedDeviceId && DaemonState.getInstance().isInitialized()) {
          readinessTarget = await predictReadinessTarget(
            platform,
            deviceSessionManager,
            getConnectedPlatforms,
          );
        }
        // A sessionless read that would land on a held device (its explicit deviceId, or the device
        // readiness would select) watches it through the read-only path: no readiness, pin or
        // settings work on the holder's device (#10830, #10970). The holder may also be a managed
        // broker binding or another daemon (#11641). Check the raw id before discovery: a broker binding may know
        // only the AVD name, and a held serial needs no discovery scan.
        // A read never writes settings on a device it does not hold, with one exception: readiness needed to answer the read.
        // (owner decision 2026-10-12, #11964)
        if (
          readOnly &&
          !sessionUuid &&
          readinessTarget &&
          (await isSessionlessReadTargetHeld(
            name,
            {
              deviceId: readinessTarget,
              platform: args.platform,
              now: (input.timer ?? defaultTimer).now(),
            },
            signal,
          ))
        ) {
          return resolveSessionlessDeviceRead(
            input,
            options.sessionlessDeviceRead ?? this.defaultDeviceRead,
            readinessTarget,
          );
        }
        const runningReadMatch =
          readOnly && !sessionUuid && providedDeviceId
            ? await findRunningExplicitReadTarget(
                input,
                options.sessionlessDeviceRead ?? this.defaultDeviceRead,
                platform,
                getConnectedPlatforms,
                runningReadAlreadyChecked,
              )
            : undefined;
        const runningReadTarget = runningReadMatch?.device;
        readinessTarget = runningReadTarget?.deviceId ?? readinessTarget;
        // Discovery awaits: recheck the given identity and any running alias, even on absence.
        const lateHeldReadTarget =
          readOnly && !sessionUuid && providedDeviceId
            ? await findHeldReadIdentity(
                input,
                [providedDeviceId, readinessTarget ?? providedDeviceId],
                args.platform,
              )
            : undefined;
        if (lateHeldReadTarget) {
          return resolveSessionlessDeviceRead(
            input,
            options.sessionlessDeviceRead ?? this.defaultDeviceRead,
            lateHeldReadTarget,
            runningReadMatch?.fromListing ? runningReadTarget : undefined,
          );
        }
        // Check and mark in one turn, before readiness: a session acquiring the target while
        // readiness runs cancels this call, and readiness stops at its next device step (#10905).
        // A read is marked for its readiness phase only (#10970); once ready it watches.
        if (readinessTarget !== providedDeviceId) {
          options.assertHeldDeviceStart?.(readinessTarget, sessionUuid, false);
          await assertBindingControlAccess({
            ...bindingAccess,
            deviceId: readinessTarget,
            remedy: !providedDeviceId
              ? "This call named no device and the device it would use is driven by another AutoMobile daemon: pass the deviceId of a device this daemon may drive, or acquire one with getAndroid/getApple and pass its sessionUuid."
              : undefined,
          });
          await assertToolControlTargetIdentity(
            { ...bindingAccess, deviceId: readinessTarget },
            signal,
          );
        }
        assertToolCallerHoldsDevice(name, readOnly, readinessTarget, sessionUuid, autolockEnabled);
        options.assertHeldDeviceStart?.(readinessTarget, sessionUuid);
        if (readinessTarget && execution && !sessionUuid && !readOnly) {
          executionTracker.markSessionlessDeviceUse(execution.executionId, readinessTarget);
        }
        logger.info(
          `[ToolRegistry] ${name}: Resolving device for platform=${platform}, providedDeviceId=${providedDeviceId}`,
        );
        const readinessResult = await ensureReadTargetOrWatch(
          input,
          platform,
          runningReadTarget?.deviceId ?? providedDeviceId,
          {
            sessionId: sessionUuid,
            // A read never writes settings on a device it does not hold, with one exception: readiness needed to answer the read.
            // (owner decision 2026-10-12, #11964)
            intent: readOnly && !sessionUuid ? "read" : undefined,
            skipCtrlProxyDownload: serverConfig.isSkipCtrlProxyDownloadEnabled(),
            readiness:
              typeof options.deviceReadiness === "function"
                ? options.deviceReadiness(args)
                : options.deviceReadiness,
            signal,
            getConnectedPlatforms,
          },
          options.sessionlessDeviceRead ?? this.defaultDeviceRead,
          readinessTarget,
        );
        if (readinessResult.watched) {
          return readinessResult.watched;
        }
        device = readinessResult.device;
        if (readinessTarget && execution && !readOnly && readinessTarget !== device.deviceId) {
          // Control readiness settled elsewhere: the post-resolution check marks that device.
          executionTracker.unmarkSessionlessDeviceUse(execution.executionId, readinessTarget);
        }
        // Discovery re-stamps observedAt; the serial/UDID stays stable until
        // the daemon's removal/release hooks invalidate this device.
        device = await hydrateDisplays(device, device.deviceId);
        logger.info(`[ToolRegistry] ${name}: Using device ${device.deviceId}`);
      }
    } else {
      logger.info(`[ToolRegistry] ${name}: Skipping device resolution.`);
    }

    // The resolved target too: a call without a deviceId can land on a held device.
    if (device && device.deviceId !== providedDeviceId) {
      options.assertHeldDeviceStart?.(device.deviceId, sessionUuid, false);
      await assertBindingControlAccess({
        ...bindingAccess,
        deviceId: device.deviceId,
        platform: device.platform,
      });
      await assertToolControlTargetIdentity(
        { ...bindingAccess, deviceId: device.deviceId, platform: device.platform, device },
        signal,
      );
    }
    assertToolCallerHoldsDevice(name, readOnly, device?.deviceId, sessionUuid, autolockEnabled);
    if (device) {
      options.assertHeldDeviceStart?.(device.deviceId, sessionUuid);
    }
    if (device && execution && !sessionUuid && !readOnly) {
      // Admitted on a device no session holds: a session acquiring it from here on cancels this
      // call, which may not keep driving the new holder's device (#10829).
      executionTracker.markSessionlessDeviceUse(execution.executionId, device.deviceId);
    }

    // Bind session to device's CtrlProxyClient for multi-agent NavigationGraphManager isolation
    if (device && sessionUuid) {
      try {
        if (device.platform === "android") {
          AndroidCtrlProxyClient.getInstance(device).bindSession(sessionUuid);
        } else if (device.platform === "ios") {
          IOSCtrlProxyClient.getInstance(device).bindSession(sessionUuid);
        }
      } catch (error) {
        this.logger.debug(
          `[ToolRegistry] Best-effort CtrlProxy session bind skipped for ${name}: ${error}`,
        );
      }
    }

    return {
      args,
      baseSessionUuid,
      device,
      internalCall,
      sessionUuid,
      shouldResolveDevice,
    };
  }

  private async enforceSessionUuidForMultipleDevices(input: {
    platform: SomePlatform;
    sessionUuid: string | undefined;
    providedDeviceId: string | undefined;
    deviceSessionManager: DeviceSessionManager;
    signal: AbortSignal | undefined;
    getConnectedPlatforms: () => Promise<ConnectedPlatformScan>;
    readOnly: boolean;
  }): Promise<void> {
    const { platform, sessionUuid, providedDeviceId, deviceSessionManager, signal } = input;
    const { getConnectedPlatforms } = input;
    if (sessionUuid || providedDeviceId) {
      return;
    }

    signal?.throwIfAborted();
    const scan = await getConnectedPlatforms();
    const connectedPlatforms = scan.devices;
    const explicitPin = this.getValidExplicitPin(deviceSessionManager, scan);
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
    deviceSessionManager: DeviceSessionManager,
    scan: ConnectedPlatformScan,
  ): BootedDevice | undefined {
    const explicitPin = deviceSessionManager.getExplicitDevicePin();
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
      deviceSessionManager.clearExplicitDevicePin(explicitPin.deviceId);
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
    if (!autolockEnabled || !DaemonState.getInstance().isInitialized()) {
      return undefined;
    }

    const platformFilter = platform === "android" || platform === "ios" ? platform : undefined;
    const sessionId = DaemonState.getInstance()
      .getDevicePool()
      .resolveAutolockSessionForMcpSession(
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

    const session = DaemonState.getInstance().getSessionManager().findSession(sessionId);
    return session?.assignedDevice === providedDeviceId ? sessionId : undefined;
  }

  private async enforceSessionUuidForAutolock({
    platform,
    sessionUuid,
    providedDeviceId,
    deviceSessionManager,
    signal,
    getConnectedPlatforms,
    autolockEnabled,
    readOnly,
  }: {
    platform: SomePlatform;
    sessionUuid: string | undefined;
    providedDeviceId: string | undefined;
    deviceSessionManager: DeviceSessionManager;
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
    const explicitPin = this.getValidExplicitPin(deviceSessionManager, scan);
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
