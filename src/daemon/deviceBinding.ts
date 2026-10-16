import type { DeviceStatus } from "./devicePool";

export type BindingStatus = "idle" | "busy";
export type DeviceHealth = "ok" | "error";

/** The pool side owns binding mutations; session-side maps keep their existing lifecycle. */
export interface BindingFields {
  sessionId: string | null;
  status: BindingStatus;
  /** Absence is equivalent to healthy for older in-memory literals. */
  health?: DeviceHealth;
}

export function holderOf(device: Pick<BindingFields, "sessionId">): string | null;
export function holderOf(
  device: Pick<BindingFields, "sessionId"> | null | undefined,
): string | null | undefined;
export function holderOf(
  device: Pick<BindingFields, "sessionId"> | null | undefined,
): string | null | undefined {
  return device?.sessionId;
}

export function statusOf(device: Pick<BindingFields, "status" | "health">): DeviceStatus {
  return device.health === "error" ? "error" : device.status;
}

export function isIdle(
  device: Pick<BindingFields, "status" | "health"> | null | undefined,
): boolean {
  return device?.status === "idle" && device.health !== "error";
}

export function isBusy(
  device: Pick<BindingFields, "status" | "health"> | null | undefined,
): boolean {
  return device?.status === "busy" && device.health !== "error";
}

export function isErrored(
  device: Pick<BindingFields, "status" | "health"> | null | undefined,
): boolean {
  return device?.health === "error";
}

export function bindDevice(device: BindingFields, sessionId: string): void {
  device.sessionId = sessionId;
  device.status = "busy";
  device.health = "ok";
}

export function unbindDevice(
  device: BindingFields,
  opts?: { expectedSessionId?: string | null; status?: "idle" | "keep" },
): boolean {
  if (opts?.expectedSessionId !== undefined && opts.expectedSessionId !== device.sessionId) {
    return false;
  }
  device.sessionId = null;
  if (opts?.status !== "keep") {
    device.status = "idle";
    device.health = "ok";
  }
  return true;
}

/** Raw rollback state stays inside the binding owner, rather than the legacy projection. */
export function snapshotBinding(device: BindingFields): BindingFields {
  return { sessionId: device.sessionId, status: device.status, health: device.health };
}

export function restoreBinding(device: BindingFields, snapshot: BindingFields): void {
  device.sessionId = snapshot.sessionId;
  device.status = snapshot.status;
  device.health = snapshot.health;
}

export function markDeviceError(device: BindingFields): void {
  device.health = "error";
}

export function clearDeviceError(device: BindingFields): void {
  device.health = "ok";
  // Legacy clear always made the device idle, even if a holder was still attached.
  device.status = "idle";
}
