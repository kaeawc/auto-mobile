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
