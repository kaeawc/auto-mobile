/** Maximum duration leaves room for the shake action's 2s request-timeout headroom. */
export const SHAKE_DURATION_MIN_MS = 1;
export const SHAKE_DURATION_MAX_MS = 1_798_000;

/** Conservative upper bound for emulator acceleration input. */
export const SHAKE_INTENSITY_MIN = 1;
export const SHAKE_INTENSITY_MAX = 1_000;

/**
 * Options for performing a shake operation
 */
export interface ShakeOptions {
  /**
   * Duration of the shake in milliseconds (default: 1000ms)
   */
  duration?: number;

  /**
   * Intensity of the shake acceleration (default: 100)
   * Higher values create more intense shaking
   */
  intensity?: number;
}
