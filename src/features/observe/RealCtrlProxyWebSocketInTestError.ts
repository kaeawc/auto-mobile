import { ActionableError } from "../../models/ActionableError";

/**
 * Thrown by {@link assertUnitTestRealWebSocketAllowed}. It is a test-harness
 * misconfiguration, not a connect failure: every catch on the connect path
 * rethrows it before recording a failed attempt, so a leaking unit test fails
 * loudly and never counts toward the platform clients' service recovery or
 * restart (which would act on an attached device).
 */
export class RealCtrlProxyWebSocketInTestError extends ActionableError {
  constructor(message: string) {
    super(message);
    this.name = "RealCtrlProxyWebSocketInTestError";
  }
}
