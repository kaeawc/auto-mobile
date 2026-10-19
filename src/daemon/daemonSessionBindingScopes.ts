import { ActionableError } from "../models/ActionableError";

/** The only operation the daemon needs from the server's keyed session tool-binding store. */
export interface SessionBindingScopeForgetter {
  forget(scopeKey: string): void;
}

let provider: (() => SessionBindingScopeForgetter) | undefined;

/** Installed by the server module that owns the process-wide binding store. */
export function installDaemonSessionBindingScopes(
  scopes: () => SessionBindingScopeForgetter,
): void {
  provider = scopes;
}

/**
 * Drops the keyed bindings behind `scopeKey` (a connection or request scope that went away).
 * Fails loudly when the server has not installed its store: a dropped forget would leave a dead
 * session's tool binding live for the next request that presents the key.
 */
export function forgetDaemonSessionBindingScope(scopeKey: string): void {
  if (!provider) {
    throw new ActionableError(
      "The session tool-binding store is not installed in this process. Load src/server/daemonSessionToolBindingStore before the daemon forgets binding scopes.",
    );
  }
  provider().forget(scopeKey);
}
