import type { PLAN_LABEL_SESSION_SOURCE } from "./sessionManager";

// Keep this leaf module free of runtime SessionManager imports (stream auth imports it too).
const planLabelSource: typeof PLAN_LABEL_SESSION_SOURCE = "plan-label";

/** Labels are judged for admission; ordinary sessions keep the existing lookup contract. */
export function sessionForIngress<T>(
  manager: {
    getSession(sessionId: string): T | null;
    peekSession?(sessionId: string): T | null;
  },
  sessionId: string,
): T | null {
  const session = manager.getSession(sessionId);
  if (typeof session === "object" && session !== null && "persistenceMetadata" in session) {
    const metadata = session.persistenceMetadata;
    if (
      typeof metadata === "object" &&
      metadata !== null &&
      "source" in metadata &&
      metadata.source === planLabelSource &&
      manager.peekSession
    ) {
      return manager.peekSession(sessionId);
    }
  }
  return session;
}
