import type { ViewHierarchyResult } from "../../models";
import type { TapOnElementOptions } from "../../models/TapOnElementOptions";
import type { ScreenSizeForOffscreenCheckOptions } from "../utility/ElementGeometry";

/** Internal I/O seam: decisions and timing remain shared with the default tap path. */
export interface AndroidTapVerification {
  refresh: (timeoutMs: number) => Promise<ViewHierarchyResult | null>;
  dispatch?: (point: { x: number; y: number }) => Promise<void>;
}

export type TapVerificationOptions = TapOnElementOptions & {
  verification?: AndroidTapVerification;
  screenSizeOptions?: ScreenSizeForOffscreenCheckOptions;
};
