import type { HostChildProcess } from "../HostCommandExecutor";
import { logger } from "../logger";
import { redactAndroidCommandOutput } from "./redactAndroidCommandOutput";
import { errorMessage } from "../describeUnknownError";
import type {
  EmulatorLauncherHost,
  EmulatorLaunchState,
  EmulatorProcessOptions,
} from "./EmulatorLaunchSupport";

export const STARTUP_SERIAL_POLL_INTERVAL_MS = 500;
export const STARTUP_STDOUT_GRACE_MS = 1_000;

/** Optional early signals; the launcher still owns classification and the 5 s fallback. */
export class EmulatorStartupValidation {
  constructor(
    private readonly host: EmulatorLauncherHost,
    private readonly state: EmulatorLaunchState,
    private readonly child: HostChildProcess,
    private readonly resolveStartup: () => void,
    private readonly options: Pick<EmulatorProcessOptions, "expectedDeviceId" | "signal"> = {},
  ) {}

  observeOutput(output: string, isStdout: boolean, diagnosticOutput: string): void {
    this.state.startupAccelerationFailureDetected ||=
      (this.host.accelerationCheckCategory(diagnosticOutput) ??
        this.host.accelerationCheckCategory(redactAndroidCommandOutput(output))) !== undefined;
    if (!this.canCompleteEarly()) {
      this.cancelEarlySignals();
      return;
    }
    this.startSerialPolling();
    if (isStdout && /[\r\n]/.test(output) && !this.state.stdoutGraceTimeout) {
      this.state.stdoutGraceTimeout = this.host.timer().setTimeout(() => {
        if (this.canCompleteEarly()) {
          this.resolveStartup();
        }
      }, STARTUP_STDOUT_GRACE_MS);
    }
  }

  startSerialPolling(): void {
    if (!this.canCompleteEarly() || !this.serial() || this.state.serialPollInterval) {
      return;
    }
    this.state.serialPollInterval = this.host.timer().setInterval(() => {
      void this.probeSerial();
    }, STARTUP_SERIAL_POLL_INTERVAL_MS);
  }

  cancelEarlySignals(): void {
    if (this.state.stdoutGraceTimeout) {
      this.host.timer().clearTimeout(this.state.stdoutGraceTimeout);
      this.state.stdoutGraceTimeout = undefined;
    }
    if (this.state.serialPollInterval) {
      this.host.timer().clearInterval(this.state.serialPollInterval);
      this.state.serialPollInterval = undefined;
    }
  }

  private serial(): string | undefined {
    return this.options.expectedDeviceId ?? this.host.launchTargetDeviceIds().get(this.child);
  }

  private canCompleteEarly(): boolean {
    return (
      !this.state.startupValidationComplete &&
      !this.state.childTerminationObserved &&
      !this.state.duplicateAvdDetected &&
      !this.state.earlyExitCategory &&
      !this.state.startupAccelerationFailureDetected
    );
  }

  private async probeSerial(): Promise<void> {
    const serial = this.serial();
    if (!serial || !this.canCompleteEarly() || this.state.serialProbeInFlight) {
      return;
    }
    this.state.serialProbeInFlight = true;
    try {
      if (await this.host.isEmulatorSerialListed(serial, this.options.signal)) {
        if (this.canCompleteEarly()) {
          this.resolveStartup();
        }
      }
    } catch (error) {
      // Optional adb visibility must not fail a launch; stdout and the fallback still apply.
      logger.debug(`Emulator startup serial probe failed: ${errorMessage(error)}`);
    } finally {
      this.state.serialProbeInFlight = false;
    }
  }
}
