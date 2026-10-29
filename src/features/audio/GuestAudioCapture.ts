import { ActionableError, toActionableError } from "../../models/ActionableError";
import { errorMessage } from "../../models/describeUnknownError";
import type { AdbExecutor } from "../../utils/android-cmdline-tools/interfaces/AdbExecutor";
import { EmulatorAudioError } from "../../utils/android-cmdline-tools/emulatorGrpc/EmulatorAudioError";
import type { EmulatorGrpcDiscovery } from "../../utils/android-cmdline-tools/emulatorGrpc/emulatorGrpcDiscovery";
import { isAndroidEmulatorSerial } from "../../utils/androidSerial";
import type { IdGenerator } from "../../utils/IdGenerator";
import { logger } from "../../utils/logger";
import { shellQuote } from "../../utils/shellQuote";
import { defaultTimer, type Timer } from "../../utils/SystemTimer";

export interface GuestAudioCaptureHandle {
  close(): Promise<void>;
}

/** Resolves only after an owned guest capture has been observed RUNNING and settled. */
export interface GuestAudioCapture {
  open(deviceId: string): Promise<GuestAudioCaptureHandle>;
}

export interface GuestAudioCaptureOptions {
  /** Includes discovery, launch, RUNNING polling and settling. Default 8 seconds. */
  timeoutMs?: number;
  pollMs?: number;
  /** Default 3 seconds: a capture opened only 2.5 seconds earlier has crashed the emulator. */
  settleMs?: number;
}

function unavailable(deviceId: string, detail: string): EmulatorAudioError {
  return new EmulatorAudioError(
    "audio_guest_capture_unavailable",
    `Cannot verify an open guest microphone capture on ${deviceId}: ${detail}. ` +
      "Injection was refused to protect the emulator. Use an image with tinycap available to the " +
      "ADB shell user and readable /proc/asound capture status; stop competing recordings and retry. " +
      "AutoMobile does not enable adb root.",
  );
}

/** One owned tinycap process per lease; the service excludes overlapping injections per device. */
export class AdbGuestAudioCapture implements GuestAudioCapture {
  private readonly now: () => number;
  private readonly timeoutMs: number;
  private readonly pollMs: number;
  private readonly settleMs: number;

  constructor(
    private readonly adbFor: (deviceId: string) => Pick<AdbExecutor, "execute">,
    private readonly discovery: EmulatorGrpcDiscovery,
    private readonly ids: IdGenerator,
    private readonly timer: Pick<Timer, "now" | "monotonicNow" | "sleep"> = defaultTimer,
    options: GuestAudioCaptureOptions = {},
  ) {
    this.now = timer.monotonicNow?.bind(timer) ?? timer.now.bind(timer);
    this.timeoutMs = options.timeoutMs ?? 8_000;
    this.pollMs = options.pollMs ?? 100;
    this.settleMs = options.settleMs ?? 3_000;
    if (
      ![this.timeoutMs, this.pollMs, this.settleMs].every(Number.isFinite) ||
      Math.min(this.timeoutMs, this.pollMs) <= 0 ||
      this.settleMs < 0 ||
      this.settleMs >= this.timeoutMs
    ) {
      throw new EmulatorAudioError(
        "audio_guest_capture_unavailable",
        "Invalid guest capture polling or settle deadline.",
      );
    }
  }

  async open(deviceId: string): Promise<GuestAudioCaptureHandle> {
    const deadline = this.now() + this.timeoutMs;
    let pid: number | undefined;
    let emulatorPid: number | undefined;
    let recorderMarker: string;
    let closed = false;
    // The executor survives session release, but its serial can resolve to a replacement guest.
    let adb: Pick<AdbExecutor, "execute">;
    try {
      adb = this.adbFor(deviceId);
    } catch (error) {
      throw unavailable(deviceId, errorMessage(error));
    }
    const close = async (): Promise<void> => {
      if (closed || pid === undefined) {
        return;
      }
      closed = true;
      // Never dispatch a kill to a replacement emulator or an unverified recorder PID.
      const matchesRecorder =
        `tr '\\000' '\\n' < /proc/${pid}/environ 2>/dev/null | ` +
        `grep -Fqx -- ${shellQuote(recorderMarker)}`;
      const cleanupOptions = {
        timeoutMs: 1_000,
        noRetry: true,
        signal: new AbortController().signal,
      };
      try {
        if (emulatorPid === undefined || (await this.emulatorPidFor(deviceId)) !== emulatorPid) {
          logger.debug(`Skipping guest capture cleanup on ${deviceId}: emulator identity changed`);
          return;
        }
        const identity = await adb.execute(
          ["shell", "sh", "-c", shellQuote(`if ${matchesRecorder}; then echo matched; fi`)],
          cleanupOptions,
        );
        if (identity.error || identity.stdout.trim() !== "matched") {
          logger.debug(
            `Skipping guest capture cleanup on ${deviceId}: recorder identity unverified`,
          );
          return;
        }
      } catch (error) {
        // Skipping cleanup is safe when identity cannot be verified; signaling a reused PID is not.
        logger.debug(`Skipping guest capture cleanup on ${deviceId}: ${errorMessage(error)}`);
        return;
      }
      try {
        // Recheck in the signaling shell: ADB may resolve a new transport after the preflight.
        const result = await adb.execute(
          [
            "shell",
            "sh",
            "-c",
            shellQuote(`if ${matchesRecorder}; then kill ${pid}; else echo identity_changed; fi`),
          ],
          cleanupOptions,
        );
        if (result.error) {
          throw new ActionableError(
            `Failed to close guest audio capture PID ${pid} on ${deviceId}: ${result.error}`,
          );
        }
        if (result.stdout.trim() === "identity_changed") {
          logger.debug(`Skipped guest capture kill on ${deviceId}: recorder identity changed`);
        }
      } catch (error) {
        throw toActionableError(
          error,
          `Failed to close guest audio capture PID ${pid} on ${deviceId}`,
        );
      }
    };
    const shell = async (script: string, onStdout?: (chunk: string) => void): Promise<string> => {
      const remaining = deadline - this.now();
      if (remaining <= 0) {
        throw unavailable(deviceId, "capture verification deadline expired");
      }
      const result = await adb.execute(["shell", "sh", "-c", shellQuote(script)], {
        timeoutMs: Math.min(1_000, remaining),
        noRetry: true,
        onStdout,
        waitForProcessSettlementAfterAbort: true,
      });
      if (result.error) {
        throw unavailable(deviceId, result.error);
      }
      return result.stdout;
    };
    try {
      emulatorPid = await this.emulatorPidFor(deviceId);
      recorderMarker = `AUTOMOBILE_GUEST_AUDIO_CAPTURE_ID=${this.ids.next()}`;
      if (/[\r\n\0]/.test(recorderMarker)) {
        throw unavailable(deviceId, "the recorder marker is invalid");
      }
      const paths = await shell(
        'for status in /proc/asound/card*/pcm*c/sub*/status; do if [ -r "$status" ]; then printf "%s\\n" "$status"; fi; done',
      );
      const path = paths
        .split(/\r?\n/)
        .find((value) => /^\/proc\/asound\/card\d+\/pcm\d+c\/sub\d+\/status$/.test(value));
      const match = path?.match(/^\/proc\/asound\/card(\d+)\/pcm(\d+)c\/sub\d+\/status$/);
      if (!path || !match) {
        throw unavailable(deviceId, "no readable ALSA capture status");
      }
      let launchOutput = "";
      const recordPid = (chunk: string) => {
        launchOutput += chunk;
        const value = /^([0-9]+)\r?\n/.exec(launchOutput)?.[1];
        if (value && Number.isSafeInteger(Number(value)) && Number(value) > 1) {
          pid = Number(value);
        }
      };
      // All streams are redirected so ADB can return while nohup keeps this exact PID alive.
      const output = await shell(
        `env ${shellQuote(recorderMarker)} nohup tinycap /dev/null -D ${match[1]} -d ${match[2]} -c 1 -r 48000 -b 16 </dev/null >/dev/null 2>&1 & echo $!`,
        recordPid,
      );
      // Executors may not stream stdout; parse the completed output in that case.
      if (pid === undefined) {
        launchOutput = "";
        recordPid(output);
      }
      if (pid === undefined) {
        throw unavailable(deviceId, "the recorder did not return a valid PID");
      }
      await this.waitForRunning(deviceId, path, pid, deadline, shell);
      return { close };
    } catch (error) {
      await close().catch((cleanupError: unknown) => {
        logger.warn(
          `Failed guest capture start cleanup on ${deviceId}: ${errorMessage(cleanupError)}`,
        );
        return false;
      });
      throw error instanceof EmulatorAudioError
        ? error
        : unavailable(deviceId, errorMessage(error));
    }
  }

  private async emulatorPidFor(deviceId: string): Promise<number> {
    const endpoint = isAndroidEmulatorSerial(deviceId)
      ? await this.discovery.findByConsolePort(Number(deviceId.slice("emulator-".length)))
      : undefined;
    if (!endpoint || !Number.isSafeInteger(endpoint.pid) || endpoint.pid < 1) {
      throw unavailable(deviceId, "the emulator incarnation could not be identified");
    }
    return endpoint.pid;
  }

  private async waitForRunning(
    deviceId: string,
    path: string,
    pid: number,
    deadline: number,
    shell: (script: string) => Promise<string>,
  ): Promise<void> {
    let runningSince: number | undefined;
    while (this.now() < deadline) {
      const status = await shell(`cat ${path}`);
      const running =
        /^state:\s*RUNNING\s*$/m.test(status) &&
        Number(/^owner_pid\s*:\s*(\d+)\s*$/m.exec(status)?.[1]) === pid;
      const now = this.now();
      runningSince = running ? (runningSince ?? now) : undefined;
      if (runningSince !== undefined && now - runningSince >= this.settleMs && now < deadline) {
        return;
      }
      await this.timer.sleep(Math.min(this.pollMs, Math.max(0, deadline - now)));
    }
    throw unavailable(
      deviceId,
      "the recorder's capture did not stay RUNNING through the settle window",
    );
  }
}
