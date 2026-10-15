export interface UiStabilityResult {
  isStable: boolean;
  /** Non-empty gfxinfo output contained no valid frame metrics. */
  noFrameData?: boolean;
  shouldUpdateLastNonIdleTime: boolean;
  updatedPrevMissedVsync: number | null;
  updatedPrevSlowUiThread: number | null;
  updatedPrevFrameDeadlineMissed: number | null;
  updatedPrevTotalFrames: number | null;
  updatedFirstGfxInfoLog: boolean;
}
