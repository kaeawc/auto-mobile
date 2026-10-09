import type { ObserveResult, ScreenIdentity } from "../../../models";
import type { SwipeNavigationAssessment } from "./swipeNavigation";

/** How long a swipe waits for an SDK route event that may still be in flight. */
export const SDK_ROUTE_SETTLE_TIMEOUT_MS = 300;

/** What swipeOn needs from the Android client's SDK route store; times are on the host clock. */
export interface SdkRouteSource {
  receivedAtMs(packageName: string): number | undefined;
  awaitRouteAfter(
    packageName: string,
    sinceMs: number,
    timeoutMs: number,
  ): Promise<ScreenIdentity | undefined>;
}

function sdkPackage(observation: ObserveResult | undefined): string | undefined {
  const identity = observation?.screenIdentity;
  return identity?.platform === "android" && identity.source === "sdk"
    ? identity.components.bundleId
    : undefined;
}

/**
 * A post-swipe observation can be captured before the SDK's route event for the screen the swipe
 * opened reaches the host, in which case both observations carry the old route and the swipe reads
 * as having stayed put. When "stayed" rests on SDK routes alone and the post route was received
 * before the swipe ended, wait briefly for a newer one: a newer route replaces the post identity
 * (and is reassessed); none means the observation cannot say, so nothing is reported.
 */
export async function settleSdkRouteAssessment(
  assessment: SwipeNavigationAssessment | undefined,
  previous: ObserveResult | null,
  observation: ObserveResult | undefined,
  swipeEndedAtMs: number | undefined,
  source: SdkRouteSource | undefined,
  reassess: () => SwipeNavigationAssessment | undefined,
): Promise<SwipeNavigationAssessment | undefined> {
  const packageName = sdkPackage(observation);
  if (
    assessment?.navigated !== false ||
    !source ||
    !packageName ||
    !previous ||
    sdkPackage(previous) !== packageName ||
    swipeEndedAtMs === undefined
  ) {
    return assessment;
  }
  const receivedAtMs = source.receivedAtMs(packageName);
  if (receivedAtMs !== undefined && receivedAtMs > swipeEndedAtMs) {
    return assessment;
  }
  const newer = await source.awaitRouteAfter(
    packageName,
    swipeEndedAtMs,
    SDK_ROUTE_SETTLE_TIMEOUT_MS,
  );
  if (!newer) {
    return undefined;
  }
  if (observation) {
    observation.screenIdentity = newer;
  }
  return reassess();
}
