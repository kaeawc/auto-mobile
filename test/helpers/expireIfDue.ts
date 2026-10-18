import type { Session, SessionManager } from "../../src/daemon/sessionManager";

/**
 * Run the manager's explicit expiry judgement (`expireIfDue`, the default lazy-lookup form: it
 * releases a session past its idle deadline and returns null) without going through
 * `getSession`. Expiry tests use this so they pin the command itself; each admission path keeps
 * one `getSession`-based assertion of its own.
 */
export function expireIfDue(manager: SessionManager, sessionId: string): Session | null {
  return manager["expireIfDue"](sessionId, false);
}
