import {
  assertBootCapacityGranted,
  atCapacityDecision,
} from "../../src/features/bootAdmission/BootAdmissionGate";
import {
  DeviceCleanupInProgressError,
  DeviceOwnedByOtherDaemonError,
  DeviceShuttingDownError,
  SessionCreationTimeoutError,
} from "../../src/daemon/deviceAcquisitionRefusals";
import { DaemonConnectionSessionReleasedError } from "../../src/daemon/daemonMcpProxy";
import { daemonShuttingDownMcpOutcome } from "../../src/daemon/daemonShutdownOutcome";
import { deviceAssignedToOtherSessionError } from "../../src/daemon/inputDeviceOwnership";
import {
  SessionNoLongerOwnsDeviceError,
  SessionRebindingError,
  SessionSuspectError,
  SessionTerminalReleaseInProgressError,
} from "../../src/daemon/sessionManager";
import { ProvisionDeviceError } from "../../src/devices/exactDeviceProvisioning";
import {
  DeviceAssignedToManagedSlotError,
  DeviceOutsideManagedSlotsError,
} from "../../src/daemon/managedSlots/managedSlotRefusal";
import { DeviceOutsideBoundSessionError } from "../../src/server/deviceOutsideBoundSessionRefusal";
import { BootedDeviceDiscoveryIncompleteError } from "../../src/devices/deviceBootService";
import { createToolErrorResponse } from "../../src/server/deviceTools";
import { sessionOwnershipLostPayload } from "../../src/server/deviceSessionResult";
import {
  managedSlotsFailedToolResult,
  noActiveDeviceSessionResult,
} from "../../src/server/proxyServer";
import {
  MANAGED_SLOT_ACQUISITION_OWN_FAILURE_CODES,
  type ManagedSlotAcquisitionOwnFailureCode,
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

export const REFUSAL_FIXTURES_DIR = new URL("../fixtures/refusal-wire/", import.meta.url).pathname;

const SESSION = "11111111-2222-4333-8444-555555555555";
const DEVICE = "emulator-5554";

function shaped(error: unknown): RefusalWireResult {
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
function bootCapacityRefusal(): unknown {
  const decision = atCapacityDecision(2, { maxBooted: 2, source: "default" }, 5_000, {
    noun: "emulator",
    envName: "AUTO_MOBILE_MAX_BOOTED",
    externalDevices: ["emulator-5560"],
  });
  try {
    assertBootCapacityGranted({ decision: decision! }, "android", "emulator");
  } catch (error) {
    return error;
  }
  throw new Error("assertBootCapacityGranted did not refuse a full platform");
}

function jsonResult(payload: unknown): RefusalWireResult {
  return { isError: true, content: [{ type: "text", text: JSON.stringify(payload) }] };
}

function provisionFailure(error: BootedDeviceDiscoveryIncompleteError): RefusalWireResult {
  return provisionEnvelope(
    new ProvisionDeviceError("discovery_incomplete", error.message, error.retryable),
  );
}

function provisionEnvelope(failure: ProvisionDeviceError): RefusalWireResult {
  // The provisionDevice failure envelope (`provisionDeviceErrorResponse` in
  // deviceToolsProvisioning) around the real ProvisionDeviceError.
  return createToolErrorResponse(failure.code, failure.message, {
    error: { code: failure.code, message: failure.message, retryable: failure.retryable },
  });
}

/** One entry per wire code, each produced by the builder the daemon itself calls. */
const BUILDERS: readonly (readonly [string, string, () => RefusalWireResult])[] = [
  [
    "device_owned_by_other_session",
    "deviceAssignedToOtherSessionError via shapeToolCallError",
    () => shaped(deviceAssignedToOtherSessionError(DEVICE, "holder-session", SESSION)),
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
    "no_active_device_session",
    "noActiveDeviceSessionResult",
    () =>
      noActiveDeviceSessionResult(
        new DaemonConnectionSessionReleasedError("heartbeat_timeout"),
      ) as RefusalWireResult,
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

function managedSlotsFailureResult(slotFailure: ManagedSlotsFailure): RefusalWireResult {
  const result: ManagedSlotsResult = {
    contractVersion: 1,
    scope: {
      managedHostScope: "host",
      runnerNamespace: "ns",
      runnerIncarnation: "inc",
      scopeKey: null,
    },
    outcome: "failed",
    slots: [],
    failure: slotFailure,
  };
  return managedSlotsFailedToolResult(result, "tapOn") as RefusalWireResult;
}

/** Nested codes that reach a client under `managed_slot_acquisition_failed`. */
export function managedSlotNestedCodes(): string[] {
  const own: readonly string[] = MANAGED_SLOT_ACQUISITION_OWN_FAILURE_CODES;
  return [...own, ...MANAGED_SLOT_RECONCILE_FAILURE_CODES.filter((code) => !own.includes(code))];
}

function managedSlotFixtures(): [string, string, () => RefusalWireResult][] {
  const own: readonly string[] = MANAGED_SLOT_ACQUISITION_OWN_FAILURE_CODES;
  return managedSlotNestedCodes().map((code) => [
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
  ]);
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
