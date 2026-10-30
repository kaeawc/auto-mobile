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

/** Resolves only after an owned guest capture has been observed alive and settled. */
export interface GuestAudioCapture {
  open(deviceId: string): Promise<GuestAudioCaptureHandle>;
}

export interface GuestAudioCaptureOptions {
  /** Includes discovery, launch, liveness polling and settling. Default 8 seconds. */
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
      "ADB shell user; stop competing recordings and retry. " +
      "AutoMobile does not enable adb root.",
  );
}

// The emulator virtio-snd capture device is card 0, device 0 (tinycap -D 0 -d 0).
const CAPTURE_PCM = { card: 0, device: 0 };

function matchesRecorder(pid: number, marker: string): string {
  return (
    `tr '\\000' '\\n' < /proc/${pid}/environ 2>/dev/null | ` + `grep -Fqx -- ${shellQuote(marker)}`
  );
}

/** Check the marker and stat together; a zombie can retain its PID after tinycap exits. */
function recorderProbe(pid: number, marker: string): string {
  return (
    `if ${matchesRecorder(pid, marker)} && stat=$(cat /proc/${pid}/stat 2>/dev/null); then ` +
    // comm (field 2) can contain spaces and parentheses; strip through its final closing paren.
    "fields=${stat##*) }; state=${fields%% *}; " +
    'case "$state" in ""|Z|X) echo exited;; ?) ' +
    `if ${matchesRecorder(pid, marker)}; then echo running; else echo exited; fi;; ` +
    "*) echo exited;; esac; else echo exited; fi"
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
    let recorderLogPath: string | undefined;
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
      const identityCheck = matchesRecorder(pid, recorderMarker);
      // Best-effort: the log name is unique to this lease, and it is removed only with the verified kill.
      const logCleanup =
        recorderLogPath === undefined
          ? ""
          : ` rm -f -- ${shellQuote(recorderLogPath)} 2>/dev/null;`;
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
          ["shell", "sh", "-c", shellQuote(`if ${identityCheck}; then echo matched; fi`)],
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
            shellQuote(
              `if ${identityCheck}; then kill ${pid};${logCleanup} else echo identity_changed; fi`,
            ),
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
      const recorderId = this.ids.next();
      recorderMarker = `AUTOMOBILE_GUEST_AUDIO_CAPTURE_ID=${recorderId}`;
      if (/[\r\n\0]/.test(recorderMarker)) {
        throw unavailable(deviceId, "the recorder marker is invalid");
      }
      // Keep lease logs for image temporary-file cleanup, including when identity is lost.
      const logPath = `/data/local/tmp/automobile-guest-capture-${encodeURIComponent(recorderId)}.log`;
      recorderLogPath = logPath;
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
        `env ${shellQuote(recorderMarker)} nohup tinycap /dev/null -D ${CAPTURE_PCM.card} -d ${CAPTURE_PCM.device} -c 1 -r 48000 -b 16 </dev/null >/dev/null 2>${shellQuote(logPath)} & echo $!`,
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
      await this.waitForRunning(
        deviceId,
        recorderProbe(pid, recorderMarker),
        logPath,
        deadline,
        shell,
      );
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
    probe: string,
    logPath: string,
    deadline: number,
    shell: (script: string) => Promise<string>,
  ): Promise<void> {
    let runningSince: number | undefined;
    while (this.now() < deadline) {
      const status = (await shell(probe)).trim();
      if (status !== "running") {
        // Any exit refuses outright: a recorder that stopped cannot be trusted to have stayed open.
        const diagnostic = await this.recorderDiagnostic(deviceId, logPath, shell);
        throw unavailable(
          deviceId,
          "the recorder exited before its capture stayed running through the settle window" +
            (diagnostic ? `; tinycap stderr: ${diagnostic}` : ""),
        );
      }
      const now = this.now();
      runningSince = runningSince ?? now;
      if (now - runningSince >= this.settleMs && now < deadline) {
        return;
      }
      await this.timer.sleep(Math.min(this.pollMs, Math.max(0, deadline - now)));
    }
    throw unavailable(deviceId, "the recorder did not stay running through the settle window");
  }

  private async recorderDiagnostic(
    deviceId: string,
    logPath: string,
    shell: (script: string) => Promise<string>,
  ): Promise<string> {
    try {
      const tail = await shell(`tail -n 5 ${shellQuote(logPath)} 2>/dev/null | tail -c 2048`);
      return tail.slice(-2_048).trim();
    } catch (error) {
      // Diagnostics are optional; unreadable logs must never permit capture verification.
      logger.debug(`Cannot read guest capture log on ${deviceId}: ${errorMessage(error)}`);
      return "";
    }
  }
}
