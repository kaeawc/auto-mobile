import type { InternalProvisionDeviceArgs } from "../../../features/deviceLifecycle/core/contracts";
import type { DeviceInfo } from "../../../models/index";
import {
  ProvisionDeviceError,
  type ProvisionDeviceFailureCode,
} from "../../../devices/exactDeviceProvisioning";
import { classifyDisplayCutout } from "../../../utils/displayCutout";
import type { PlatformDeviceManager } from "../../../devices/deviceUtils";
import type { AvdConfigReader } from "../../../utils/android-cmdline-tools/AvdConfigReader";
import { errorMessage } from "../../../utils/describeUnknownError";
import { logger } from "../../../utils/logger";
import { MAX_PROVISION_DEVICE_TIMEOUT_MS } from "../../../utils/deviceTimeouts";
import type { Timer } from "../../../utils/SystemTimer";
import {
  type BindingDeviceProvisioner,
  type BindingProvisionRequest,
  type BindingProvisionedDevice,
  type BindingResolvedSpec,
} from "./reconciler";

/** Invokes a registered tool handler in-process and returns its raw MCP tool response. */
export type BindingToolInvoker = (
  name: "provisionDevice" | "killDevice",
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
      logger.debug(`[Bindings] tool response text is not JSON: ${errorMessage(error)}`);
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

/** Device IDs arriving over a tool response retain only string entries. */
function deviceIdsField(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((id): id is string => typeof id === "string") : [];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** Read explicit retained-creation evidence rather than guessing from a timeout. */
function retainedProvisionDeviceIdentity(payload: Record<string, unknown>) {
  const lifecycle = payload.lifecycle;
  if (!isRecord(lifecycle) || !isRecord(lifecycle.device)) {
    return {};
  }
  const device = lifecycle.device;
  const name = stringField(device.name);
  const stableId = [stringField(device.stableId), stringField(device.runtimeDeviceId)].find(
    (id) => id !== undefined && id !== name,
  );
  const retainedDevice =
    lifecycle.state === "created_not_ready" &&
    lifecycle.phase === "readiness" &&
    device.platform === "ios" &&
    stableId &&
    name
      ? { platform: "ios" as const, stableId, name }
      : undefined;
  return retainedDevice ? { retainedDevice } : {};
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
  const externalDevices = deviceIdsField(error.externalDevices);
  const heldDevices = deviceIdsField(error.heldDevices);
  return new ProvisionDeviceError(code, message, retryable, {
    ...retainedProvisionDeviceIdentity(payload),
    ...(retryAfterMs !== undefined ? { retryAfterMs } : {}),
    ...(limit !== undefined && booted !== undefined
      ? {
          capacity: {
            limit,
            booted,
            ...(externalDevices.length > 0 ? { externalDevices } : {}),
            ...(heldDevices.length > 0 ? { heldDevices } : {}),
          },
        }
      : {}),
  });
}

/** Read the provisioned device, session and readiness from a provisionDevice success payload. */
export function provisionedDeviceFromPayload(
  payload: Record<string, unknown>,
  requestedName: string,
): BindingProvisionedDevice {
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

/** The provision path's lifecycle evidence, passed through to the binding result. */
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

export interface BindingProvisionPortDependencies {
  invokeTool: BindingToolInvoker;
  deviceManager: Pick<PlatformDeviceManager, "listDeviceImages">;
  androidConfigReader: Pick<AvdConfigReader, "readConfig">;
  timer: Pick<Timer, "now">;
  /** Release a session the reconciler obtained but could not publish (device kept). */
  releaseSession: (sessionUuid: string) => Promise<void>;
  /**
   * Whether a newly booted Android emulator should skip the quick-boot snapshot save at exit:
   * true when the host destroys released emulators instead of reusing them warm (#15477).
   */
  discardAndroidSnapshotOnExit?: () => boolean;
}

/** The `provisionDevice` path with `readiness: "automation"`. */
export class ToolBindingProvisioner implements BindingDeviceProvisioner {
  constructor(private readonly deps: BindingProvisionPortDependencies) {}

  async readExistingSpec(device: DeviceInfo): Promise<BindingResolvedSpec | null> {
    if (device.platform === "ios") {
      if (device.isAvailable === false || !device.runtime || !device.deviceType) {
        return null;
      }
      return {
        runtime: device.runtime,
        deviceType: device.deviceType,
        displayCutout: classifyDisplayCutout("ios", device.deviceType),
      };
    }
    return this.readExistingAndroidSpec(device.name);
  }

  private async readExistingAndroidSpec(name: string): Promise<BindingResolvedSpec | null> {
    try {
      const config = await this.deps.androidConfigReader.readConfig(name);
      if (!config?.systemImagePackage) {
        return null;
      }
      return {
        runtime: config.systemImagePackage,
        ...(config.deviceName
          ? {
              deviceType: config.deviceName,
              displayCutout: classifyDisplayCutout("android", config.deviceName),
            }
          : {}),
        configuration: {
          ...config.hardware,
          ...(config.ramSizeMb !== undefined ? { memoryMb: config.ramSizeMb } : {}),
          ...(config.screenWidth !== undefined ? { screenWidth: config.screenWidth } : {}),
          ...(config.screenHeight !== undefined ? { screenHeight: config.screenHeight } : {}),
          ...(config.screenDensity !== undefined ? { screenDensity: config.screenDensity } : {}),
        },
      };
    } catch (error) {
      logger.warn(
        `[Bindings] cannot resolve AVD config for '${name}': ${errorMessage(error)}`,
        error,
      );
      return null;
    }
  }

  async provision(request: BindingProvisionRequest): Promise<BindingProvisionedDevice> {
    const spec = {
      ...request.spec,
      deviceType: request.spec.deviceType ?? (await this.existingModel(request)),
    };
    const args: InternalProvisionDeviceArgs = {
      device: {
        platform: request.platform,
        name: request.name,
        ...(request.platform === "ios" && request.deviceId ? { deviceId: request.deviceId } : {}),
        spec,
      },
      boot: true,
      readiness: "automation",
      ...(request.platform === "android" && this.deps.discardAndroidSnapshotOnExit?.() === true
        ? { discardSnapshotOnExit: true }
        : {}),
      ...(request.platform === "ios" && request.mode === "create"
        ? { rollbackOnRetryableReadiness: false }
        : {}),
      timeoutMs: clampTimeoutMs(
        request.deadlineMs - this.deps.timer.now(),
        MAX_PROVISION_DEVICE_TIMEOUT_MS,
      ),
    };
    const response = await this.deps.invokeTool("provisionDevice", { ...args }, request.signal);
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
  private async existingModel(request: BindingProvisionRequest): Promise<string> {
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
