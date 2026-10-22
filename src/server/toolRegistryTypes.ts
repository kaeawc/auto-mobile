import type { ZodType } from "zod/v4";
import type { DeviceMutationRecording } from "./deviceMutationRecording";
export type { DeviceMutationRecording };
import type { McpToolCallResult } from "./toolCallDispatch";
import type { DeviceReadOnlyArgShape } from "../daemon/deviceReadOnlyArgShapes";

import { type ToolTransportRecovery } from "../daemon/toolTransportRecovery";

import { DeviceReadiness, type DeviceReadinessLevel } from "../daemon/readiness/DeviceReadiness";
import { ActionableError, BootedDevice, SomePlatform } from "../models";

import { type DisplayInventoryProvider } from "../devices/DisplayInventoryProvider";

import {
  type DeviceObservationAccess,
  type ConfirmStoppedReadTarget,
} from "./deviceObservationAccess";

import { ToolCallRepository } from "../db/toolCallRepository";
import type { Environment } from "../daemon/poolConfig";

import { type Timer } from "../utils/SystemTimer";

import type { SessionToolSelectionService } from "../features/toolSelection/SessionToolSelectionService";

import { ExecutionTargetResolver } from "./pipeline/executionTarget";
import { AuditRunner } from "./pipeline/audit";
import { NavigationToolCallRecorder } from "./pipeline/navigationRecording";
import { AfterToolCallHandler } from "./pipeline/afterToolCall";
import { PlanLifecycleManager } from "./pipeline/planLifecycle";

// Progress notification interface
export interface ProgressCallback {
  (progress: number, total?: number, message?: string): Promise<void>;
}

/**
 * What the pipeline treats a handler's result as once it leaves the registry: an MCP tool result.
 * Handlers themselves resolve to `unknown` (text, image, structured and defined-tool payloads all
 * differ); {@link ToolHandlerResult} is asserted once, at the pipeline's invocation boundary.
 */
export type ToolHandlerResult = McpToolCallResult;

/** A tool's stored (erased) input schema: parsing it yields the wire-shaped argument record. */
export type ToolSchema = ZodType<Record<string, unknown>>;

// Interface for tool handlers
export interface ToolHandler<T = Record<string, unknown>> {
  (args: T, progress?: ProgressCallback, signal?: AbortSignal): Promise<unknown>;
}

// Interface for device-aware tool handlers
export interface DeviceAwareToolHandler<T = Record<string, unknown>> {
  (
    device: BootedDevice,
    args: T,
    progress?: ProgressCallback,
    signal?: AbortSignal,
  ): Promise<unknown>;
}

export interface InternalToolCallOptions {
  forPlan?: boolean;
  sessionUuid?: string;
  targetDevice?: BootedDevice;
  sessionToolSelectionService?: Pick<SessionToolSelectionService, "isEnabled">;
}

export interface InternalToolInvocationContext {
  args: Record<string, unknown>;
  routingSessionUuid?: string;
  toolSelectionProfileUuid?: string;
  sessionToolSelectionService?: Pick<SessionToolSelectionService, "isEnabled">;
}

// Gate reason emitted for `planOnly` tools — hidden from discovery by design,
// expected in plans (so getToolForPlan does not warn about it).
export const PLAN_ONLY_GATE_REASON = "plan-only tool";

// `McpServer.registerTool` requires a per-tool callback, but the SDK dispatcher
// that would call it is replaced by the shared `tools/call` handler (#6545).
// Fail loudly rather than run a tool without the real dispatch's guards.
export async function shadowedSdkToolCallback(): Promise<never> {
  throw new ActionableError(
    "tools/call reached the SDK's per-tool callback; install the shared dispatcher with installToolCallDispatcher (issue #6545)",
  );
}

export interface ToolRegistrationOptions {
  /** Declarative read forms advertised to proxies; a subset of the per-call classifier. */
  deviceReadOnlyArgs?: readonly DeviceReadOnlyArgShape[];
  /** Built-in session default before startup or persisted exact-tool overrides. */
  defaultEnabled?: boolean;
  supportsProgress?: boolean;
  /** Loopback closure recovery: connect only, or replay after ambiguous delivery. */
  transportRecovery?: ToolTransportRecovery;
  debugOnly?: boolean;
  /**
   * Hidden from `tools/list` and discovery (`getAllTools` and
   * `registerWithServer`'s MCP-SDK registration). Still directly callable by
   * name via `tools/call` — for example, `startDevice` is called directly by
   * the session-acquisition flow and CLI despite not being advertised.
   */
  hidden?: boolean;
  outputSchema?: ZodType;
  /** Accept the plan executor's internal coordination namespace. */
  acceptsPlanLockNamespace?: boolean;
  /**
   * MCP Apps UI resource this tool renders through (issue #4669). When set, the
   * tool definition advertises it as `_meta.ui.resourceUri`; additive and
   * ignored by non-Apps hosts.
   */
  appUiResourceUri?: string;
}

/** Options for a plain (non-device) tool. */
export interface PlainToolOptions<T = Record<string, unknown>> extends ToolRegistrationOptions {
  /**
   * The plain tool's read/control classification (#11107): true for a read, a per-args classifier
   * for a mixed tool, absent for control. A read naming a session is admitted read-only: it never
   * counts as session activity (owner decision 2026-10-09). Enumerated by
   * `test/lint/toolReadControlClassification.test.ts`.
   */
  readOnly?: boolean | ((args: T) => boolean);
}

/** Resolves a device for a read without acquiring, readying or changing a device session. */
export interface SessionlessDeviceRead {
  resolve(deviceId: string, signal?: AbortSignal, platform?: SomePlatform): Promise<BootedDevice>;
  findRunning?(
    deviceId: string,
    signal?: AbortSignal,
    platform?: SomePlatform,
    confirmStopped?: ConfirmStoppedReadTarget,
  ): Promise<BootedDevice | undefined>;
  assertAuthorized(device: BootedDevice): void;
}

/** Behaviour a tool declares on its definition instead of the pipeline keying on its name (#11825). */
export interface ToolTraits {
  /** Always ends an app's process (not `appLifecycle` `killBackgrounded`, the state-preserving kill). */
  stopsApp?: boolean;
  /** Replaces a process without naming the app in its args (`installApp`): all remembered screens go. */
  replacesProcess?: boolean;
  /**
   * A UI interaction that may cause in-app navigation; excludes lifecycle tools (not replayable
   * paths). It also answers the device's `systemAlerts` policy before dispatch (#14106).
   */
  recordsNavigation?: boolean;
  /** Read-only: nothing happened on the device, so an artifact write failure stays loud. */
  loudArtifactWrites?: boolean;
  /**
   * An action whose embedded observation defaults to the compact skeleton (#5872, #5886). Declared
   * only by tools that also expose the `raw`/`project` opt-out, so the default never becomes a
   * one-way door (`test/server/skeletonDefaultDrift.test.ts`).
   */
  defaultsToSkeletonObservation?: boolean;
  /** Writes caller-supplied files, from a host `sourcePath` or inline content (recorder skips host paths). */
  stagesFiles?: boolean;
  /**
   * A successful call changes device or app state a plan can replay, so the recorder keeps it as a
   * step. Infrastructure tools (device management, recording meta-tools, read-only queries) leave it
   * unset; `test/features/record/ToolCallRecorderCoverage.test.ts` requires every registered tool
   * to declare it or be excluded there with a reason (#9928).
   */
  planRelevant?: boolean;
}

/** Spread into the options of a tool that declares {@link ToolTraits.defaultsToSkeletonObservation}. */
export const SKELETON_OBSERVATION = { defaultsToSkeletonObservation: true } as const;

/** Spread into the options of a tool that declares {@link ToolTraits.planRelevant}. */
export const PLAN_RELEVANT = { planRelevant: true } as const;

/** Both {@link PLAN_RELEVANT} and {@link SKELETON_OBSERVATION}, for the many tools that declare the pair. */
export const PLAN_SKELETON = { ...PLAN_RELEVANT, ...SKELETON_OBSERVATION } as const;

/** Just the trait fields of a registration's options, for the registered tool and the recorder. */
export function pickToolTraits(options: ToolTraits): ToolTraits {
  const {
    stopsApp,
    replacesProcess,
    recordsNavigation,
    loudArtifactWrites,
    defaultsToSkeletonObservation,
    stagesFiles,
    planRelevant,
  } = options;
  return {
    stopsApp,
    replacesProcess,
    recordsNavigation,
    loudArtifactWrites,
    defaultsToSkeletonObservation,
    stagesFiles,
    planRelevant,
  };
}

export interface DeviceAwareToolOptions<T = Record<string, unknown>>
  extends ToolRegistrationOptions, ToolTraits {
  shouldEnsureDevice?: (args: T) => boolean;
  /** Opt-in start admission: holder check before broker bindings, held-session requirement after. */
  assertHeldDeviceStart?: (
    deviceId: string | undefined,
    sessionUuid: string | undefined,
    requireHeldSession?: boolean,
  ) => void;
  /**
   * The tool only watches the device (#10730: watching is allowed on any device and is not use),
   * so a caller that does not hold a device another session holds may still run it. Every other
   * device-aware tool is refused on such a device (`device_owned_by_other_session`). A function
   * decides per call (sqlQuery: only a read-only statement watches).
   *
   * A sessionless call that would land on a device another session holds runs through the
   * read-only device path (`sessionlessDeviceRead`, or the registry's default): the target is
   * resolved from the booted-device list, with no readiness (no CtrlProxy setup, no current-device
   * pin, no settings writes), no navigation recording and no audit (#10830).
   * A read never writes settings on a device it does not hold, with one exception: readiness needed to answer the read.
   * (owner decision 2026-10-12, #11964)
   */
  deviceReadOnly?: boolean | ((args: T) => boolean);
  /** Read an explicit device id without acquiring or changing a device session. */
  sessionlessDeviceRead?: SessionlessDeviceRead;
  deviceReadiness?: DeviceReadinessLevel | ((args: T) => DeviceReadinessLevel);
  nonDeviceHandler?: ToolHandler<T>;
  embeddedSdkOnly?: boolean;
  planExecutable?: boolean;
  // Hide from normal MCP discovery (tools/list) unconditionally, but keep the
  // tool runnable inside plans (pair with planExecutable). For coordination
  // primitives an interactive agent can never sensibly call directly.
  planOnly?: boolean;
}

export interface ToolListingOptions {
  includeUnavailable?: boolean;
  /** Override the process default for one connection-scoped tools/list response. */
  suppressOutputSchema?: boolean;
}

export interface CachedToolDefinitionSchemas {
  inputSchema: Record<string, unknown>;
  outputSchemasByRuntimeFlags: Map<string, Record<string, unknown> | undefined>;
}

// Interface for a registered tool
export interface RegisteredTool extends ToolTraits {
  name: string;
  description: string;
  schema: ToolSchema;
  handler: ToolHandler;
  defaultEnabled: boolean;
  defaultDeclared: boolean;
  supportsProgress?: boolean;
  transportRecovery?: ToolTransportRecovery;
  requiresDevice?: boolean;
  deviceAwareHandler?: DeviceAwareToolHandler;
  /** The tool's `deviceReadOnly` classification for one argument set (#10969 read lane). */
  isDeviceReadOnlyCall?: (args: unknown) => boolean;
  debugOnly?: boolean;
  hidden?: boolean;
  embeddedSdkOnly?: boolean;
  planExecutable?: boolean;
  planOnly?: boolean;
  acceptsPlanLockNamespace?: boolean;
  outputSchema?: ZodType;
  appUiResourceUri?: string;
  /**
   * The tool's read/control classification (#10965; plain tools' `readOnly`, #11107): true for a
   * read, a per-args classifier for a mixed tool, absent for control. Enumerated by
   * `test/lint/toolReadControlClassification.test.ts`. Only `true` (a read for every call) is
   * advertised as `_meta["automobile/deviceReadOnly"]`, so a proxy can forward such reads without
   * a session (#10971). Mixed tools may advertise conservative declarative read forms via
   * `_meta["automobile/deviceReadOnlyArgs"]`; SQL text remains classifier-only.
   */
  deviceReadOnly?: boolean | ((args: Record<string, unknown>) => boolean);
  deviceReadOnlyArgs?: readonly DeviceReadOnlyArgShape[];
}

/** Keep both registration paths' advertised read metadata consistent. */
export function deviceReadOnlyMetadata(
  deviceReadOnly: RegisteredTool["deviceReadOnly"],
  deviceReadOnlyArgs: readonly DeviceReadOnlyArgShape[] | undefined,
): Pick<RegisteredTool, "deviceReadOnly" | "deviceReadOnlyArgs"> {
  return { deviceReadOnly, deviceReadOnlyArgs };
}

/**
 * Whether a tool declares an `outputSchema`. The single source of truth for the
 * `structuredContent` gate (issues #2899 + #2759): both the wire-boundary strip
 * (`stripToolResultStructuredContent` in `index.ts`) and the `tools/list`
 * advertisement (`getToolDefinitions`) key off this so the wire result and the
 * advertised schema can never disagree. `outputSchema` is always either a Zod
 * schema object or `undefined`.
 */
export function toolHasOutputSchema(tool: Pick<RegisteredTool, "outputSchema">): boolean {
  return tool.outputSchema !== undefined && tool.outputSchema !== null;
}

/** The collaborators a test may read and swap on the ToolRegistry singleton. */
export interface ToolRegistryCollaborators {
  deviceReadiness: DeviceReadiness;
  toolCallRepository: Pick<ToolCallRepository, "recordToolCall">;
  timer: Timer;
  navigationToolCallRecorder: NavigationToolCallRecorder;
  afterToolCall: AfterToolCallHandler;
}

export interface ToolRegistryPipelineOverrides {
  env?: Environment;
  executionTargetResolver?: ExecutionTargetResolver;
  displayInventory?: DisplayInventoryProvider;
  /** Booted-device listing for the read-only device path (#10830). */
  deviceReadAccess?: DeviceObservationAccess;
  auditRunner?: AuditRunner;
  mutationRecording?: DeviceMutationRecording;
  afterToolCall?: AfterToolCallHandler;
  planLifecycleManager?: PlanLifecycleManager;
}

/**
 * Copy an advertised array-field schema with `enum` applied to its items.
 * Preserves the field's own description and constraints; only the item
 * vocabulary is added.
 */
export function withItemsEnum(
  field: Record<string, unknown> | undefined,
  values: string[],
): Record<string, unknown> {
  return {
    ...field,
    items: {
      ...(field?.items as Record<string, unknown> | undefined),
      enum: values,
    },
  };
}
