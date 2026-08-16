/**
 * Minimal session-manager surface the capability resolver needs. Kept narrow
 * (YAGNI) so both the MCP tool registry and the daemon socket server can share
 * one base-session resolution without depending on the full SessionManager.
 */
export interface CapabilitySessionManager {
  getDeviceLabels(sessionUuid: string): Record<string, string> | undefined;
}

/**
 * Given a session UUID that may be a derived `${base}:${label}` device-label
 * session, return the BASE session UUID whose persisted tool profile governs
 * capability enforcement. Returns the input unchanged when it is already a base
 * session, when no session-manager is available, or when the label cannot be
 * resolved.
 *
 * Lifted from the daemon socket server's former
 * `getCapabilityProfileSessionUuid` (issue #4611 Gap A) so the MCP path
 * (`toolRegistry`) and the socket path (`assertSocketToolEnabled`) resolve the
 * base session identically instead of one path silently skipping enforcement.
 */
export function resolveCapabilityBaseSessionUuid(
  sessionUuid: string | undefined,
  sessionManager: CapabilitySessionManager | undefined,
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
