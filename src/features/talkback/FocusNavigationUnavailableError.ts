import { ActionableError } from "../../models";

/**
 * Focus navigation could not start: nothing was dispatched, so the screen is exactly as it was
 * observed and a caller may still use a non-cursor activation. Every other navigation failure
 * happens after a focus request was sent and must never fall back to a coordinate tap.
 */
export class FocusNavigationUnavailableError extends ActionableError {}
