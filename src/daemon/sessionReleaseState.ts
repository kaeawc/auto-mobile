/** Positive evidence of release for this exact session incarnation. */
export function isSessionReleasing(
  manager: { getReleasingSession?(sessionId: string): unknown | null },
  sessionId: string,
  session: unknown,
): boolean {
  const releasingSession = manager.getReleasingSession?.(sessionId);
  return (
    releasingSession !== undefined && releasingSession !== null && releasingSession === session
  );
}
