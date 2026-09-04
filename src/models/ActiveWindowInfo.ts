/**
 * Information about the currently active window on the device
 */
export interface ActiveWindowInfo {
  appId: string;
  activityName: string;
  layoutSeqSum: number;
  /** Optional classification for system dialogs or non-app surfaces */
  type?: string;
  /**
   * True when a focused SystemUI surface (notification shade, quick settings,
   * status bar owning focus, keyguard) is on top and owns input focus. In that
   * state `appId` mirrors the SystemUI surface (`com.android.systemui`) rather
   * than the app occluded behind it, so `waitFor.activeWindow.appId == <app>`
   * fails closed instead of matching an occluded app (issue #6078).
   */
  systemOverlay?: boolean;
}
