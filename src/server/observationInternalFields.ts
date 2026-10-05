import { terminalScreenshotUnavailable } from "../utils/PostActionCaptureContext";
import type { ObserveResult } from "../models/ObserveResult";

type ObservationWithInternalFields = Pick<
  ObserveResult,
  "screenshotCaptureAttempted" | "displayRevision"
> & { [terminalScreenshotUnavailable]?: boolean };

/** Removes observation fields that are retained internally but must not reach clients. */
export function stripInternalObservationFields(observation: ObservationWithInternalFields): void {
  delete observation.screenshotCaptureAttempted;
  delete observation.displayRevision;
  delete observation[terminalScreenshotUnavailable];
}
