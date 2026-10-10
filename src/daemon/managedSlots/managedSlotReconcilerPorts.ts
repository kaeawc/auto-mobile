/**
 * Production ports for the managed slot reconciler (#11173 part b, #11175): the daemon's real
 * device inventory, the `provisionDevice` path (exact matching, creation, boot, automation
 * readiness, rollback) and the verified `deleteDevice` workflow, plus live-session and
 * foreign-daemon claims from the device pool.
 *
 * Provision and delete go through the registered tool handlers ({@link ManagedSlotToolInvoker}),
 * the same code an MCP caller runs, so the reconciler inherits their lifecycle leases, boot
 * capacity gate, rollback and evidence. Those handlers refuse every caller but a slot's own live
 * execution on a managed device; the reconciler holds no execution session yet, so it runs inside
 * {@link runAsManagedSlotReconciler}, which the generic-exclusion guard accepts for this slot only.
 */

import type { DeviceInfo } from "../../models";
import {
  ProvisionDeviceError,
  type ProvisionDeviceFailureCode,
} from "../../devices/exactDeviceProvisioning";
import type { PlatformDeviceManager } from "../../devices/deviceUtils";
import type { AvdConfigReader } from "../../utils/android-cmdline-tools/AvdConfigReader";
import { errorMessage } from "../../utils/describeUnknownError";
import { logger } from "../../utils/logger";
import { MAX_PROVISION_DEVICE_TIMEOUT_MS } from "../../utils/deviceTimeouts";
import type { Timer } from "../../utils/SystemTimer";
import type { PooledDevice } from "../devicePool";
import {
  deviceStableId,
  type ManagedSlotDeviceClaim,
  type ManagedSlotDeviceClaims,
  type ManagedSlotDeviceProvisioner,
  type ManagedSlotInventory,
  type ManagedSlotInventorySnapshot,
  type ManagedSlotProvisionRequest,
  type ManagedSlotProvisionedDevice,
} from "./reconciler";
import type { LiveExecutionSessions } from "./slotOwnerLiveness";
import type { SlotPlatform } from "./slotRegistry";

/** Invokes a registered tool handler in-process and returns its raw MCP tool response. */
export type ManagedSlotToolInvoker = (
  name: "provisionDevice",
  args: Record<string, unknown>,
  signal: AbortSignal | undefined,
) => Promise<unknown>;

interface ToolResponseLike {
  isError?: boolean;
  structuredContent?: unknown;
  content?: Array<{ type?: string; text?: string }>;
}

/** The response payload: `structuredContent` when present, else the first text block as JSON. */
export function readToolPayload(response: unknown): {
  isError: boolean;
  payload: Record<string, unknown>;
} {
  const shaped = (response ?? {}) as ToolResponseLike;
  if (shaped.structuredContent && typeof shaped.structuredContent === "object") {
    return {
      isError: shaped.isError === true,
      payload: shaped.structuredContent as Record<string, unknown>,
    };
  }
  const text = shaped.content?.find((block) => typeof block.text === "string")?.text;
  let payload: Record<string, unknown> = {};
  if (text !== undefined) {
    try {
      const parsed: unknown = JSON.parse(text);
      payload = parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {};
    } catch (error) {
      // A non-JSON text block carries no typed fields; keep the text as the message.
      logger.debug(`[ManagedSlots] tool response text is not JSON: ${errorMessage(error)}`);
      payload = { message: text };
    }
  }
  return { isError: shaped.isError === true, payload };
}

function stringField(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function numberField(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

/** Rebuild the typed provision failure from a provisionDevice error response. */
export function provisionErrorFromPayload(
  payload: Record<string, unknown>,
  fallbackMessage: string,
): ProvisionDeviceError {
  const error = (payload.error ?? {}) as Record<string, unknown>;
  const code = (stringField(error.code) ?? "platform_command_failed") as ProvisionDeviceFailureCode;
  const message = stringField(error.message) ?? stringField(payload.message) ?? fallbackMessage;
  const retryable = typeof error.retryable === "boolean" ? error.retryable : undefined;
  const limit = numberField(error.limit);
  const booted = numberField(error.booted);
  const retryAfterMs = numberField(error.retryAfterMs);
  return new ProvisionDeviceError(code, message, retryable, {
    ...(retryAfterMs !== undefined ? { retryAfterMs } : {}),
    ...(limit !== undefined && booted !== undefined ? { capacity: { limit, booted } } : {}),
  });
}

/** Read the provisioned device, session and readiness from a provisionDevice success payload. */
export function provisionedDeviceFromPayload(
  payload: Record<string, unknown>,
  requestedName: string,
): ManagedSlotProvisionedDevice {
  const device = (payload.device ?? {}) as {
    name?: string;
    identity?: { stableId?: string };
    runtime?: { deviceId?: string | null };
  };
  const readiness = (payload.readiness ?? {}) as { mode?: string; status?: string };
  const stableId = stringField(device.identity?.stableId);
  if (!stableId) {
    throw new ProvisionDeviceError(
      "platform_command_failed",
      `provisionDevice '${requestedName}' returned no stable device identity.`,
    );
  }
  return {
    device: {
      stableId,
      transportId: stringField(device.runtime?.deviceId) ?? null,
      name: stringField(device.name) ?? requestedName,
    },
    created: payload.created === true,
    sessionUuid: stringField(payload.sessionId) ?? "",
    readiness: {
      mode: stringField(readiness.mode) ?? "none",
      status: stringField(readiness.status) ?? "unknown",
    },
    lifecycle: provisionLifecycleEvidence(payload),
  };
}

/** The provision path's lifecycle evidence, passed through to the slot result. */
function provisionLifecycleEvidence(payload: Record<string, unknown>): Record<string, unknown> {
  const evidence: Record<string, unknown> = { lifecycleState: payload.lifecycleState };
  for (const field of ["lifecycle", "resources", "timing"] as const) {
    if (payload[field] !== undefined) {
      evidence[field] = payload[field];
    }
  }
  return evidence;
}

function clampTimeoutMs(remainingMs: number, maxMs: number): number {
  return Math.max(1, Math.min(maxMs, Math.floor(remainingMs)));
}

export interface ManagedSlotProvisionPortDependencies {
  invokeTool: ManagedSlotToolInvoker;
  deviceManager: Pick<PlatformDeviceManager, "listDeviceImages">;
  androidConfigReader: Pick<AvdConfigReader, "readConfig">;
  timer: Pick<Timer, "now">;
  /** Release a session the reconciler obtained but could not publish (device kept). */
  releaseSession: (sessionUuid: string) => Promise<void>;
}

/** The `provisionDevice` path with `readiness: "automation"`. */
export class ToolManagedSlotProvisioner implements ManagedSlotDeviceProvisioner {
  constructor(private readonly deps: ManagedSlotProvisionPortDependencies) {}

  async provision(request: ManagedSlotProvisionRequest): Promise<ManagedSlotProvisionedDevice> {
    const spec =
      request.spec.deviceType === undefined
        ? { ...request.spec, deviceType: await this.existingModel(request) }
        : request.spec;
    const response = await this.deps.invokeTool(
      "provisionDevice",
      {
        device: {
          platform: request.platform,
          name: request.name,
          ...(request.platform === "ios" && request.deviceId ? { deviceId: request.deviceId } : {}),
          spec,
        },
        boot: true,
        readiness: "automation",
        timeoutMs: clampTimeoutMs(
          request.deadlineMs - this.deps.timer.now(),
          MAX_PROVISION_DEVICE_TIMEOUT_MS,
        ),
      },
      request.signal,
    );
    const { isError, payload } = readToolPayload(response);
    if (isError) {
      throw provisionErrorFromPayload(payload, `provisionDevice '${request.name}' failed`);
    }
    return provisionedDeviceFromPayload(payload, request.name);
  }

  releaseSession(sessionUuid: string): Promise<void> {
    return this.deps.releaseSession(sessionUuid);
  }

  /**
   * Adopting with an omitted model ("any model", owner decision Q4): the exact provision path
   * needs a model, so pass the device's own. Only adoption omits it; creation always carries the
   * resolver's choice. An unreadable model is unknown, never a guess.
   */
  private async existingModel(request: ManagedSlotProvisionRequest): Promise<string> {
    if (request.platform === "android") {
      const config = await this.deps.androidConfigReader.readConfig(request.name);
      const model = config?.deviceName;
      if (model) {
        return model;
      }
    } else {
      const images = await this.deps.deviceManager.listDeviceImages("ios", request.signal);
      const model = images.find((image) =>
        request.deviceId ? image.deviceId === request.deviceId : image.name === request.name,
      )?.deviceType;
      if (model) {
        return model;
      }
    }
    throw new ProvisionDeviceError(
      "discovery_incomplete",
      `The model of ${request.platform} device '${request.name}' could not be read.`,
    );
  }
}

/** Configured devices (AVDs, simulators) of one platform; a failed listing is incomplete. */
export class DeviceManagerSlotInventory implements ManagedSlotInventory {
  constructor(private readonly deviceManager: Pick<PlatformDeviceManager, "listDeviceImages">) {}

  async list(
    platform: SlotPlatform,
    options: { signal?: AbortSignal },
  ): Promise<ManagedSlotInventorySnapshot> {
    try {
      const devices = await this.deviceManager.listDeviceImages(platform, options.signal);
      return { complete: true, devices };
    } catch (error) {
      options.signal?.throwIfAborted();
      // Incomplete discovery is never authoritative absence; the reconciler refuses to act on it.
      logger.warn(
        `[ManagedSlots] ${platform} device inventory failed: ${errorMessage(error)}`,
        error,
      );
      return { complete: false, devices: [] };
    }
  }
}

export interface ManagedSlotClaimPool {
  getAllDevices(): PooledDevice[];
  /** Throws when another live daemon claims the device. */
  assertNotClaimedByForeignDaemon(deviceId: string, platform: SlotPlatform): Promise<void>;
}

/**
 * A device is held while a pooled runtime of it has a session, or another daemon claims it. A
 * running device whose runtime identity the pool cannot resolve is unknown, never free.
 */
export class PoolManagedSlotDeviceClaims implements ManagedSlotDeviceClaims {
  constructor(
    private readonly pool: ManagedSlotClaimPool,
    private readonly executions?: LiveExecutionSessions,
  ) {}

  isLiveExecution(sessionUuid: string): boolean {
    return this.executions?.isLiveManagedExecutionSession(sessionUuid) ?? false;
  }

  async describe(device: DeviceInfo): Promise<ManagedSlotDeviceClaim> {
    const runtimes = this.runtimesOf(device);
    const held = runtimes.find((pooled) => pooled.sessionId !== null);
    if (held) {
      return { kind: "held", reason: `session ${held.sessionId} holds ${held.id}` };
    }
    if (device.isRunning && device.isRunningStateKnown === false && runtimes.length === 0) {
      return { kind: "unknown", reason: "its running runtime could not be identified" };
    }
    for (const runtime of runtimes) {
      try {
        await this.pool.assertNotClaimedByForeignDaemon(runtime.id, device.platform);
      } catch (error) {
        return { kind: "held", reason: errorMessage(error) };
      }
    }
    return { kind: "free" };
  }

  sessionsOn(device: DeviceInfo): string[] {
    return this.runtimesOf(device).flatMap((pooled) =>
      pooled.sessionId ? [pooled.sessionId] : [],
    );
  }

  /** The pooled runtimes of a configured device (AVD name or simulator UDID). */
  private runtimesOf(device: DeviceInfo): PooledDevice[] {
    const stableId = deviceStableId(device);
    return this.pool
      .getAllDevices()
      .filter(
        (pooled) =>
          pooled.platform === device.platform &&
          (device.platform === "android"
            ? (pooled.avdName ?? pooled.name) === stableId
            : pooled.id === stableId),
      );
  }
}
