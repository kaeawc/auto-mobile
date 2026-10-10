import { BootCapacityExhaustedError } from "../../src/models/BootCapacityExhaustedError";
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
import { BootedDeviceDiscoveryIncompleteError } from "../../src/devices/deviceBootService";
import { createToolErrorResponse } from "../../src/server/deviceTools";
import { sessionOwnershipLostPayload } from "../../src/server/deviceSessionResult";
import { noActiveDeviceSessionResult } from "../../src/server/proxyServer";
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

function jsonResult(payload: unknown): RefusalWireResult {
  return { isError: true, content: [{ type: "text", text: JSON.stringify(payload) }] };
}

function provisionFailure(error: BootedDeviceDiscoveryIncompleteError): RefusalWireResult {
  // The provisionDevice failure envelope (`provisionDeviceErrorResponse` in
  // deviceToolsProvisioning) around the real ProvisionDeviceError.
  const failure = new ProvisionDeviceError("discovery_incomplete", error.message, error.retryable);
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
    "BootCapacityExhaustedError via shapeToolCallError",
    () =>
      shaped(
        new BootCapacityExhaustedError(
          { platform: "android", limit: 2, booted: 2, retryAfterMs: 5_000 },
          "Timed out waiting for emulator capacity",
        ),
      ),
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
    "daemon_shutting_down",
    "daemonShuttingDownMcpOutcome",
    () => jsonResult(daemonShuttingDownMcpOutcome()),
  ],
];

/** Every refusal fixture, built fresh from the real TypeScript builders. */
export function buildRefusalWireFixtures(): RefusalWireFixture[] {
  return BUILDERS.map(([code, builder, build]) => ({ code, builder, result: build() }));
}

/** Codes that exist as named constants but never reach a client as a typed JSON refusal. */
export const UNFIXTURED_REFUSAL_CODES: Readonly<Record<string, string>> = {
  session_released_during_creation:
    "SessionReleasedDuringCreationError is not typed by shapeToolCallError: clients get plain 'Error: ...' text with no code",
};

export function serializeRefusalFixture(fixture: RefusalWireFixture): string {
  return `${JSON.stringify(fixture, null, 2)}\n`;
}
