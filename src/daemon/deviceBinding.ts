import type { DeviceStatus } from "./devicePool";

/** The pool side owns binding mutations; session-side maps keep their existing lifecycle. */
export interface BindingFields {
  sessionId: string | null;
  status: DeviceStatus;
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

export function statusOf(device: Pick<BindingFields, "status">): DeviceStatus {
  return device.status;
}

export function isIdle(device: Pick<BindingFields, "status"> | null | undefined): boolean {
  return device?.status === "idle";
}

export function isBusy(device: Pick<BindingFields, "status"> | null | undefined): boolean {
  return device?.status === "busy";
}

export function isErrored(device: Pick<BindingFields, "status"> | null | undefined): boolean {
  return device?.status === "error";
}

export function bindDevice(device: BindingFields, sessionId: string): void {
  device.sessionId = sessionId;
  device.status = "busy";
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
  }
  return true;
}

export function restoreBinding(
  device: BindingFields,
  snapshot: Pick<BindingFields, "sessionId" | "status">,
): void {
  device.sessionId = snapshot.sessionId;
  device.status = snapshot.status;
}

export function markDeviceError(device: BindingFields): void {
  // Health verdict, not ownership: a later PR moves this into a separate health field.
  device.status = "error";
}

export function clearDeviceError(device: BindingFields): void {
  device.status = "idle";
}
