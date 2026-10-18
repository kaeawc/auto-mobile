/**
 * Input pointer for a coordinate gesture. Omitted means the default finger touch.
 *
 * Only `stylus` at constant pressure is injectable today (`adb shell input stylus`): the shell
 * hard-codes pressure to 1.0, so any other value is refused rather than rounded (#13081).
 */
export interface PointerOption {
  toolType: "stylus";
  /** 0–1. The only value the Android backend can inject is 1. */
  pressure?: number;
}
