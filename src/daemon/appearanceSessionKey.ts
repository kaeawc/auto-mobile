import { defaultDaemonContext, type DaemonContext } from "./daemonContext";
import { resolveToolSelectionBaseSessionUuid } from "../features/toolSelection/selectionSessionResolver";

/**
 * The key a session's appearance config is stored under (#10976): its base session UUID, so a
 * derived `${base}:${label}` device session shares its owner's config. Undefined without a
 * session, which selects the global config.
 */
export function resolveAppearanceSessionKey(
  sessionId: string | undefined,
  daemon: DaemonContext = defaultDaemonContext,
): string | undefined {
  const trimmed = sessionId?.trim();
  if (!trimmed) {
    return undefined;
  }
  const sessionManager = daemon.sessionManager();
  return sessionManager
    ? (resolveToolSelectionBaseSessionUuid(trimmed, sessionManager) ?? trimmed)
    : trimmed;
}
