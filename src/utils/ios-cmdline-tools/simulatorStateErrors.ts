import { classifySimctlFailure, simctlFailureText } from "./simctlFailureClassifier";

/**
 * Other wordings, matched case-insensitively in the message only, for a shutdown of a
 * simulator that is already stopped.
 */
const ALREADY_STOPPED_PHRASES = [
  "already shut down",
  "already shutdown",
  "not booted",
  "invalid device state",
  "current state: shutdown",
];

/**
 * True when a simctl shutdown error only reports that the simulator is already stopped.
 * Shared by the kill/delete teardown and the created-simulator rollback so both
 * tolerate the same "already shut down" outcomes. The "current state: Shutdown" rejection
 * is decided by {@link classifySimctlFailure} over the stderr and message, so its code
 * (405, 163 or 165 depending on the Xcode version) does not matter (#14116).
 */
export function isIosSimulatorAlreadyStoppedError(error: unknown): boolean {
  if (
    classifySimctlFailure("shutdown", simctlFailureText(error)).kind === "already-in-target-state"
  ) {
    return true;
  }
  const message = String(error instanceof Error ? error.message : error).toLowerCase();
  return ALREADY_STOPPED_PHRASES.some((phrase) => message.includes(phrase));
}
