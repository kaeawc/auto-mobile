/**
 * Represents the screen dimensions of a device
 */
export interface ScreenSize {
  width: number;
  height: number;
}

export interface ScreenSizeForOffscreenCheckOptions {
  platform?: "android" | "ios";
  iosMultiPanel?: boolean;
  observationScreenSize?: ScreenSize;
  display?: { displayId?: number | null; panelUniqueId?: string | null };
}
