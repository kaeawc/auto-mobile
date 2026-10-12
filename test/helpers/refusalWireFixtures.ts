import { HostBootAdmissionRegistryError } from "../../src/features/bootAdmission/HostBootAdmissionRegistry";
import { StageSessionDownloadsRefusal } from "../../src/server/downloadsFixtureService";
import { AdbDeviceOfflineError } from "../../src/utils/android-cmdline-tools/AdbDeviceHealth";
import { DeviceLostError } from "../../src/models/DeviceLostError";
import { ManagedSlotConfigError } from "../../src/models/managedSlotConfig";
import { AndroidBootedDeviceDiscoveryIncompleteError } from "../../src/models/BootedDeviceDiscoveryIncompleteError";
import { DeviceShutdownTimeoutError } from "../../src/models/DeviceShutdownTimeoutError";
import { IosHomeLaunchTimeoutError } from "../../src/models/IosHomeLaunchTimeoutError";
import { SharedDaemonNamespaceError } from "../../src/daemon/sharedNamespaceGuard";
import { DeviceSessionSupersededByRestoreError } from "../../src/daemon/deviceSessionResolver";
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
} from "../../src/daemon/managedSlots/managedSlotRefusal";
import { DeviceOutsideBoundSessionError } from "../../src/server/deviceOutsideBoundSessionRefusal";
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
    "managed_execution_ended.released_cleanup_expired",
    "managedEndedPayload",
    () =>
      jsonResult(managedEndedPayload(readyManagedSlotsResult(SESSION), SESSION, "cleanup-expired")),
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
  | "aux-socket-response";

/** Asynchronous real-wire captures: their owning test always checks the committed bytes. */
export const EXTERNALLY_CAPTURED_SURFACE_FIXTURES = [
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
  // shapeToolCallError returns plain Error: text; no top-level JSON refusal. Inline
  // deleteDevice/provisionDevice target_identity_unresolved literals have no shared capture builder.
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
    HostBootAdmissionRegistryError,
    "internal host-lock failure; AndroidBootAdmissionGate maps it to discovery_incomplete before the wire",
  ],
  [
    StageSessionDownloadsRefusal,
    "uppercase code but no retryable field: shapeToolCallError returns plain 'Error: ...' text for this Downloads-staging refusal",
  ],
  [
    AdbDeviceOfflineError,
    "GAP: provision readiness maps this cause to device_offline with diagnostics in the ProvisionDeviceError envelope; no fixture captures this class yet (#11351)",
  ],
  [
    DeviceLostError,
    "GAP: deviceLossOutcomeFromError emits device_lost and provision readiness maps this cause to a device_lost envelope with diagnostics; no fixture captures this class yet (#11351)",
  ],
  [
    ManagedSlotConfigError,
    "GAP: daemon/acquireManagedSlots returns this class's code beside error without retryable; no fixture captures this class yet (#11351)",
  ],
  [
    SharedDaemonNamespaceError,
    "CLI and proxy restart-admission guard with no retryable flag; shapeToolCallError returns plain 'Error: ...' text",
  ],
  [
    DeviceSessionSupersededByRestoreError,
    "GAP: deviceSessionErrorFields puts DEVICE_SESSION_SUPERSEDED_BY_RESTORE beside error on the device-data aux socket; no fixture captures this class yet (#11351)",
  ],
  [
    DeviceGestureRecordingStartUnheldError,
    "GAP: toPayload supplies the typed no_active_device_session recording-start fields to the MCP result and socket frame; no fixture captures this class yet (#11351)",
  ],
  [
    DaemonAssetVersionMismatchError,
    "no wire code: version-skew failure reaches shapeToolCallError as plain 'Error: ...' text",
  ],
  [
    DaemonBoundSessionExpiredError,
    "GAP: proxyServer maps this class to session_ownership_lost or managed_execution_ended; no fixture captures this class yet (#11351)",
  ],
  [
    DaemonBuildMismatchError,
    "no wire code: build-skew failure reaches shapeToolCallError as plain 'Error: ...' text",
  ],
  [
    DaemonSessionStalledError,
    "GAP: proxyServer maps this class's liveness handover to daemon_stalled/proxy_stalled or managed_execution_ended; no fixture captures this class yet (#11351)",
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
    AndroidAvdIdentityConflictError,
    "GAP: knownProvisionDeviceError maps this class to identity_conflict in the provision envelope; no fixture captures this class yet (#11351)",
  ],
  [
    DaemonHandshakeMismatchError,
    "GAP: daemonResponseError preserves handshakeFailure.code and the proxy uses this class for pre-dispatch recovery; no fixture captures this class yet (#11351)",
  ],
  [
    DaemonBoundSessionLostError,
    "GAP: daemonResponseError preserves boundSessionLoss.code and the proxy maps this class to session_ownership_lost or managed_execution_ended; no fixture captures this class yet (#11351)",
  ],
  [
    DaemonShuttingDownError,
    "GAP: daemonResponseError copies the shutdown frame's code onto this class and proxyServer emits the daemon_shutting_down MCP envelope; no fixture captures this class yet (#11351)",
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
    DeviceControlTransportError,
    "GAP: socketServer carries failure under transportFailure and proxyServer's deviceControlTransportFailureResult emits it under error; no fixture captures this class yet (#11351)",
  ],
  [
    LoopbackMcpConnectionError,
    "uncoded loopback fetch cause; socketServer normalizes it into DeviceControlTransportError before the wire",
  ],
  [
    ToolUnavailableError,
    "GAP: the MCP SDK carries data.code on the JSON-RPC error and mcpRequestFailureDetails lifts it to socket-frame code without retryable; no fixture captures this class yet (#11351)",
  ],
  [
    PooledAvdIdentityError,
    "uncoded pooled-identity failure; deviceToolsLifecycle maps it to target_identity_unresolved in a tool error response",
  ],
  [
    ProvisionDeviceRollbackError,
    "GAP: deviceToolsProvisioning emits the inherited code and retryable under error with provisionFailure and cleanup beside it; no fixture captures this class yet (#11351)",
  ],
  [
    RetryableDeviceAcquisitionError,
    "base class instantiated only through its concrete acquisition subclasses, which the fixtures drive",
  ],
  [
    SessionReleasedDuringCreationError,
    "untyped on the wire today; issue #11351 row g awaits an owner decision",
  ],
]);

/** Codes that exist as named constants but never reach a client as a typed JSON refusal. */
export const UNFIXTURED_REFUSAL_CODES: Readonly<Record<string, string>> = {
  session_released_during_creation:
    "SessionReleasedDuringCreationError is not typed by shapeToolCallError: clients get plain 'Error: ...' text with no code",
  daemon_session_not_found:
    "a daemon socket response field (`code` beside `error`) for an unknown session, not an MCP tool result body",
  bound_session_lost:
    "internal ReleasedBoundSessionError payload; clients receive it as the session_ownership_lost fixture",
  daemon_tool_unavailable:
    "carried as JSON-RPC error `data` of a gated tool, not as a tool result refusal",
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
