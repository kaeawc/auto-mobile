import { IOS_BIOMETRIC_ENROLLMENT_NOTIFICATION } from "../../../features/utility/device-state/BiometricState";
import type { DeviceMutationInput } from "./types";

/**
 * iOS Simulator biometric enrollment is a notifyd state, not a simctl setting, so the baseline
 * clean never restores it and it survives a keep-booted reuse (#14359). The prior reader records
 * `enrolled` / `not_enrolled`; anything else is not restorable.
 */
export function iosBiometricEnrollmentTarget(
  mutation: Pick<DeviceMutationInput, "key" | "priorValue">,
): boolean | undefined {
  if (mutation.key !== "device" || mutation.priorValue.state !== "present") {
    return undefined;
  }
  const prior = mutation.priorValue.value;
  return prior === "enrolled" ? true : prior === "not_enrolled" ? false : undefined;
}

/**
 * The same register, set, read and post sequence the tool writes with: the state only persists
 * when the setting process registered the key first.
 */
export function iosBiometricRevertArgs(udid: string, enrolled: boolean): string[] {
  const key = IOS_BIOMETRIC_ENROLLMENT_NOTIFICATION;
  return [
    "spawn",
    udid,
    "notifyutil",
    "-1",
    key,
    "-s",
    key,
    enrolled ? "1" : "0",
    "-g",
    key,
    "-p",
    key,
  ];
}
