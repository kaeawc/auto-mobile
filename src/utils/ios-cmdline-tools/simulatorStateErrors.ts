/**
 * True when a simctl shutdown error only reports that the simulator is already stopped.
 * Shared by the kill/delete teardown and the created-simulator rollback so both
 * tolerate the same "already shut down" outcomes.
 */
export function isIosSimulatorAlreadyStoppedError(error: unknown): boolean {
  const message = String(error instanceof Error ? error.message : error).toLowerCase();
  return (
    message.includes("already shut down") ||
    message.includes("already shutdown") ||
    message.includes("not booted") ||
    message.includes("invalid device state") ||
    message.includes("current state: shutdown")
  );
}
