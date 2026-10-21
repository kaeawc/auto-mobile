/**
 * A request ended focus navigation (cancelled, timed out, session released, or out of time
 * budget). Deliberately not an ActionableError: callers must never treat it as a navigation
 * failure with a coordinate fallback, because the request is over.
 */
export class FocusNavigationStoppedError extends Error {}
