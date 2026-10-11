/** Narrow session-manager surface required to resolve derived device labels. */
export interface ToolSelectionSessionManager {
  getDeviceLabels(sessionUuid: string): Record<string, string> | undefined;
}

/** Resolve a derived `${base}:${label}` session to the base profile owner. */
export function resolveToolSelectionBaseSessionUuid(
  sessionUuid: string | undefined,
  sessionManager: ToolSelectionSessionManager | undefined,
): string | undefined {
  if (!sessionUuid || !sessionManager) {
    return sessionUuid;
  }
  for (
    let separatorIndex = sessionUuid.lastIndexOf(":");
    separatorIndex >= 0;
    separatorIndex = sessionUuid.lastIndexOf(":", separatorIndex - 1)
  ) {
    const candidateBaseSessionUuid = sessionUuid.slice(0, separatorIndex);
    const deviceLabels = sessionManager.getDeviceLabels(candidateBaseSessionUuid);
    if (deviceLabels && Object.values(deviceLabels).includes(sessionUuid)) {
      return candidateBaseSessionUuid;
    }
  }
  return sessionUuid;
}

/**
 * The session that speaks for `sessionUuid` wherever ownership is judged or recorded (#11586,
 * #11602): a derived `${base}:${label}` session counts as its base, and a label published under
 * another label session as the outermost base. Any other id is its own.
 */
export function resolveOwnershipSessionUuid(
  sessionUuid: string,
  sessionManager: ToolSelectionSessionManager,
): string {
  // Each hop is a strict prefix of the last, so this ends.
  for (let current = sessionUuid; ;) {
    const base = resolveToolSelectionBaseSessionUuid(current, sessionManager) ?? current;
    if (base === current) {
      return current;
    }
    current = base;
  }
}
