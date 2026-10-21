import type { ExecutionTargetInput } from "./executionTarget";
import type { ConnectedPlatformScan } from "../../daemon/readiness/DeviceReadiness";
import { BootedDevice, SomePlatform } from "../../models";
import { admitReadSession } from "./readTarget";
import { captureAutolockPolicy } from "../../daemon/deviceAutolockPolicy";
import { INTERNAL_NO_DIFF_PARAM } from "../../daemon/internalToolCall";
import { executionTracker } from "../../daemon/executionTracker";
import { resolveTransportDeadlineMs } from "../transportDeadline";
import { deviceConnectionIdFor } from "../deviceConnectionId";

/** The mutable facts one normal target resolution accumulates as its steps run. */
export interface TargetResolution {
  readonly input: ExecutionTargetInput;
  readonly runningReadAlreadyChecked: boolean;
  readonly autolockEnabled: boolean;
  readonly getConnectedPlatforms: (refresh?: boolean) => Promise<ConnectedPlatformScan>;
  readonly shouldResolveDevice: boolean;
  readonly baseSessionUuid: string | undefined;
  readonly mcpSessionId: string | undefined;
  readonly deviceConnectionId: string | undefined;
  readonly execution: import("../../daemon/sessionManager").SessionExecutionMetadata | undefined;
  readonly keepScreenAwake: boolean | undefined;
  /**
   * Internal tool-to-tool marker (#3053 / #3087): internal callers (PlanExecutor steps,
   * navigation/setup replays) set this via `markInternalToolCall` so a plan/navigation step's
   * finalized envelope is never diffed/stripped and never advances the agent-facing diff baseline
   * (a future internal `.observation.viewHierarchy` reader stays correct).
   */
  readonly internalCall: boolean;
  providedDeviceId: string | undefined;
  sessionUuid: string | undefined;
  platform: SomePlatform;
  readOnly: boolean;
  readSession: Awaited<ReturnType<typeof admitReadSession>>;
  device: BootedDevice | undefined;
}

export function createTargetResolution(
  input: ExecutionTargetInput,
  runningReadAlreadyChecked: boolean,
): TargetResolution {
  const autolockEnabled = captureAutolockPolicy();
  const { args, options, deviceReadiness, signal } = input;
  signal?.throwIfAborted();
  let connectedPlatformsPromise: Promise<ConnectedPlatformScan> | undefined;
  const getConnectedPlatforms = (refresh = false): Promise<ConnectedPlatformScan> => {
    if (refresh) {
      connectedPlatformsPromise = undefined;
    }
    connectedPlatformsPromise ??= deviceReadiness.detectConnectedPlatformsWithStatus(signal, {
      platform: args.platform,
    });
    return connectedPlatformsPromise;
  };
  // Extract internal routing params from args.
  // If you add new injected params here, also update INTERNAL_PARAMS in
  // src/features/record/ToolCallRecorder.ts so they are stripped from recordings.
  return {
    input,
    runningReadAlreadyChecked,
    autolockEnabled,
    getConnectedPlatforms,
    shouldResolveDevice: options.shouldEnsureDevice ? options.shouldEnsureDevice(args) : true,
    baseSessionUuid: args.sessionUuid,
    mcpSessionId: typeof args.__mcpSessionId === "string" ? args.__mcpSessionId : undefined,
    deviceConnectionId: deviceConnectionIdFor(args),
    execution: executionMetadataFromArgs(args),
    keepScreenAwake: typeof args.keepScreenAwake === "boolean" ? args.keepScreenAwake : undefined,
    internalCall: args[INTERNAL_NO_DIFF_PARAM] === true,
    providedDeviceId: args.deviceId,
    sessionUuid: args.sessionUuid,
    // Extract platform from args, default to "either" for backward compatibility
    platform: args.platform || "either",
    readOnly: false,
    readSession: undefined,
    device: undefined,
  };
}

function executionMetadataFromArgs(args: any): TargetResolution["execution"] {
  if (typeof args.__executionId !== "string" || typeof args.__executionStartTime !== "number") {
    return undefined;
  }
  return {
    executionId: args.__executionId,
    startTime: args.__executionStartTime,
    // The forwarded start is a wall-clock stamp; session expiry judges the session-clock
    // one the tracker took when the call started (#11290).
    sessionClockStartTime: executionTracker.getSessionClockStartTime(args.__executionId),
  };
}

export function bindingAccessFor(state: TargetResolution) {
  return {
    toolName: state.input.name,
    readOnly: state.readOnly,
    sessionUuid: state.sessionUuid,
    mcpSessionId: state.mcpSessionId,
    platform: state.input.args.platform,
  };
}

export function toolContextSessionOptions(state: TargetResolution) {
  const { args } = state.input;
  const { platform } = state;
  return {
    keepScreenAwake: state.keepScreenAwake,
    requestDeadlineMs: resolveTransportDeadlineMs(args),
    platform: platform === "android" || platform === "ios" ? platform : undefined,
    // #6227: the persisted/daemon-session path must honor a tool's declared
    // deviceReadiness the same way the legacy/no-session path below does
    // (ensureDeviceReady's `readiness` option), so a `booted`-only tool
    // (e.g. listApps, videoRecordingTools) doesn't pay for (or fail on)
    // full CtrlProxy accessibility-service setup.
    deviceReadiness: declaredDeviceReadiness(state),
  };
}

export function declaredDeviceReadiness(state: TargetResolution) {
  const { args, options } = state.input;
  return typeof options.deviceReadiness === "function"
    ? options.deviceReadiness(args)
    : options.deviceReadiness;
}
