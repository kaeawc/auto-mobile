import type { AdbExecutor } from "../../utils/android-cmdline-tools/interfaces/AdbExecutor";
import { combineWithAmbientAbort } from "../../utils/AbortContext";
import { deviceIncarnationToken } from "../../utils/deviceIncarnation";
import { errorMessage } from "../../utils/describeUnknownError";
import { logger } from "../../utils/logger";
import type { Timer } from "../../utils/SystemTimer";
import {
  clearResolvedHomePackageCache,
  isForegroundLauncher,
} from "../observe/androidLauncherPackages";
import type { Window } from "../observe/interfaces/Window";

type HomeProbe = "verified" | "expired" | "not-home";

export interface HomeForegroundVerifyOptions {
  signal?: AbortSignal;
  timeoutMs?: number;
  retryDelaysMs?: readonly number[];
  onVerifiedForeground?: (appId: string) => void;
}

export interface HomeForegroundVerifierDependencies {
  readonly window: Pick<Window, "getActive">;
  readonly adb: AdbExecutor;
  readonly deviceId: string;
  readonly timer: Timer;
}

export class HomeForegroundVerifier {
  private readonly window: HomeForegroundVerifierDependencies["window"];
  private readonly adb: AdbExecutor;
  private readonly deviceId: string;
  private readonly timer: HomeForegroundVerifierDependencies["timer"];

  constructor(deps: HomeForegroundVerifierDependencies) {
    this.window = deps.window;
    this.adb = deps.adb;
    this.deviceId = deps.deviceId;
    this.timer = deps.timer;
  }

  /**
   * Confirm that a "go home" action actually backgrounded the foreground app
   * by re-reading the foreground window and checking it against the
   * device's actually-configured HOME launcher, instead of trusting a
   * dispatch method's self-reported success (issue #6147: on API 28 the
   * accessibility global action for "home" can report success while the
   * foreground app is unchanged).
   *
   * Retries with short backoffs (via the injected `Timer`, so `FakeTimer`
   * keeps tests fast/deterministic) to tolerate the brief settle time a real
   * device needs between dispatch and the launcher taking focus.
   *
   * @param options.signal - Cancellation signal. Combined ONCE at entry with the
   *   ambient request signal (see {@link combineWithAmbientAbort}) and that
   *   combined signal is used for EVERY device read (`getActive`'s
   *   dumpsys/api-level/legacy reads and the launcher resolve) AND for the
   *   abort-classification check below. This matters on the normal MCP route
   *   where the caller passes no explicit `signal`: `getActive` combines the
   *   ambient signal internally and rejects on cancellation, so classifying the
   *   abort against the raw (undefined) `options.signal` would mis-log it as an
   *   ordinary read failure and keep sleeping/retrying. An abort rejects out of
   *   the reads and BREAKS the retry loop (it is re-thrown), so a cancelled
   *   verification never silently reports `false` as a device verdict.
   * @param options.timeoutMs - REMAINING budget for the whole verification, not a
   *   per-read budget. An absolute deadline is derived once and each `getActive`
   *   read, launcher lookup, and retry backoff spends only the time that remains,
   *   so verification cannot overrun the caller's deadline (e.g. a home press
   *   with one second left must not occupy the keyed device-input op for the
   *   full 5s `getActive` default plus launcher resolution and retries).
   * @param options.retryDelaysMs - Backoff delays between verification attempts.
   *   Defaults chosen to give a real device a couple of short chances to
   *   settle without materially slowing down a genuine failure. A backoff is
   *   skipped when it would push past the deadline.
   */
  async verify(options: HomeForegroundVerifyOptions = {}): Promise<boolean> {
    const verified = await this.readForeground(options);
    if (!verified) {
      // Self-heal a launcher cache that may no longer describe this device
      // (#6863 review). The cached configured-HOME package is
      // invalidated by a connection-epoch change, but in direct mode no
      // incarnation resolver is registered, so a reconnect or a reused serial
      // leaves the entry looking valid. A failed verification is the only
      // evidence available that the cached package may be the previous
      // runtime's, so drop it and let the next press re-resolve rather than
      // keep reporting real Home presses as failures. A cancellation rethrows
      // above and never reaches here -- an aborted read is not evidence.
      clearResolvedHomePackageCache(this.deviceId);
    }
    return verified;
  }

  /**
   * The retry loop behind {@link HomeForegroundVerifier.verify}. Split out so the
   * failure path has exactly one place to self-heal the launcher cache,
   * regardless of which of the loop's several `return false` exits was taken.
   */
  private async readForeground(options: HomeForegroundVerifyOptions): Promise<boolean> {
    // Combine explicit + ambient ONCE so the reads and the abort classification
    // below observe the SAME signal (issue #6289): on the ambient-only route the
    // explicit signal is undefined, so checking it alone would miss the abort.
    const signal = combineWithAmbientAbort(options.signal);
    const { timeoutMs } = options;
    const retryDelaysMs = options.retryDelaysMs ?? [150, 300];
    // Single absolute deadline shared across reads, launcher lookup, and
    // backoffs. Never 0/negative downstream: getActive/resolve clamp to >= 1ms.
    const deadlineMs = timeoutMs !== undefined ? this.timer.now() + timeoutMs : undefined;
    const remainingMs = (): number | undefined =>
      deadlineMs === undefined ? undefined : deadlineMs - this.timer.now();
    for (let attempt = 0; ; attempt++) {
      try {
        // A cancellation is surfaced by the reads themselves: getActive combines
        // the ambient signal and rejects on abort, and the catch below rethrows
        // any error while `signal.aborted`. Pre-checking `throwIfAborted()` here
        // would raise the raw AbortError before the read runs, mis-typing an
        // ambient-only cancellation instead of letting the read's own
        // OPERATION_CANCELLED rejection propagate (issue #6289).
        const probe = await this.probeHomeForeground(signal, remainingMs, options);
        if (probe !== "not-home") {
          return probe === "verified";
        }
      } catch (error) {
        // A cancellation must not be masked as "not the launcher": rethrow so the
        // caller sees the abort rather than a false failure verdict.
        if (signal?.aborted) {
          throw error;
        }
        logger.warn(
          `[BaseVisualChange] Failed to read foreground app while verifying home press: ${errorMessage(error)}`,
          error,
        );
      }
      const delay = retryDelaysMs[attempt];
      // Don't sleep past the shared deadline: a backoff that would overrun the
      // remaining budget ends verification now instead of stalling the keyed op.
      const remaining = remainingMs();
      if (delay === undefined || (remaining !== undefined && remaining <= delay)) {
        return false;
      }
      await this.timer.sleep(delay);
    }
  }

  /** One foreground read plus launcher check, bounded by the shared deadline. */
  private async probeHomeForeground(
    signal: AbortSignal | undefined,
    remainingMs: () => number | undefined,
    options: { onVerifiedForeground?: (appId: string) => void },
  ): Promise<HomeProbe> {
    // Do not revive an expired verification budget by handing its zero value
    // to Window, which must clamp subcommand timeouts to keep those commands
    // bounded. No device read is valid once this operation's deadline passed.
    if ((remainingMs() ?? 1) <= 0) {
      return "expired";
    }
    const readBounds = () => ({ signal, timeoutMs: remainingMs() });
    const activeWindow = await this.window.getActive(true, undefined, readBounds());
    if ((remainingMs() ?? 1) <= 0) {
      return "expired";
    }
    const { deviceId } = this;
    const isLauncher = await isForegroundLauncher(
      activeWindow.appId,
      this.adb,
      deviceId,
      this.timer,
      { ...readBounds(), incarnationToken: deviceIncarnationToken(deviceId) },
    );
    // A successful launcher lookup is evidence only while it remains within
    // the caller's deadline; a fast cached lookup must not accept success
    // after a preceding foreground read spent the budget.
    if (isLauncher && (remainingMs() ?? 1) > 0) {
      options.onVerifiedForeground?.(activeWindow.appId);
      return "verified";
    }
    return "not-home";
  }
}
