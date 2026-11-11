import type { ObserveResult } from "../../models";

/** Window focus and the hierarchy package may belong to XR SystemUI even while an app is foreground. */
export function xrForegroundApp(
  observation: Pick<ObserveResult, "activeWindow" | "backStack">,
): string | undefined {
  return (
    observation.activeWindow?.appId ||
    observation.backStack?.tasks.find((task) => task.id === observation.backStack?.currentTaskId)
      ?.packageName
  );
}
