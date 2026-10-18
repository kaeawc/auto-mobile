import { ActionableError } from "./ActionableError";

/**
 * The target app is not installed, so there is nothing to act on. A subclass so callers can
 * tell "nothing to clean" from a real failure without matching message text.
 */
export class AppNotInstalledError extends ActionableError {}
