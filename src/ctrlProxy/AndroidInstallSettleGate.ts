import { ActionableError, toActionableError } from "../models/ActionableError";
import type { BootedDevice } from "../models";
import type { AdbCommandRunner } from "../utils/android-cmdline-tools/interfaces/AdbExecutor";
import { isAndroidFrameworkUnavailable } from "../utils/android-cmdline-tools/isAndroidFrameworkUnavailable";
import { sequenceBackoff, type BackoffPolicy } from "../utils/Backoff";
import { DefaultRetryExecutor } from "../utils/retry/RetryExecutor";
import { runPhaseWithSettlement } from "../utils/runPhaseWithSettlement";
import type { Timer } from "../utils/SystemTimer";
import { logger } from "../utils/logger";
import { isForegroundUserPending, resolveSetupUser } from "./setupUser";
import { ForegroundUserUnreadableError } from "./ForegroundUserUnreadableError";

/** Only the framework signals needed before installing on a newly booted AAOS/Wear device. */
export interface AndroidInstallSettleProbe {
  packageManagerReady(signal: AbortSignal): Promise<boolean>;
  bootCompleted(signal: AbortSignal): Promise<boolean>;
  foregroundUserReady(signal: AbortSignal): Promise<boolean>;
}

export function createAdbAndroidInstallSettleProbe(
  adb: AdbCommandRunner,
  device: Pick<BootedDevice, "formFactor">,
): AndroidInstallSettleProbe {
  return {
    async packageManagerReady(signal: AbortSignal): Promise<boolean> {
      const result = await adb.executeCommand("shell pm path android", {
        noRetry: true,
        signal,
      });
      return result.stdout.split(/\r?\n/).some((line) => line.trim().startsWith("package:"));
    },

    async bootCompleted(signal: AbortSignal): Promise<boolean> {
      const result = await adb.executeCommand("shell getprop sys.boot_completed", {
        noRetry: true,
        signal,
      });
      return result.stdout.trim() === "1";
    },

    async foregroundUserReady(signal: AbortSignal): Promise<boolean> {
      try {
        // Resolve afresh: a cached system user must not hide the initial driver-user switch.
        await resolveSetupUser(
          {
            executeCommand: (command, options) =>
              adb.executeCommand(command, { ...options, signal }),
          },
          device,
        );
        return true;
      } catch (error) {
        signal.throwIfAborted();
        if (isForegroundUserPending(error) || error instanceof ForegroundUserUnreadableError) {
          // Expected during the initial switch from the headless system user to the driver.
          logger.debug("[CTRL_PROXY] Foreground user has not settled before install", error);
          return false;
        }
        throw toActionableError(
          error,
          "Could not inspect the foreground user before CtrlProxy install",
        );
      }
    },
  };
}

/** Bounded, cancellable framework settling; other form factors do not issue any probes. */
export class AndroidInstallSettleGate {
  constructor(
    private readonly probe: AndroidInstallSettleProbe,
    private readonly timer: Timer,
    private readonly options: { budgetMs?: number; backoff?: BackoffPolicy } = {},
  ) {}

  async wait(formFactor: BootedDevice["formFactor"], signal?: AbortSignal): Promise<void> {
    if (formFactor !== "automotive" && formFactor !== "watch") {
      return;
    }
    let pendingSignal = "pm path android";
    let lastPendingError: ActionableError | undefined;
    const pendingError = () => {
      lastPendingError = new ActionableError(
        `CtrlProxy install settle budget exhausted: ${pendingSignal} never settled. Let Android finish booting, then retry device acquisition.`,
      );
      return lastPendingError;
    };
    await runPhaseWithSettlement(
      {
        timer: this.timer,
        timeoutMs: this.options.budgetMs ?? 30_000,
        signal,
        graceMs: 0,
        label: "CtrlProxy install settle",
        timeoutError: pendingError,
        defaultAbortError: () => new ActionableError("CtrlProxy install settle cancelled"),
      },
      async (phaseSignal) => {
        await new DefaultRetryExecutor(this.timer).executeOrThrow(
          async () => {
            phaseSignal.throwIfAborted();
            pendingSignal = "pm path android";
            if (!(await this.probe.packageManagerReady(phaseSignal))) {
              throw pendingError();
            }
            phaseSignal.throwIfAborted();
            pendingSignal = "sys.boot_completed";
            if (!(await this.probe.bootCompleted(phaseSignal))) {
              throw pendingError();
            }
            if (formFactor === "automotive") {
              phaseSignal.throwIfAborted();
              pendingSignal = "foreground user (am get-current-user)";
              if (!(await this.probe.foregroundUserReady(phaseSignal))) {
                throw pendingError();
              }
            }
            phaseSignal.throwIfAborted();
          },
          {
            // The phase deadline bounds elapsed time, including slow/hung probes and backoff.
            maxAttempts: Number.MAX_SAFE_INTEGER,
            delays: this.options.backoff ?? sequenceBackoff([250, 500, 1000, 2000]),
            signal: phaseSignal,
            shouldRetry: (error) =>
              error === lastPendingError || isAndroidFrameworkUnavailable(error),
            expectedFailure: {
              reason: "framework settling is bounded by the install settle budget",
              matches: (error) => error === lastPendingError,
            },
          },
        );
      },
    );
  }
}
