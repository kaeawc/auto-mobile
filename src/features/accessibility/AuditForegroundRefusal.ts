import type { ObserveResult } from "../../models";

/**
 * The refusal both accessibility audit engines return when a requested appId is not the app on
 * screen (#17281, #17303). Each engine audits the foreground screen, so another app's screen
 * would otherwise be judged, or the iOS runner would fail with a raw XCUITest error.
 */
export function auditForegroundRefusal(appId: string, foreground?: string): string {
  const current = foreground ? ` (${foreground} is)` : "";
  return `The accessibility audit checks the foreground screen; ${appId} is not in the foreground${current}. Bring ${appId} to the foreground or omit appId.`;
}

/**
 * The observed foreground app, or undefined when the observation could not be verified as the
 * current screen: a stale cached tree names the previous app and would refuse the app on screen.
 */
export function verifiedForegroundApp(
  observation: Pick<ObserveResult, "activeWindow" | "freshness">,
): string | undefined {
  return observation.freshness?.isFresh === false ? undefined : observation.activeWindow?.appId;
}
