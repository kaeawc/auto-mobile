import { BaseVisualChange } from "../features/action/BaseVisualChange";
import type { ObserveScreen } from "../features/observe/interfaces/ObserveScreen";
import type { ObserveResult } from "../models";
import { ActionableError } from "../models/ActionableError";

export async function readObservationForInteractions(
  screen: Pick<ObserveScreen, "execute" | "getMostRecentCachedObserveResult">,
): Promise<ObserveResult> {
  let cachedResult = await screen.getMostRecentCachedObserveResult();
  const hasUsableCache = Boolean(
    cachedResult.viewHierarchy && !cachedResult.viewHierarchy.hierarchy.error,
  );
  if (hasUsableCache && BaseVisualChange.shouldRefetchCachedObservation(cachedResult)) {
    try {
      cachedResult = await screen.execute({ freshness: "fresh" });
    } catch (error) {
      throw new ActionableError("Unable to observe screen to identify interactions.", {
        cause: error,
      });
    }
    if (!cachedResult.viewHierarchy || cachedResult.viewHierarchy.hierarchy.error) {
      throw new ActionableError("Unable to observe screen to identify interactions.", {
        cause: new Error(
          cachedResult.viewHierarchy?.hierarchy.error ?? "No view hierarchy returned.",
        ),
      });
    }
  }
  return cachedResult;
}
