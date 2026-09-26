import type { TapOnElementResult } from "./TapOnElementResult";

/** TapAny reports the pre-action acquisition that supplied its selected target. */
export interface TapAnyElementResult extends TapOnElementResult {
  captureId?: string;
}
