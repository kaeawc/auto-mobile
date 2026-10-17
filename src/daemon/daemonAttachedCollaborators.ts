import { ActionableError } from "../models/ActionableError";

/**
 * Defaults for the collaborators the daemon attaches to SessionManager after construction (to
 * break the SessionManager/DevicePool cycle). They are silent no-ops (no execution veto, no
 * cancellation), so a forgotten wire would change behaviour without any signal. Each is a single
 * identity so the daemon can tell "never attached" from "attached".
 */
export const UNATTACHED = {
  activeSessionExecutionChecker: () => false,
  sessionExecutionDeadlineLookup: () => undefined,
  expiryReleaseExecutionCanceller: () => undefined,
  deviceAcquisitionExecutionCanceller: () => undefined,
} as const;

/** Throw an ActionableError naming every collaborator still holding its UNATTACHED default. */
export function assertCollaboratorsAttached(
  owner: string,
  current: Readonly<Record<string, unknown>>,
): void {
  const missing = Object.entries(current)
    .filter(
      ([name, value]) =>
        value === undefined || value === (UNATTACHED as Record<string, unknown>)[name],
    )
    .map(([name]) => name);
  if (missing.length > 0) {
    throw new ActionableError(
      `${owner} is missing daemon-attached collaborators: ${missing.join(", ")}.`,
    );
  }
}
