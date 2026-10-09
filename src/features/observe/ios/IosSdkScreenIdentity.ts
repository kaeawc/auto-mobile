import type { ScreenIdentity } from "../../../models";
import { deriveSdkNavigationScreenIdentity } from "../sdkScreenIdentity";

/**
 * Build a high-confidence screen identity from an iOS SDK navigation event.
 * The caller owns event ordering and stores the newest result per bundle.
 */
export function deriveIosSdkScreenIdentity(
  eventType: string,
  applicationId: string | null | undefined,
  payload: Record<string, unknown>,
): ScreenIdentity | undefined {
  if (eventType !== "navigation") {
    return undefined;
  }
  return deriveSdkNavigationScreenIdentity("ios", applicationId, payload);
}
