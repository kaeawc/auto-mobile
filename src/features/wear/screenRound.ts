import type { AdbCommandRunner } from "../../utils/android-cmdline-tools/interfaces/AdbExecutor";
import { DUMPSYS_MAX_BUFFER } from "../../utils/android-cmdline-tools/dumpsysLimits";
import { logger } from "../../utils/logger";
import { errorMessage } from "../../utils/describeUnknownError";

/**
 * `Display.FLAG_ROUND` as `dumpsys display` prints it (#14948). Hypothesis: the flag name in
 * the default display's `DisplayInfo{...}` / `DisplayDeviceInfo{...}` line is unconfirmed on a
 * Wear image (docs/design-docs/plat/android/form-factors.md, checklist row 8).
 */
const ROUND_FLAG = /\bFLAG_ROUND\b/;
const DEFAULT_DISPLAY_INFO = /DisplayInfo\{[^\n]*\bdisplayId 0\b/;
const INTERNAL_DEVICE_INFO = /DisplayDeviceInfo\{[^\n]*\btype INTERNAL\b/;

/**
 * Whether the default display is round, or undefined when no display record names its flags.
 * A found record without `FLAG_ROUND` is a definite `false`.
 */
export function parseScreenRound(dumpsysDisplay: string): boolean | undefined {
  const lines = dumpsysDisplay.split(/\r?\n/);
  const record =
    lines.find((line) => DEFAULT_DISPLAY_INFO.test(line)) ??
    lines.find((line) => INTERNAL_DEVICE_INFO.test(line));
  return record === undefined ? undefined : ROUND_FLAG.test(record);
}

/** Reads `Configuration.isScreenRound` equivalent over adb; the result is static per boot. */
export interface ScreenRoundReader {
  isScreenRound(signal?: AbortSignal): Promise<boolean | undefined>;
}

export class AdbScreenRoundReader implements ScreenRoundReader {
  private cached: { value: boolean | undefined } | undefined;

  constructor(private readonly adb: AdbCommandRunner) {}

  async isScreenRound(signal?: AbortSignal): Promise<boolean | undefined> {
    if (this.cached) {
      return this.cached.value;
    }
    try {
      const result = await this.adb.executeCommand("shell dumpsys display", {
        timeoutMs: 2000,
        maxBuffer: DUMPSYS_MAX_BUFFER,
        noRetry: true,
        signal,
      });
      this.cached = { value: parseScreenRound(result.stdout) };
      return this.cached.value;
    } catch (error) {
      signal?.throwIfAborted();
      // Optional observe field: an unreadable display leaves it absent and is retried next time.
      logger.debug(`isScreenRound unavailable: ${errorMessage(error)}`);
      return undefined;
    }
  }
}
