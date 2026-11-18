import { ActionableError, toActionableError } from "../../models/ActionableError";
import type { BootedDevice } from "../../models";
import type { PROTOTYPE_PLATFORM_ERROR_CODES } from "./prototypePlatform";

/**
 * The prototype half of `biometricAuth {action: "cancel" | "error"}` (#14328). The emulator and
 * Simulator cannot produce a cancelled, lockout or not-enrolled prompt, so when the device's
 * active target is a shown prototype that declares `biometric` in `requires.platform`, the
 * outcome is handed to its runtime instead of the in-app SDK. Outcomes use the #14294 typed codes
 * the runtime's `biometric.authenticate` reports: `cancelled`, `unavailable` with a reason, or
 * `platform_error`.
 */

type PlatformErrorCode = (typeof PROTOTYPE_PLATFORM_ERROR_CODES)[number];

export const PROTOTYPE_BIOMETRIC_UNAVAILABLE_REASONS = [
  "lockout",
  "not_enrolled",
  "no_hardware",
] as const;
export type PrototypeBiometricUnavailableReason =
  (typeof PROTOTYPE_BIOMETRIC_UNAVAILABLE_REASONS)[number];

export type PrototypeBiometricOverride =
  | { code: Extract<PlatformErrorCode, "cancelled"> }
  | { code: Extract<PlatformErrorCode, "unavailable">; reason: PrototypeBiometricUnavailableReason }
  | { code: Extract<PlatformErrorCode, "platform_error">; errorCode?: number };

/**
 * `BiometricPrompt.BIOMETRIC_ERROR_*` constants, mapped as the Android runtime's callback maps
 * them, so `errorCode` means the same thing on a prototype as on an SDK-integrated app.
 */
const ANDROID_ERROR_OUTCOMES: Readonly<Record<number, PrototypeBiometricOverride>> = {
  1: { code: "unavailable", reason: "no_hardware" }, // HW_UNAVAILABLE
  5: { code: "cancelled" }, // CANCELED
  7: { code: "unavailable", reason: "lockout" }, // LOCKOUT
  9: { code: "unavailable", reason: "lockout" }, // LOCKOUT_PERMANENT
  10: { code: "cancelled" }, // USER_CANCELED
  11: { code: "unavailable", reason: "not_enrolled" }, // NO_BIOMETRICS
  12: { code: "unavailable", reason: "no_hardware" }, // HW_NOT_PRESENT
  14: { code: "unavailable", reason: "not_enrolled" }, // NO_DEVICE_CREDENTIAL
};

export function prototypeBiometricOverride(
  action: "cancel" | "error",
  errorCode?: number,
): PrototypeBiometricOverride {
  if (action === "cancel") {
    return { code: "cancelled" };
  }
  const mapped = errorCode === undefined ? undefined : ANDROID_ERROR_OUTCOMES[errorCode];
  return mapped ?? { code: "platform_error", ...(errorCode === undefined ? {} : { errorCode }) };
}

export interface PrototypeBiometricTarget {
  /** The shown prototype's id. */
  id: string;
  /** Whether its runtime accepts a biometric override. */
  acceptsOverride: boolean;
}

export interface PrototypeBiometricReply {
  success: boolean;
  error?: string;
}

/** The device's shown prototype, reached over the authenticated prototype connection. */
export interface PrototypeBiometricRoute {
  /** The shown prototype declaring `biometric`, or `undefined` when the target is not one. */
  target(device: BootedDevice): Promise<PrototypeBiometricTarget | undefined>;
  deliver(
    device: BootedDevice,
    id: string,
    override: PrototypeBiometricOverride,
    ttlMs: number,
  ): Promise<PrototypeBiometricReply>;
}

export type PrototypeBiometricOverrideFailure = "unsupported" | "rejected";

/** A prototype was the target but did not take the override; nothing reached the in-app SDK. */
export class PrototypeBiometricOverrideError extends ActionableError {
  constructor(
    message: string,
    readonly failure: PrototypeBiometricOverrideFailure,
    readonly override: PrototypeBiometricOverride,
    options?: ErrorOptions,
  ) {
    super(message, options);
  }
}

export interface PrototypeBiometricRequest {
  action: string;
  modality?: "any" | "fingerprint" | "face";
  errorCode?: number;
  ttlMs?: number;
}

export interface PrototypeBiometricRouted {
  success: true;
  message: string;
  action: "cancel" | "error";
  modality: "any" | "fingerprint" | "face";
  supported: true;
  errorCode?: number;
  route: "prototype";
  prototypeId: string;
  outcome: PrototypeBiometricOverride;
}

const DEFAULT_TTL_MS = 5000;

function outcomeLabel(override: PrototypeBiometricOverride): string {
  return override.code === "unavailable" ? `unavailable (${override.reason})` : override.code;
}

/**
 * Route a cancel or error to the active prototype. `undefined` means the target is not a
 * prototype, so the caller keeps the emulator, Simulator and in-app SDK paths.
 */
export async function routePrototypeBiometric(
  route: PrototypeBiometricRoute | undefined,
  device: BootedDevice,
  request: PrototypeBiometricRequest,
): Promise<PrototypeBiometricRouted | undefined> {
  if (!route || (request.action !== "cancel" && request.action !== "error")) {
    return undefined;
  }
  const target = await route.target(device);
  if (!target) {
    return undefined;
  }
  const override = prototypeBiometricOverride(request.action, request.errorCode);
  if (!target.acceptsOverride) {
    throw new PrototypeBiometricOverrideError(
      `The shown prototype ${target.id} does not accept biometric overrides, so ${request.action} cannot produce ${outcomeLabel(override)}. Update the prototype runtime, or test this outcome host-side with simulate.`,
      "unsupported",
      override,
    );
  }
  let reply: PrototypeBiometricReply;
  try {
    reply = await route.deliver(device, target.id, override, request.ttlMs ?? DEFAULT_TTL_MS);
  } catch (error) {
    throw toActionableError(
      error,
      `Failed to deliver biometric ${outcomeLabel(override)} to prototype ${target.id}`,
    );
  }
  if (!reply.success) {
    throw new PrototypeBiometricOverrideError(
      `Prototype ${target.id} refused biometric ${outcomeLabel(override)}: ${reply.error ?? "no reason given"}. Show a prototype whose biometric.authenticate call is pending and retry.`,
      "rejected",
      override,
    );
  }
  return {
    success: true,
    message: `Biometric ${outcomeLabel(override)} delivered to prototype ${target.id}`,
    action: request.action,
    modality: request.modality ?? "any",
    supported: true,
    ...(request.errorCode === undefined ? {} : { errorCode: request.errorCode }),
    route: "prototype",
    prototypeId: target.id,
    outcome: override,
  };
}
