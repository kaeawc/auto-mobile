import { join } from "node:path";
import { fileURLToPath } from "node:url";
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
import { IOS_SIM_MAX_BOOTED_ENV } from "../../src/features/iosSimFleet/capacityPolicy";
import { InputDeviceOwnedError } from "../../src/daemon/inputDeviceOwnership";
import { mcpRequestFailureDetails } from "../../src/daemon/socketServer";
import { SessionReleasedDuringCallError } from "../../src/daemon/sessionReleasedDuringCall";
import type { SessionReleaseReason } from "../../src/daemon/releaseReasons";
import { typedTeardownRefusal } from "../../src/server/deviceToolsLifecycle";
import { DaemonConnectionSessionReleasedError } from "../../src/daemon/daemonMcpProxy";
import { daemonShuttingDownMcpOutcome } from "../../src/daemon/daemonShutdownOutcome";
import { deviceAssignedToOtherSessionError } from "../../src/daemon/inputDeviceOwnership";
import {
  SessionNoLongerOwnsDeviceError,
  SessionRecoveryIdentityLossError,
  SessionRebindingError,
  SessionSuspectError,
  SessionTerminalReleaseInProgressError,
} from "../../src/daemon/sessionManager";
import { ProvisionDeviceError } from "../../src/devices/exactDeviceProvisioning";
import {
  DeviceAssignedToManagedSlotError,
  DeviceOutsideManagedSlotsError,
  ManagedSlotDiscoveryIncompleteError,
} from "../../src/daemon/managedSlots/managedSlotRefusal";
import { DeviceOutsideBoundSessionError } from "../../src/server/deviceOutsideBoundSessionRefusal";
import { BootedDeviceDiscoveryIncompleteError } from "../../src/devices/deviceBootService";
import { createToolErrorResponse } from "../../src/server/deviceTools";
import {
  sessionOwnershipLostPayload,
  sessionReleasedDuringCallPayload,
} from "../../src/server/deviceSessionResult";
import {
  managedSlotsFailedToolResult,
  noActiveDeviceSessionResult,
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

export const REFUSAL_FIXTURES_DIR = fileURLToPath(
  new URL("../fixtures/refusal-wire/", import.meta.url),
);

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

/** One entry per wire code, each produced by the builder the daemon itself calls. */
const BUILDERS: readonly FixtureEntry[] = [
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
    "SessionReleasedDuringCallError via sessionReleasedDuringCallPayload",
    () =>
      jsonResult(
        sessionReleasedDuringCallPayload(new SessionReleasedDuringCallError(SESSION, reason))!,
      ),
  ]),
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
export type RefusalSurface = "socket-frame" | "delete-device" | "managed-slots-result";

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
function socketFrame(error: Error): unknown {
  return JSON.parse(
    JSON.stringify({
      type: "mcp_response",
      success: false,
      error: error.message,
      ...mcpRequestFailureDetails(error, undefined),
    }),
  );
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

const SOCKET_FRAME_ERRORS: readonly (readonly [string, () => Error])[] = [
  ["device_owned_by_other_session", () => new InputDeviceOwnedError("input/tap", DEVICE, "holder")],
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
