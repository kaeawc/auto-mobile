import { PrototypeHiddenError } from "../../src/features/prototype/prototypeHidden";
import { PrototypeSuspendedError } from "../../src/features/prototype/prototypeSuspended";
import { OrphanRecorderActiveError } from "../../src/server/orphanRecorderRefusal";
import { HostBootAdmissionRegistryError } from "../../src/features/bootAdmission/HostBootAdmissionRegistry";
import { StageSessionDownloadsRefusal } from "../../src/server/downloadsFixtureService";
import { AdbDeviceOfflineError } from "../../src/utils/android-cmdline-tools/AdbDeviceHealth";
import { DeviceLostError } from "../../src/models/DeviceLostError";
import { ManagedSlotConfigError } from "../../src/models/managedSlotConfig";
import { AndroidBootedDeviceDiscoveryIncompleteError } from "../../src/models/BootedDeviceDiscoveryIncompleteError";
import { DeviceShutdownTimeoutError } from "../../src/models/DeviceShutdownTimeoutError";
import { IosHomeLaunchTimeoutError } from "../../src/models/IosHomeLaunchTimeoutError";
import { SharedDaemonNamespaceError } from "../../src/daemon/sharedNamespaceGuard";
import {
  deviceSessionErrorFields,
  DeviceSessionSupersededByRestoreError,
} from "../../src/daemon/deviceSessionResolver";
import { DeviceGestureRecordingStartUnheldError } from "../../src/daemon/deviceGestureRecordingStartAdmission";
import { DaemonHandoffInterruptionError } from "../../src/daemon/daemonHandoffInterruption";
import { DaemonCommandRefusal } from "../../src/daemon/cli/runDaemonCommand";
import { join } from "node:path";
import {
  assertBootCapacityGranted,
  atCapacityDecision,
} from "../../src/features/bootAdmission/BootAdmissionGate";
import {
  DeviceCleanupInProgressError,
  DeviceUnhealthyError,
  DeviceOwnedByOtherDaemonError,
  DeviceShuttingDownError,
  DeviceTransportOfflineError,
  SessionCreationTimeoutError,
  RetryableDeviceAcquisitionError,
  SessionReleasedDuringCreationError,
} from "../../src/daemon/deviceAcquisitionRefusals";
import { IOS_SIM_MAX_BOOTED_ENV } from "../../src/features/iosSimFleet/capacityPolicy";
import { InputDeviceOwnedError } from "../../src/daemon/inputDeviceOwnership";
import {
  MCP_OVERLOAD_ERROR_CODE,
  MCP_QUEUE_TIMEOUT_ERROR_CODE,
  McpTimeoutError,
  McpOverloadError,
} from "../../src/daemon/McpTimeoutError";
import {
  DaemonRestartDeferredError,
  DaemonRestartPendingError,
  daemonRestartPendingToolResult,
} from "../../src/daemon/daemonRestartAdmission";
import { SessionRecoveryAssignmentError } from "../../src/models/SessionRecoveryAssignmentError";
import { mcpRequestFailureDetails, strokeAdmissionEndedError } from "../../src/daemon/socketServer";
import { SessionReleasedDuringCallError } from "../../src/daemon/sessionReleasedDuringCall";
import {
  daemonResponseError,
  DaemonHandshakeMismatchError,
  DaemonBoundSessionLostError,
  DaemonShuttingDownError,
  DaemonUnavailableError,
  DaemonRequestNotDeliveredError,
} from "../../src/daemon/client";
import {
  DeviceControlTransportError,
  LoopbackMcpConnectionError,
} from "../../src/daemon/deviceControlTransportFailure";
import { ToolUnavailableError } from "../../src/server/toolUnavailableError";
import type { DaemonResponse } from "../../src/daemon/types";
import { ViewerReadOnlyError } from "../../src/daemon/streamSubscriptionPolicy";
import {
  AndroidAvdIdentityUnresolvedError,
  AndroidDeviceIdentityUnresolvedError,
  AndroidAvdIdentityConflictError,
  DeviceBootTimeoutError,
} from "../../src/devices/deviceBootService";
import {
  REPLAY_LEASE_EXPIRED_REASON,
  type SessionReleaseReason,
} from "../../src/daemon/releaseReasons";
import { typedTeardownRefusal } from "../../src/server/deviceToolsLifecycle";
import {
  DaemonConnectionSessionReleasedError,
  DaemonAmbiguousSessionSelectorError,
  DaemonAssetVersionMismatchError,
  DaemonBoundSessionExpiredError,
  DaemonBuildMismatchError,
  DaemonSessionStalledError,
  DaemonToolOutcomeUnknownError,
  DaemonToolUnavailableError,
  DaemonVersionMismatchError,
  LifecycleConnectionInFlightError,
} from "../../src/daemon/daemonMcpProxy";
import { daemonShuttingDownMcpOutcome } from "../../src/daemon/daemonShutdownOutcome";
import { deviceAssignedToOtherSessionError } from "../../src/daemon/inputDeviceOwnership";
import {
  SessionNoLongerOwnsDeviceError,
  DaemonSessionCreationRejectedError,
  SessionActivityPersistenceError,
  SessionReleasePersistTimeoutError,
  UnissuedSessionError,
  SessionRecoveryIdentityLossError,
  SessionRebindingError,
  SessionHeldByRecoveryError,
  SessionSuspectError,
  SessionTerminalReleaseInProgressError,
  TerminalSessionError,
} from "../../src/daemon/sessionManager";
import {
  ProvisionDeviceError,
  ProvisionDeviceCreateRejectedError,
} from "../../src/devices/exactDeviceProvisioning";
import {
  DeviceAssignedToManagedSlotError,
  DeviceOutsideManagedSlotsError,
  ManagedSlotDiscoveryIncompleteError,
  ManagedSlotRegistrySchemaUnsupportedError,
  ManagedSlotOwnershipUnconfirmedError,
  ManagedSlotOwnershipLostError,
} from "../../src/daemon/managedSlots/managedSlotRefusal";
import {
  DeviceOutsideBoundSessionError,
  SessionOutsideBoundSessionError,
} from "../../src/server/deviceOutsideBoundSessionRefusal";
import { PlanExecutionInProgressError } from "../../src/server/planExecutionInProgressRefusal";
import { AmbiguousDeviceTargetError } from "../../src/server/ambiguousDeviceTargetRefusal";
import { BootedDeviceDiscoveryIncompleteError } from "../../src/devices/deviceBootService";
import {
  createToolErrorResponse,
  PooledAvdIdentityError,
  ProvisionDeviceRollbackError,
} from "../../src/server/deviceTools";
import { sessionOwnershipLostPayload } from "../../src/server/deviceSessionResult";
import {
  mcpOverloadResult,
  managedEndedPayload,
  managedSlotsFailedToolResult,
  noActiveDeviceSessionResult,
  noActiveDeviceSessionPayload,
  deviceControlTransportFailureResult,
  ambiguousSessionSelectorResult,
} from "../../src/server/proxyServer";
import {
  MANAGED_SLOT_ACQUISITION_OWN_FAILURE_CODES,
  type ManagedSlotAcquisitionOwnFailureCode,
  type ManagedSlotResultEntry,
  type ManagedSlotsFailure,
  type ManagedSlotsResult,
} from "../../src/models/managedSlotsResult";
import { acquisitionFailure } from "../../src/daemon/managedSlots/managedSlotAcquisition";
import {
  MANAGED_SLOT_RECONCILE_FAILURE_CODES,
  failure as reconcileFailure,
} from "../../src/daemon/managedSlots/reconciler";
import {
  DEFAULT_PROVISION_DEVICE_RETRYABILITY,
  type ProvisionDeviceFailureCode,
} from "../../src/devices/exactDeviceProvisioning";
import { AppNotRunningError } from "../../src/models/AppNotRunningError";
import { shapeToolCallError } from "../../src/server/shapeToolCallError";
import { deviceLossOutcomeFromError } from "../../src/server/deviceLossOutcome";
import { logger } from "../../src/utils/logger";

/** How a runner reacts to a refusal; the vocabulary of `expectations.json`. */
export type RefusalDisposition = "wait" | "acquire-new-session" | "retry" | "fail";

/** The MCP tool result the daemon sends for a refusal, as a runner receives it. */
export interface RefusalWireResult {
  isError: true;
  content: { type: "text"; text: string }[];
}

export interface RefusalWireFixture {
  code: string;
  /** The real TypeScript builder the result came from. */
  builder: string;
  result: RefusalWireResult;
}

// import.meta.dir, not fileURLToPath(new URL(...)): the latter yields "\\D:\\a\\..." on Windows Bun.
export const REFUSAL_FIXTURES_DIR = join(import.meta.dir, "..", "fixtures", "refusal-wire");

const SESSION = "11111111-2222-4333-8444-555555555555";
const DEVICE = "emulator-5554";

/** Health refusal variants are built by the real class; no reason-specific wire contract (#12112). */
export function unhealthyRefusal(variant = "bounded"): DeviceUnhealthyError {
  const recovering = variant !== "permanent";
  return new DeviceUnhealthyError(
    [
      {
        deviceId: DEVICE,
        reason: "network-condition",
        recovering,
        ...(recovering && variant !== "unbounded" ? { retryAfterMs: 12863 } : {}),
      },
      ...(variant === "all_candidates"
        ? [{ deviceId: "emulator-5556", reason: "app-cleanup", recovering: false }]
        : []),
    ],
    "Unhealthy devices cannot be assigned: restoration is unresolved.",
  );
}

export function shapedRefusalResult(error: unknown): RefusalWireResult {
  return shaped(error);
}

// Only a collection call records constructors; ordinary helper use cannot leak coverage between files.
let drivenClasses: Set<Error["constructor"]> | undefined;

function driven<T>(error: T): T {
  if (error instanceof Error) {
    drivenClasses?.add(error.constructor);
  }
  return error;
}

/** Own constructors only: a subclass fixture never covers its base class. Rebuilt on every call. */
export function fixtureDrivenErrorClasses(): ReadonlySet<Error["constructor"]> {
  const previous = drivenClasses;
  const collected = new Set<Error["constructor"]>();
  drivenClasses = collected;
  try {
    buildRefusalWireFixtures();
    buildRefusalSurfaceFixtures();
    for (const fixture of EXTERNALLY_CAPTURED_SURFACE_FIXTURES) {
      collected.add(fixture.errorClass);
    }
    return collected;
  } finally {
    drivenClasses = previous;
  }
}

function shaped(error: unknown): RefusalWireResult {
  driven(error);
  // shapeToolCallError logs every error it shapes; the fixtures are not failures.
  const original = logger.error;
  logger.error = () => {};
  try {
    return shapeToolCallError(error, { toolName: "executePlan", source: "MCP" });
  } finally {
    logger.error = original;
  }
}

/** The error the boot admission gate throws for an Android boot refused at capacity. */
function bootCapacityRefusal(platform: "android" | "ios" = "android"): unknown {
  const ios = platform === "ios";
  const decision = atCapacityDecision(2, { maxBooted: 2, source: "default" }, 5_000, {
    noun: ios ? "simulator" : "emulator",
    envName: ios ? IOS_SIM_MAX_BOOTED_ENV : "AUTO_MOBILE_MAX_BOOTED",
    externalDevices: [ios ? "9A1B2C3D-0000-4000-8000-000000000001" : "emulator-5560"],
  });
  try {
    assertBootCapacityGranted({ decision: decision! }, platform, ios ? "simulator" : "emulator");
  } catch (error) {
    return error;
  }
  throw new Error("assertBootCapacityGranted did not refuse a full platform");
}

function jsonResult(payload: unknown): RefusalWireResult {
  return { isError: true, content: [{ type: "text", text: JSON.stringify(payload) }] };
}

function provisionFailure(error: BootedDeviceDiscoveryIncompleteError): RefusalWireResult {
  driven(error);
  return provisionEnvelope(
    new ProvisionDeviceError("discovery_incomplete", error.message, error.retryable),
  );
}

function provisionEnvelope(failure: ProvisionDeviceError): RefusalWireResult {
  driven(failure);
  // The provisionDevice failure envelope (`provisionDeviceErrorResponse` in
  // deviceToolsProvisioning) around the real ProvisionDeviceError.
  return createToolErrorResponse(failure.code, failure.message, {
    error: { code: failure.code, message: failure.message, retryable: failure.retryable },
  });
}

type FixtureEntry = readonly [string, string, () => RefusalWireResult];

/** A failed `simctl` inventory: the iOS booted-device list could not be proven complete. */
function iosInventoryIncomplete(): BootedDeviceDiscoveryIncompleteError {
  return new BootedDeviceDiscoveryIncompleteError("ios", {
    code: "failed",
    message: "simctl list timed out",
    retryable: true,
  });
}

/** Recovery of a persisted session failed for a reason that ends the session (#11391). */
const RECOVERY_LOSSES: readonly (readonly [string, () => SessionRecoveryIdentityLossError])[] = [
  [
    "owned_by_other_daemon",
    () =>
      new SessionRecoveryIdentityLossError(
        SESSION,
        { platform: "android", stableDeviceId: "Pixel_8_API_35", deviceId: DEVICE },
        "owned-by-other-daemon",
        { deviceId: DEVICE, ownerPid: 4242 },
      ),
  ],
  [
    "target_absent",
    () =>
      new SessionRecoveryIdentityLossError(
        SESSION,
        { platform: "android", stableDeviceId: "Pixel_8_API_35", deviceId: DEVICE },
        "target-absent",
      ),
  ],
  [
    "owned_by_other_daemon_unknown_pid",
    () =>
      new SessionRecoveryIdentityLossError(
        SESSION,
        { platform: "android", stableDeviceId: "Pixel_8_API_35", deviceId: DEVICE },
        "owned-by-other-daemon",
        { deviceId: DEVICE, ownerPid: undefined },
      ),
  ],
];

/** Releases that cut an in-flight call (#11322, #11381, #11429), one per reason family. */
const CUT_RELEASE_REASONS: readonly (readonly [string, SessionReleaseReason])[] = [
  ["heartbeat_timeout", "heartbeat-timeout"],
  ["cli_idle_timeout", "cli-idle-timeout"],
  ["owner_disconnected", "owner-disconnected"],
  ["managed_slot_ownership_lost", "managed-slot-ownership-lost"],
  ["explicit_release", "explicit-release"],
];

/** Pinned to requireRemainingMcpForwardBudget by socketServerForwardBudgetTimeoutVsOverload.test.ts. */
export function overloadRefusalError(): McpOverloadError {
  return new McpOverloadError(
    "Daemon overloaded while handling observe: spent 950ms waiting in queue, leaving 50ms of the 1000ms deadline. Retry after 250ms.",
    {
      code: "daemon_overloaded",
      retryable: true,
      retryAfterMs: 250,
      reason: "insufficient_forward_budget",
      queueWaitMs: 950,
      remainingTimeoutMs: 50,
    },
  );
}

/** One entry per wire code, each produced by the builder the daemon itself calls. */
const BUILDERS: readonly FixtureEntry[] = [
  [
    "target_identity_unresolved",
    "AndroidAvdIdentityUnresolvedError via shapeToolCallError",
    () => shaped(new AndroidAvdIdentityUnresolvedError("Pixel_8_API_35", [DEVICE])),
  ],
  [
    "target_identity_unresolved.device",
    "AndroidDeviceIdentityUnresolvedError via shapeToolCallError",
    () => shaped(new AndroidDeviceIdentityUnresolvedError(DEVICE)),
  ],
  [
    "orphan_recorder_active",
    "OrphanRecorderActiveError via shapeToolCallError",
    () => shaped(new OrphanRecorderActiveError(DEVICE, ["startup-orphan"])),
  ],
  [
    "plan_execution_in_progress",
    "PlanExecutionInProgressError via shapeToolCallError",
    () => shaped(new PlanExecutionInProgressError("session")),
  ],
  [
    "ambiguous_device_target",
    "AmbiguousDeviceTargetError via shapeToolCallError",
    () =>
      shaped(
        new AmbiguousDeviceTargetError(
          "Device pool autolock is enabled and multiple devices are available. " +
            "Call getAndroid or getApple first from this MCP session, or provide the returned sessionUuid (or a deviceId) to target a specific device.",
          [
            { deviceId: DEVICE, platform: "android" },
            { deviceId: "emulator-5556", platform: "android" },
          ],
        ),
      ),
  ],
  [
    "session_released_during_creation",
    "SessionReleasedDuringCreationError via shapeToolCallError",
    () => shaped(new SessionReleasedDuringCreationError(SESSION)),
  ],
  [
    "timeout.iosHomeLaunch",
    "IosHomeLaunchTimeoutError via shapeToolCallError",
    () => shaped(new IosHomeLaunchTimeoutError("SpringBoard launch exhausted the Home budget")),
  ],
  [
    "provision_device.platform_command_failed.create_rejected",
    "ProvisionDeviceCreateRejectedError via createToolErrorResponse",
    () => provisionEnvelope(new ProvisionDeviceCreateRejectedError("Platform rejected creation")),
  ],
  [
    "daemon_overloaded",
    "McpOverloadError literal pinned to the real throw site by socketServerForwardBudgetTimeoutVsOverload.test.ts; mcpRequestFailureDetails -> daemonResponseError -> mcpOverloadResult",
    () => {
      const error = daemonResponseError({
        id: "overload-fixture",
        ...socketFrame(overloadRefusalError()),
      });
      if (!(error instanceof McpOverloadError)) {
        throw new Error("daemonResponseError did not preserve McpOverloadError");
      }
      const { isError, content } = mcpOverloadResult(driven(error));
      if (isError !== true) {
        throw new Error("mcpOverloadResult did not return an error result");
      }
      return {
        isError,
        content: content.map((block) => {
          if (block.type !== "text") {
            throw new Error("mcpOverloadResult returned non-text content");
          }
          return { type: "text" as const, text: block.text };
        }),
      };
    },
  ],
  [
    "device_owned_by_other_session",
    "deviceAssignedToOtherSessionError via shapeToolCallError",
    () => shaped(deviceAssignedToOtherSessionError(DEVICE, "holder-session", SESSION)),
  ],
  [
    "prototype_hidden",
    "PrototypeHiddenError via shapeToolCallError",
    () => shaped(new PrototypeHiddenError("app_layer_window_hidden")),
  ],
  [
    "prototype_suspended",
    "PrototypeSuspendedError via shapeToolCallError",
    () => shaped(new PrototypeSuspendedError()),
  ],
  [
    "app_not_running",
    "AppNotRunningError via shapeToolCallError",
    () => shaped(new AppNotRunningError("com.example.app", DEVICE)),
  ],
  [
    "device_owned_by_other_daemon",
    "DeviceOwnedByOtherDaemonError via shapeToolCallError",
    () => shaped(new DeviceOwnedByOtherDaemonError(DEVICE, 4242)),
  ],
  [
    "device_cleanup_in_progress",
    "DeviceCleanupInProgressError via shapeToolCallError",
    () => shaped(new DeviceCleanupInProgressError(DEVICE, 1_000)),
  ],
  ...(
    [
      ["device_unhealthy", "bounded"],
      ["device_unhealthy.recovering_unbounded", "unbounded"],
      ["device_unhealthy.permanent", "permanent"],
      ["device_unhealthy.all_candidates", "all_candidates"],
    ] as const
  ).map(([stem, variant]): readonly [string, string, () => RefusalWireResult] => [
    stem,
    "DeviceUnhealthyError via shapeToolCallError",
    () => shaped(unhealthyRefusal(variant)),
  ]),
  [
    "device_shutting_down",
    "DeviceShuttingDownError via shapeToolCallError",
    () => shaped(new DeviceShuttingDownError(DEVICE, "and cannot be assigned")),
  ],
  [
    "device_offline",
    "DeviceTransportOfflineError via shapeToolCallError",
    () => shaped(new DeviceTransportOfflineError(DEVICE, "offline")),
  ],
  [
    "session_creation_timeout",
    "SessionCreationTimeoutError via shapeToolCallError",
    () => shaped(new SessionCreationTimeoutError(SESSION, DEVICE, 30_000)),
  ],
  [
    "capacity_exhausted",
    "assertBootCapacityGranted via shapeToolCallError",
    () => shaped(bootCapacityRefusal()),
  ],
  [
    "discovery_incomplete",
    "ProvisionDeviceError via createToolErrorResponse",
    () => provisionFailure(new BootedDeviceDiscoveryIncompleteError("android", undefined)),
  ],
  [
    "session_ownership_lost",
    "sessionOwnershipLostPayload",
    () =>
      jsonResult(
        sessionOwnershipLostPayload({
          message: `Session ownership lost for ${SESSION}: heartbeat_timeout.`,
          sessionUuid: SESSION,
          reason: "heartbeat_timeout",
        }),
      ),
  ],
  [
    "capacity_exhausted.ios",
    "assertBootCapacityGranted via shapeToolCallError",
    () => shaped(bootCapacityRefusal("ios")),
  ],
  [
    "discovery_incomplete.ios",
    "ProvisionDeviceError via createToolErrorResponse",
    () => provisionFailure(iosInventoryIncomplete()),
  ],
  [
    "device_outside_managed_slots.tool",
    "DeviceOutsideManagedSlotsError via shapeToolCallError",
    () => shaped(new DeviceOutsideManagedSlotsError("startDevice", "tool", "0123abcd")),
  ],
  ...RECOVERY_LOSSES.map(([name, error]): FixtureEntry => [
    `session_ownership_lost.recovery_${name}`,
    "SessionRecoveryIdentityLossError via shapeToolCallError",
    () => shaped(error()),
  ]),
  ...CUT_RELEASE_REASONS.map(([name, reason]): FixtureEntry => [
    `session_ownership_lost.released_${name}`,
    "SessionReleasedDuringCallError via shapeToolCallError",
    () => shaped(new SessionReleasedDuringCallError(SESSION, reason)),
  ]),
  [
    "no_active_device_session",
    "noActiveDeviceSessionResult",
    () =>
      noActiveDeviceSessionResult(
        driven(new DaemonConnectionSessionReleasedError("heartbeat_timeout")),
      ) as RefusalWireResult,
  ],
  [
    "no_active_device_session.released_cleanup_expired",
    "noActiveDeviceSessionResult",
    () =>
      noActiveDeviceSessionResult(
        driven(new DaemonConnectionSessionReleasedError("cleanup-expired")),
      ) as RefusalWireResult,
  ],
  [
    "no_active_device_session.replay_lease_expired",
    "noActiveDeviceSessionResult",
    () =>
      noActiveDeviceSessionResult(
        driven(new DaemonConnectionSessionReleasedError(REPLAY_LEASE_EXPIRED_REASON)),
      ) as RefusalWireResult,
  ],
  [
    "ambiguous_session_selector",
    "ambiguousSessionSelectorResult",
    () =>
      ambiguousSessionSelectorResult(
        driven(
          new DaemonAmbiguousSessionSelectorError("android", [
            { sessionUuid: SESSION, deviceId: DEVICE },
            { sessionUuid: "second-android-session", deviceId: "emulator-5556" },
          ]),
        ),
      ) as RefusalWireResult,
  ],
  [
    "managed_execution_ended",
    "managedEndedPayload",
    () =>
      jsonResult(
        managedEndedPayload(readyManagedSlotsResult(SESSION), SESSION, "heartbeat_timeout"),
      ),
  ],
  [
    "session_terminal_release_in_progress",
    "SessionTerminalReleaseInProgressError via shapeToolCallError",
    () =>
      shaped(
        new SessionTerminalReleaseInProgressError(
          SESSION,
          DEVICE,
          "is being terminally released from its device; use a new session UUID",
        ),
      ),
  ],
  [
    "session_no_longer_owns_device",
    "SessionNoLongerOwnsDeviceError via shapeToolCallError",
    () => shaped(new SessionNoLongerOwnsDeviceError(SESSION, DEVICE)),
  ],
  [
    "session_rebinding",
    "SessionRebindingError via shapeToolCallError",
    () => shaped(new SessionRebindingError(SESSION)),
  ],
  [
    "session_held_by_recovery",
    "SessionHeldByRecoveryError via shapeToolCallError",
    () => shaped(new SessionHeldByRecoveryError(SESSION, DEVICE)),
  ],
  [
    "daemon_session_suspect",
    "SessionSuspectError via shapeToolCallError",
    () => shaped(new SessionSuspectError(SESSION, 8_000)),
  ],
  [
    "device_assigned_to_managed_slot",
    "DeviceAssignedToManagedSlotError via shapeToolCallError",
    () =>
      shaped(
        new DeviceAssignedToManagedSlotError("killDevice", DEVICE, {
          platform: "android",
          stableDeviceId: "amslot-0123abcd-0-g1",
          holder: "slot",
          scopeKey: "0123abcd",
          slotIndex: 0,
          scopeState: "valid",
          execSessionUuid: null,
        }),
      ),
  ],
  [
    "managed_slot_ownership_unconfirmed",
    "ManagedSlotOwnershipUnconfirmedError via shapeToolCallError",
    () => shaped(new ManagedSlotOwnershipUnconfirmedError(SESSION)),
  ],
  [
    "session_ownership_lost.managed_slot_ownership_lost_at_gate",
    "ManagedSlotOwnershipLostError via shapeToolCallError",
    () => shaped(new ManagedSlotOwnershipLostError(SESSION)),
  ],
  [
    "device_outside_managed_slots",
    "DeviceOutsideManagedSlotsError via shapeToolCallError",
    () =>
      shaped(
        new DeviceOutsideManagedSlotsError("tapOn", "device", "0123abcd", { deviceId: DEVICE }),
      ),
  ],
  [
    "device_outside_bound_session",
    "DeviceOutsideBoundSessionError via shapeToolCallError",
    () =>
      shaped(
        new DeviceOutsideBoundSessionError(
          "11111111-1111-4111-8111-111111111111",
          { deviceId: "emulator-5556", platform: "android" },
          { deviceId: DEVICE },
        ),
      ),
  ],
  [
    "device_outside_bound_session.other_session",
    "SessionOutsideBoundSessionError via shapeToolCallError",
    () => shaped(new SessionOutsideBoundSessionError(SESSION, "other-session")),
  ],
  [
    "daemon_shutting_down",
    "daemonShuttingDownMcpOutcome",
    () => jsonResult(daemonShuttingDownMcpOutcome()),
  ],
  [
    "daemon_queue_timeout",
    "McpTimeoutError via shapeToolCallError",
    () =>
      shaped(
        new McpTimeoutError({
          toolName: "tapOn",
          timeoutMs: 30_000,
          origin: "UnixSocketServer.handleRequest",
          detail: "spent 30000ms waiting in queue",
          code: MCP_QUEUE_TIMEOUT_ERROR_CODE,
        }),
      ),
  ],
  [
    "session_recovery_pending",
    "SessionRecoveryAssignmentError via shapeToolCallError",
    () => shaped(recoveryPendingError()),
  ],
  [
    "daemon_restart_deferred",
    "DaemonRestartDeferredError via shapeToolCallError",
    () => shaped(new DaemonRestartDeferredError("a device operation is active")),
  ],
  [
    "daemon_restart_pending",
    "daemonRestartPendingToolResult",
    () => {
      const { isError, content } = daemonRestartPendingToolResult(
        driven(new DaemonRestartPendingError()),
      );
      return { isError, content };
    },
  ],
];

/** Fixture stem of a provisionDevice failure whose bare code has no fixture of its own. */
export const PROVISION_DEVICE_FIXTURE_PREFIX = "provision_device.";
/** Fixture stem of a managed slot acquisition failure: the wrapper code, then the nested one. */
export const MANAGED_SLOT_FIXTURE_PREFIX = "managed_slot_acquisition_failed.";

/** The retryability each call site passes to `acquisitionFailure`. */
const OWN_FAILURE_RETRYABLE: Readonly<Record<ManagedSlotAcquisitionOwnFailureCode, boolean>> = {
  managed_slot_config_invalid: false,
  contract_unsupported: false,
  registry_schema_unsupported: false,
  managed_slot_group_unsupported: false,
  managed_slots_unsupported: false,
  scope_invalidated: false,
  scope_transition_pending: true,
  execution_policy_failed: true,
  execution_hold_failed: true,
  liveness_owner_conflict: true,
  daemon_unavailable: true,
  timeout: true,
  cancelled: true,
};

/** A failed acquisition, with the failure on the scope or (as the reconciler reports it) the slot. */
export function failedManagedSlotsResult(
  slotFailure: ManagedSlotsFailure,
  onSlot = false,
): ManagedSlotsResult {
  const slot: ManagedSlotResultEntry = {
    slotIndex: 0,
    role: "primary",
    platform: "android",
    assignmentGeneration: null,
    device: null,
    sessionUuid: null,
    requestedSpec: null,
    resolvedSpec: null,
    specFingerprint: null,
    disposition: null,
    readiness: null,
    lifecycle: null,
    failure: slotFailure,
  };
  return {
    contractVersion: 1,
    scope: {
      managedHostScope: "host",
      runnerNamespace: "ns",
      runnerIncarnation: "inc",
      scopeKey: null,
    },
    outcome: "failed",
    slots: onSlot ? [slot] : [],
    ...(onSlot ? {} : { failure: slotFailure }),
  };
}

/** A ready acquisition whose one slot (index 1, generation 3) holds `sessionUuid`. */
export function readyManagedSlotsResult(sessionUuid: string): ManagedSlotsResult {
  const { slots, scope } = failedManagedSlotsResult(capacitySlotFailure(), true);
  return {
    contractVersion: 1,
    scope: { ...scope, scopeKey: "0123abcd" },
    outcome: "ready",
    slots: [
      { ...slots[0], failure: undefined, slotIndex: 1, assignmentGeneration: 3, sessionUuid },
    ],
  };
}

function managedSlotsFailureResult(
  slotFailure: ManagedSlotsFailure,
  onSlot = false,
): RefusalWireResult {
  return managedSlotsFailedToolResult(
    failedManagedSlotsResult(slotFailure, onSlot),
    "tapOn",
  ) as RefusalWireResult;
}

/** Total-resource evidence is independent of boot admission and has no retry hint. */
function budgetSlotFailure(): ManagedSlotsFailure {
  return reconcileFailure(
    "managed_slot_budget_exhausted",
    "Total-resource capacity is exhausted.",
    {
      budget: {
        limit: 2,
        usage: {
          total: 3,
          active: 1,
          assignedIdle: 0,
          cached: 0,
          preparing: 1,
          deleting: 1,
          orphaned: 0,
        },
        retained: [
          {
            platform: "android",
            stableDeviceId: "amslot-kept",
            reason: "deletion_pending",
            attempts: 2,
            failedDeletes: 1,
            lastError: "delete failed",
          },
          {
            platform: "android",
            stableDeviceId: "amslot-stuck",
            reason: "deletion_stuck",
            attempts: 5,
            failedDeletes: 3,
            uncounted: true,
            lastError: "native delete keeps failing",
          },
        ],
        charged: [
          { platform: "android", stableDeviceId: "active-device", kind: "assigned_active" },
          { platform: "android", stableDeviceId: "amslot-kept", kind: "deletion_stuck" },
          {
            platform: "android",
            stableDeviceId: "amslot-stuck",
            kind: "deletion_stuck",
            uncounted: true,
          },
        ],
        evictionFailures: [
          { platform: "android", stableDeviceId: "amslot-kept", message: "delete failed" },
        ],
      },
    },
  );
}

/** A slot-level `capacity_exhausted` failure carrying boot-capacity details (#11390, #11402). */
function capacitySlotFailure(externalDevices?: string[]): ManagedSlotsFailure {
  const { code, retryable, message, nextAction, capacity } = reconcileFailure(
    "capacity_exhausted",
    "capacity_exhausted fixture",
    {
      capacity: {
        limit: 2,
        booted: 2,
        retryAfterMs: 5_000,
        ...(externalDevices ? { externalDevices } : {}),
      },
    },
  );
  return { code, retryable, message, nextAction, ...(capacity ? { capacity } : {}) };
}

/** Nested codes that reach a client under `managed_slot_acquisition_failed`. */
export function managedSlotNestedCodes(): string[] {
  const own: readonly string[] = MANAGED_SLOT_ACQUISITION_OWN_FAILURE_CODES;
  return [...own, ...MANAGED_SLOT_RECONCILE_FAILURE_CODES.filter((code) => !own.includes(code))];
}

function managedSlotFixtures(): [string, string, () => RefusalWireResult][] {
  const own: readonly string[] = MANAGED_SLOT_ACQUISITION_OWN_FAILURE_CODES;
  const withCapacity: [string, string, () => RefusalWireResult][] = [
    [
      `${MANAGED_SLOT_FIXTURE_PREFIX}managed_slot_budget_exhausted.budget`,
      "reconciler failure with budget via managedSlotsFailedToolResult",
      () => managedSlotsFailureResult(budgetSlotFailure(), true),
    ],
    [
      `${MANAGED_SLOT_FIXTURE_PREFIX}capacity_exhausted.capacity`,
      "reconciler failure with capacity via managedSlotsFailedToolResult",
      () => managedSlotsFailureResult(capacitySlotFailure(), true),
    ],
    [
      `${MANAGED_SLOT_FIXTURE_PREFIX}capacity_exhausted.capacity_external`,
      "reconciler failure with capacity via managedSlotsFailedToolResult",
      () => managedSlotsFailureResult(capacitySlotFailure(["emulator-5560"]), true),
    ],
  ];
  return [
    ...withCapacity,
    ...managedSlotNestedCodes().map((code): [string, string, () => RefusalWireResult] => [
      `${MANAGED_SLOT_FIXTURE_PREFIX}${code}`,
      own.includes(code)
        ? "acquisitionFailure via managedSlotsFailedToolResult"
        : "reconciler failure via managedSlotsFailedToolResult",
      () => {
        if (own.includes(code)) {
          const ownCode = code as ManagedSlotAcquisitionOwnFailureCode;
          return managedSlotsFailureResult(
            acquisitionFailure(ownCode, `${code} fixture`, OWN_FAILURE_RETRYABLE[ownCode]),
          );
        }
        const {
          code: failureCode,
          retryable,
          message,
          nextAction,
        } = reconcileFailure(
          code as (typeof MANAGED_SLOT_RECONCILE_FAILURE_CODES)[number],
          `${code} fixture`,
        );
        return managedSlotsFailureResult({ code: failureCode, retryable, message, nextAction });
      },
    ]),
  ];
}

/** provisionDevice failure codes whose bare wire code has no fixture above. */
function provisionFixtures(
  covered: ReadonlySet<string>,
): [string, string, () => RefusalWireResult][] {
  const codes = Object.keys(DEFAULT_PROVISION_DEVICE_RETRYABILITY) as ProvisionDeviceFailureCode[];
  return codes
    .filter((code) => !covered.has(code))
    .map((code) => [
      `${PROVISION_DEVICE_FIXTURE_PREFIX}${code}`,
      "ProvisionDeviceError via createToolErrorResponse",
      () => provisionEnvelope(new ProvisionDeviceError(code, `${code} fixture`)),
    ]);
}

/** Every refusal fixture, built fresh from the real TypeScript builders. */
export function buildRefusalWireFixtures(): RefusalWireFixture[] {
  const covered = new Set(BUILDERS.map(([code]) => code));
  return [...BUILDERS, ...provisionFixtures(covered), ...managedSlotFixtures()].map(
    ([code, builder, build]) => ({ code, builder, result: build() }),
  );
}

/**
 * Surfaces that carry a typed refusal but are not an MCP tool result, so the runners' refusal
 * classifier never reads them: the control socket failure frame, deleteDevice's failure result and
 * the managed slots result (MCP initialize outcome and the `automobile:managed-slots` resource).
 * They live beside the tool-result fixtures in `surfaces/`, named `<surface>.<name>.json`.
 */
export type RefusalSurface =
  | "socket-frame"
  | "delete-device"
  | "managed-slots-result"
  | "overload-frame"
  | "webrtc-stream-response"
  | "aux-socket-response"
  | "device-loss-outcome"
  | "device-session-error-fields"
  | "recording-start-result"
  | "proxy-tool-result"
  | "request-failure-fields"
  | "liveness-handover"
  | "managed-slots-response"
  | "provision-envelope";

/** Asynchronous real-wire captures: their owning test always checks the committed bytes. */
export const EXTERNALLY_CAPTURED_SURFACE_FIXTURES = [
  {
    surface: "proxy-tool-result",
    name: "session_ownership_lost.bound_loss",
    testFile: "test/daemon/refusalWireContract.test.ts",
    errorClass: DaemonBoundSessionLostError,
  },
  {
    surface: "proxy-tool-result",
    name: "session_ownership_lost.expired",
    testFile: "test/daemon/refusalWireContract.test.ts",
    errorClass: DaemonBoundSessionExpiredError,
  },
  {
    surface: "proxy-tool-result",
    name: "daemon_shutting_down",
    testFile: "test/daemon/refusalWireContract.test.ts",
    errorClass: DaemonShuttingDownError,
  },
  {
    surface: "managed-slots-response",
    name: "managed_slot_config_invalid",
    testFile: "test/daemon/refusalWireContract.test.ts",
    errorClass: ManagedSlotConfigError,
  },
  {
    surface: "provision-envelope",
    name: "device_offline.readiness",
    testFile: "test/server/deviceTools.provisionDevice.test.ts",
    errorClass: AdbDeviceOfflineError,
  },
  {
    surface: "provision-envelope",
    name: "identity_conflict.adoption",
    testFile: "test/server/deviceTools.provisionDevice.test.ts",
    errorClass: AndroidAvdIdentityConflictError,
  },
  {
    surface: "provision-envelope",
    name: "cleanup_failed.rollback",
    testFile: "test/server/deviceTools.provisionDevice.test.ts",
    errorClass: ProvisionDeviceRollbackError,
  },
  {
    surface: "aux-socket-response",
    name: "device_owned_by_other_session",
    testFile: "test/daemon/deviceGestureRecordingSocketServerAuth.test.ts",
    errorClass: InputDeviceOwnedError,
  },
  {
    surface: "webrtc-stream-response",
    name: "viewer_read_only",
    testFile: "test/daemon/webrtcStreamSocketServer.viewerSubscription.test.ts",
    errorClass: ViewerReadOnlyError,
  },
] as const;

export interface RefusalSurfaceFixture {
  surface: RefusalSurface;
  /** The refusal the payload carries (a wire code, plus a variant when one code has several). */
  name: string;
  /** The real TypeScript builder the payload came from. */
  builder: string;
  payload: unknown;
}

export const REFUSAL_SURFACES_DIR = join(REFUSAL_FIXTURES_DIR, "surfaces");

export function surfaceFixtureStem(fixture: Pick<RefusalSurfaceFixture, "surface" | "name">) {
  return `${fixture.surface}.${fixture.name}`;
}

/** The failure frame the control socket writes for a thrown error (`mcpRequestFailureDetails`). */
function socketFrame(error: Error): Omit<DaemonResponse, "id"> {
  driven(error);
  return JSON.parse(
    JSON.stringify({
      type: "mcp_response",
      success: false,
      error: error.message,
      ...mcpRequestFailureDetails(error, undefined),
    }),
  );
}

/** A restart target the session can still resume on while its recovery window is open. */
export function recoveryPendingError(): SessionRecoveryAssignmentError {
  return new SessionRecoveryAssignmentError({
    sessionUuid: SESSION,
    platform: "android",
    deviceId: DEVICE,
    stableDeviceId: "Pixel_8_API_35",
    recoveryWindowRemainingMs: 120_000,
  });
}

function boundSessionError(): DeviceOutsideBoundSessionError {
  return new DeviceOutsideBoundSessionError(
    "11111111-1111-4111-8111-111111111111",
    { deviceId: "emulator-5556", platform: "android" },
    { deviceId: DEVICE },
  );
}

const SLOT_HOLDER = {
  platform: "android",
  stableDeviceId: "amslot-0123abcd-0-g1",
  holder: "slot",
  scopeKey: "0123abcd",
  slotIndex: 0,
  scopeState: "valid",
  execSessionUuid: null,
} as const;

function teardownFailure(error: unknown): unknown {
  driven(error);
  const response = typedTeardownRefusal(
    {
      target: { platform: "android", isVirtual: true, stableId: "Pixel_8_API_35" },
      mode: "destroy",
      verifyAbsence: true,
    },
    error,
  );
  if (!response) {
    throw new Error("deleteDevice did not map the typed refusal");
  }
  return response;
}

/**
 * A session released by its liveness policy before a direct `input/*` frame reached the device:
 * the terminal refusal session admission throws for a non-owner control call (#11417, #11439).
 */
function terminalAtAdmission(releaseReason: SessionReleaseReason): TerminalSessionError {
  return new TerminalSessionError(SESSION, {
    sessionId: SESSION,
    deviceId: DEVICE,
    releaseReason,
    releasedAtMs: 1_000,
    terminal: true,
    heartbeat: { lastHeartbeatMs: 0, hasReceivedHeartbeat: true, timeoutMs: 1_000, ageMs: 1_000 },
  });
}

const SOCKET_FRAME_ERRORS: readonly (readonly [string, () => Error])[] = [
  ["prototype_hidden", () => new PrototypeHiddenError("app_layer_window_hidden")],
  ["prototype_suspended", () => new PrototypeSuspendedError()],
  ["device_unhealthy", () => unhealthyRefusal()],
  ["device_unhealthy.permanent", () => unhealthyRefusal("permanent")],
  [
    "discovery_incomplete.android",
    () =>
      new AndroidBootedDeviceDiscoveryIncompleteError({
        code: "failed",
        message: "adb devices failed",
        retryable: true,
      }),
  ],
  ["timeout.shutdown", () => new DeviceShutdownTimeoutError("Device shutdown deadline exhausted")],
  [
    "timeout.iosHomeLaunch",
    () => new IosHomeLaunchTimeoutError("SpringBoard launch exhausted the Home budget"),
  ],
  ["timeout.boot", () => new DeviceBootTimeoutError("boot", "readiness", 1_000, 1_000, DEVICE)],
  [
    "daemon_handoff_interrupted",
    () => new DaemonHandoffInterruptionError("Daemon handoff interrupted the in-flight request"),
  ],
  // The same retryable identity refusal is shaped by shapeToolCallError on the tool boundary.
  [
    "target_identity_unresolved",
    () => new AndroidAvdIdentityUnresolvedError("Pixel_8_API_35", [DEVICE]),
  ],
  // Direct input/* admitted as a non-owner control call on the holder's session (#11439).
  ["daemon_session_suspect", () => new SessionSuspectError(SESSION, 8_000)],
  [
    "session_ownership_lost.admission_heartbeat_timeout",
    () => terminalAtAdmission("heartbeat-timeout"),
  ],
  [
    "session_ownership_lost.admission_cli_idle_timeout",
    () => terminalAtAdmission("cli-idle-timeout"),
  ],
  ["session_ownership_lost.admission_expired", () => terminalAtAdmission("expired")],
  ["device_owned_by_other_session", () => new InputDeviceOwnedError("input/tap", DEVICE, "holder")],
  // A gestureStart lifted because its admitting holder left the device before the ack (#11351).
  [
    "session_no_longer_owns_device",
    () =>
      strokeAdmissionEndedError("input/gestureStart", {
        deviceId: DEVICE,
        holderSessionId: SESSION,
      }) as Error,
  ],
  ["session_recovery_pending", recoveryPendingError],
  ["daemon_restart_deferred", () => new DaemonRestartDeferredError("a device operation is active")],
  ["daemon_restart_pending", () => new DaemonRestartPendingError()],
  ["device_outside_bound_session", boundSessionError],
  ["managed_slot_ownership_unconfirmed", () => new ManagedSlotOwnershipUnconfirmedError(SESSION)],
  [
    "session_ownership_lost.managed_slot_ownership_lost_at_gate",
    () => new ManagedSlotOwnershipLostError(SESSION),
  ],
  ["capacity_exhausted.ios", () => bootCapacityRefusal("ios") as Error],
  ["discovery_incomplete.ios", iosInventoryIncomplete],
  [
    "device_outside_managed_slots",
    () => new DeviceOutsideManagedSlotsError("tapOn", "device", "0123abcd", { deviceId: DEVICE }),
  ],
  [
    "device_outside_managed_slots.tool",
    () => new DeviceOutsideManagedSlotsError("startDevice", "tool", "0123abcd"),
  ],
  [
    "device_assigned_to_managed_slot",
    () => new DeviceAssignedToManagedSlotError("killDevice", DEVICE, SLOT_HOLDER),
  ],
  ...RECOVERY_LOSSES.map(([name, error]): readonly [string, () => Error] => [
    `session_ownership_lost.recovery_${name}`,
    error,
  ]),
  ...CUT_RELEASE_REASONS.map(([name, reason]): readonly [string, () => Error] => [
    `session_ownership_lost.released_${name}`,
    () => new SessionReleasedDuringCallError(SESSION, reason),
  ]),
];

/** Every surface fixture, built fresh from the real serializers. */
export function buildRefusalSurfaceFixtures(): RefusalSurfaceFixture[] {
  return [
    {
      surface: "device-loss-outcome",
      name: "device_lost",
      builder: "deviceLossOutcomeFromError",
      payload: deviceLossOutcomeFromError(
        driven(new DeviceLostError(DEVICE, "device disappeared", "loss-incident")),
        SESSION,
      ),
    },
    {
      surface: "device-session-error-fields",
      name: "DEVICE_SESSION_SUPERSEDED_BY_RESTORE",
      builder: "deviceSessionErrorFields",
      payload: deviceSessionErrorFields(
        driven(
          new DeviceSessionSupersededByRestoreError(SESSION, {
            deviceId: DEVICE,
            successorSessionUuid: "66666666-7777-4888-8999-000000000000",
            reason: "superseded-by-restore",
          }),
        ),
      ),
    },
    {
      surface: "recording-start-result",
      name: "no_active_device_session",
      builder: "shapeToolCallError via toPayload",
      payload: shaped(
        new DeviceGestureRecordingStartUnheldError(
          "No session holds the recording device",
          noActiveDeviceSessionPayload({
            message: "No session holds the recording device",
            reason: "device_not_held",
          }).error,
        ),
      ),
    },
    {
      surface: "proxy-tool-result",
      name: "device_control_transport_failure",
      builder: "deviceControlTransportFailureResult",
      payload: deviceControlTransportFailureResult(
        driven(
          new DeviceControlTransportError("Device control connection failed", {
            code: "device_control_transport_failure",
            transport: "daemon_loopback_http",
            toolName: "tapOn",
            deviceId: DEVICE,
            deviceSessionUuid: SESSION,
            sessionUuid: SESSION,
            sessionValid: true,
            deviceSessionValid: true,
            phase: "connect",
            retryable: true,
            reconnectAttempted: true,
            replayAttempted: false,
          }),
        ),
      ),
    },
    {
      surface: "request-failure-fields",
      name: "daemon_tool_unavailable",
      builder: "mcpRequestFailureDetails",
      payload: mcpRequestFailureDetails(
        driven(new ToolUnavailableError("debugTool", ["debug mode required"])),
        undefined,
      ),
    },
    {
      surface: "liveness-handover",
      name: "daemon_stalled",
      builder: "DaemonSessionStalledError.toPayload via livenessHandoverPayload",
      payload: driven(
        new DaemonSessionStalledError(SESSION, {
          code: "daemon_stalled",
          sessions: [{ sessionUuid: SESSION, deviceId: DEVICE, lastAcknowledgedHeartbeatAt: 10 }],
          attempts: 3,
          lastAcknowledgedHeartbeatAt: 10,
          action: "restart_daemon_then_resume_by_session_uuid",
        }),
      ).toPayload(),
    },
    {
      surface: "overload-frame",
      name: "daemon_overloaded",
      builder: "mcpRequestFailureDetails",
      payload: socketFrame(overloadRefusalError()),
    },
    ...SOCKET_FRAME_ERRORS.map(([name, error]): RefusalSurfaceFixture => ({
      surface: "socket-frame",
      name,
      builder: "mcpRequestFailureDetails",
      payload: socketFrame(error()),
    })),
    {
      surface: "delete-device",
      name: "device_owned_by_other_daemon",
      builder: "typedTeardownRefusal",
      payload: teardownFailure(new DeviceOwnedByOtherDaemonError(DEVICE, 4242)),
    },
    {
      surface: "delete-device",
      name: "discovery_incomplete",
      builder: "typedTeardownRefusal",
      payload: teardownFailure(new ManagedSlotDiscoveryIncompleteError("registry locked")),
    },
    {
      surface: "managed-slots-result",
      name: "managed_slot_budget_exhausted.budget",
      builder: "reconciler failure in ManagedSlotsResult",
      payload: failedManagedSlotsResult(budgetSlotFailure(), true),
    },
    {
      surface: "managed-slots-result",
      name: "capacity_exhausted.capacity",
      builder: "reconciler failure in ManagedSlotsResult",
      payload: failedManagedSlotsResult(capacitySlotFailure(), true),
    },
    {
      surface: "managed-slots-result",
      name: "capacity_exhausted.capacity_external",
      builder: "reconciler failure in ManagedSlotsResult",
      payload: failedManagedSlotsResult(capacitySlotFailure(["emulator-5560"]), true),
    },
  ];
}

export function serializeRefusalSurfaceFixture(fixture: RefusalSurfaceFixture): string {
  return `${JSON.stringify(fixture, null, 2)}\n`;
}

/** The wire codes a top-level fixture carries, outermost first, derived from its file stem. */
export function expectedWireCodes(fixtureCode: string): string[] {
  const variantless = (stem: string) => stem.split(".")[0];
  if (fixtureCode.startsWith(MANAGED_SLOT_FIXTURE_PREFIX)) {
    return [
      "managed_slot_acquisition_failed",
      variantless(fixtureCode.slice(MANAGED_SLOT_FIXTURE_PREFIX.length)),
    ];
  }
  if (fixtureCode.startsWith(PROVISION_DEVICE_FIXTURE_PREFIX)) {
    return [variantless(fixtureCode.slice(PROVISION_DEVICE_FIXTURE_PREFIX.length))];
  }
  return [variantless(fixtureCode)];
}

/**
 * Codes defined as literals beside unrelated protocol codes rather than as `*_CODE` constants:
 * each must have a fixture or a recorded reason (#11351).
 */
export const LITERAL_CLIENT_REACHABLE_CODES: readonly string[] = [
  "ambiguous_session_selector",
  MCP_QUEUE_TIMEOUT_ERROR_CODE,
  MCP_OVERLOAD_ERROR_CODE,
  "session_recovery_pending",
  "daemon_restart_pending",
  "daemon_restart_deferred",
  "viewer_read_only",
  "target_identity_unresolved",
];

/** Every exported Error in the coded-refusal modules is covered or has an honest, reviewable gap. */
export const EXEMPT_REFUSAL_ERROR_CLASSES: ReadonlyMap<Error["constructor"], string> = new Map<
  Error["constructor"],
  string
>([
  [
    ManagedSlotRegistrySchemaUnsupportedError,
    "internal registry-open refusal; ManagedSlotAcquisition maps it to the fixture-covered registry_schema_unsupported acquisition failure before serialization",
  ],
  [
    HostBootAdmissionRegistryError,
    "internal host-lock failure; AndroidBootAdmissionGate maps it to discovery_incomplete before the wire",
  ],
  [
    StageSessionDownloadsRefusal,
    "uppercase code but no retryable field: shapeToolCallError returns plain 'Error: ...' text for this Downloads-staging refusal",
  ],
  [
    SharedDaemonNamespaceError,
    "CLI and proxy restart-admission guard with no retryable flag; shapeToolCallError returns plain 'Error: ...' text",
  ],
  [
    DaemonAssetVersionMismatchError,
    "no wire code: version-skew failure reaches shapeToolCallError as plain 'Error: ...' text",
  ],
  [
    DaemonBuildMismatchError,
    "no wire code: build-skew failure reaches shapeToolCallError as plain 'Error: ...' text",
  ],
  [
    DaemonToolOutcomeUnknownError,
    "no wire code: uncertain dispatch reaches shapeToolCallError as plain 'Error: ...' text",
  ],
  [
    DaemonToolUnavailableError,
    "untyped tool-result text today: its optional gate code has no retryable flag and shapeToolCallError returns plain 'Error: ...' text",
  ],
  [
    DaemonVersionMismatchError,
    "no wire code: version-skew failure reaches shapeToolCallError as plain 'Error: ...' text",
  ],
  [
    LifecycleConnectionInFlightError,
    "internal observation-only connection refusal with no wire code; never a typed tool-result refusal",
  ],
  [
    DaemonSessionCreationRejectedError,
    "no wire code: shutdown creation rejection reaches shapeToolCallError as plain 'Error: ...' text",
  ],
  [
    SessionActivityPersistenceError,
    "no wire code: persistence failure reaches shapeToolCallError as plain 'Error: ...' text",
  ],
  [
    SessionReleasePersistTimeoutError,
    "no wire code: release persistence timeout has a reason only; shapeToolCallError returns plain 'Error: ...' text",
  ],
  [
    UnissuedSessionError,
    "no wire code: unissued-session refusal reaches shapeToolCallError as plain 'Error: ...' text",
  ],
  [DaemonCommandRefusal, "daemon CLI refusal wrapper, never crosses the MCP/socket wire"],
  [
    DaemonHandshakeMismatchError,
    "GAP: src/daemon/daemonMcpProxy.ts:3876 consumes this class as pre-dispatch recovery, not a refusal result; the handshake wire emitter is private UnixSocketServer.rejectOnHandshakeMismatch in src/daemon/socketServer.ts:2810. Capturing that original frame requires a socket-server/connection harness rather than a public serializer accepting the class (#11351)",
  ],
  [
    DaemonUnavailableError,
    "uncoded daemon transport failure used for proxy reconnect; shapeToolCallError returns plain 'Error: ...' text",
  ],
  [
    DaemonRequestNotDeliveredError,
    "uncoded pre-dispatch transport failure used for safe proxy replay; shapeToolCallError returns plain 'Error: ...' text",
  ],
  [
    LoopbackMcpConnectionError,
    "uncoded loopback fetch cause; socketServer normalizes it into DeviceControlTransportError before the wire",
  ],
  [
    PooledAvdIdentityError,
    "uncoded pooled-identity failure; deviceToolsLifecycle maps it to target_identity_unresolved in a tool error response",
  ],
  [
    RetryableDeviceAcquisitionError,
    "base class instantiated only through its concrete acquisition subclasses, which the fixtures drive",
  ],
]);

/** Codes that exist as named constants but never reach a client as a typed JSON refusal. */
export const UNFIXTURED_REFUSAL_CODES: Readonly<Record<string, string>> = {
  registry_schema_unsupported:
    "internal registry-open code mapped to the acquisition failure fixtured under managed_slot_acquisition_failed.registry_schema_unsupported",
  daemon_session_not_found:
    "a daemon socket response field (`code` beside `error`) for an unknown session, not an MCP tool result body",
  bound_session_lost:
    "internal ReleasedBoundSessionError payload; clients receive it as the session_ownership_lost fixture",
  daemon_instance_changed:
    "a daemon/heartbeat protocol answer to a proxy, never an MCP tool result a runner classifies",
  managed_slot_registration_refused:
    "a daemon/registerSession protocol answer to a managed proxy, never a device-tool refusal",
  liveness_owner_conflict:
    "a daemon liveness-ownership protocol answer to a proxy or keeper (as a managed acquisition failure it is fixtured under managed_slot_acquisition_failed.)",
  liveness_owner_is_proxy:
    "a daemon liveness protocol answer to an external keeper, never a tool result",
  liveness_owner_not_owner:
    "a daemon liveness protocol answer to a release request, never a tool result",
  liveness_owner_superseded: "a daemon liveness protocol answer to a proxy, never a tool result",
  liveness_owner_unowned: "a daemon liveness protocol answer to a keeper tick, never a tool result",
};

export function serializeRefusalFixture(fixture: RefusalWireFixture): string {
  return `${JSON.stringify(fixture, null, 2)}\n`;
}
