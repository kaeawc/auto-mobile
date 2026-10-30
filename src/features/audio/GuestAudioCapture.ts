import { ActionableError, toActionableError } from "../../models/ActionableError";
import { errorMessage } from "../../models/describeUnknownError";
import type { AdbExecutor } from "../../utils/android-cmdline-tools/interfaces/AdbExecutor";
import { EmulatorAudioError } from "../../utils/android-cmdline-tools/emulatorGrpc/EmulatorAudioError";
import type { EmulatorGrpcDiscovery } from "../../utils/android-cmdline-tools/emulatorGrpc/emulatorGrpcDiscovery";
import { isAndroidEmulatorSerial } from "../../utils/androidSerial";
import type { IdGenerator } from "../../utils/IdGenerator";
import { logger } from "../../utils/logger";
import { shellQuoteUnlessSafe } from "../../utils/shellQuote";
import { defaultTimer, type Timer } from "../../utils/SystemTimer";
import { parseBroadcastOutput } from "../intent/SendBroadcast";
import { CTRL_PROXY_PACKAGE } from "../../ctrlProxy/constants";

export interface GuestAudioCaptureHandle {
  close(): Promise<void>;
}

export const GUEST_CAPTURE_LEASE_MARGIN_MS = 60_000;
export const GUEST_CAPTURE_MAX_LEASE_MS = 3_720_000;

export interface GuestAudioCaptureOpenOptions {
  leaseMs: number;
}

/** Resolves only after an owned guest capture has been observed alive and settled. */
export interface GuestAudioCapture {
  open(deviceId: string, options: GuestAudioCaptureOpenOptions): Promise<GuestAudioCaptureHandle>;
}

export interface GuestAudioCaptureOptions {
  /** Includes discovery, broadcast start, status polling and settling. Default 8 seconds. */
  timeoutMs?: number;
  pollMs?: number;
  /** Default 3 seconds: a capture opened only 2.5 seconds earlier has crashed the emulator. */
  settleMs?: number;
}

function unavailable(deviceId: string, detail: string): EmulatorAudioError {
  return new EmulatorAudioError(
    "audio_guest_capture_unavailable",
    `Cannot verify an open guest microphone capture on ${deviceId}: ${detail}. ` +
      "Injection was refused to protect the emulator. The guest microphone capture is provided " +
      "by the CtrlProxy app; its RECORD_AUDIO permission is granted at install. " +
      "Stop competing recordings and retry. AutoMobile does not enable adb root.",
  );
}

const COMPONENT = `${CTRL_PROXY_PACKAGE}/.GuestAudioCaptureReceiver`;
const ACTION = "dev.jasonpearson.automobile.GUEST_AUDIO_CAPTURE";
const BROADCAST_TIMEOUT_MS = 2_000;

/** One CtrlProxy recording per lease; injection waits until the recording has settled. */
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

  async open(
    deviceId: string,
    { leaseMs }: GuestAudioCaptureOpenOptions,
  ): Promise<GuestAudioCaptureHandle> {
    const deadline = this.now() + this.timeoutMs;
    let emulatorPid: number | undefined;
    let lease: string | undefined;
    let startAttempted = false;
    let closed = false;
    let adb: Pick<AdbExecutor, "execute">;
    try {
      adb = this.adbFor(deviceId);
    } catch (error) {
      throw unavailable(deviceId, errorMessage(error));
    }
    const broadcast = async (
      op: "start" | "status" | "stop",
      callDeadline: number,
    ): Promise<string> => {
      const remaining = callDeadline - this.now();
      if (remaining <= 0) {
        throw unavailable(deviceId, "capture verification deadline expired");
      }
      const result = await adb.execute(
        [
          "shell",
          "am",
          "broadcast",
          "-n",
          COMPONENT,
          "-a",
          ACTION,
          "--es",
          "op",
          op,
          "--es",
          "lease",
          shellQuoteUnlessSafe(lease ?? ""),
          ...(op === "start" ? ["--el", "leaseTimeoutMs", String(leaseMs)] : []),
        ],
        {
          timeoutMs: Math.min(BROADCAST_TIMEOUT_MS, remaining),
          noRetry: true,
          signal: new AbortController().signal,
        },
      );
      if (this.now() >= callDeadline) {
        throw unavailable(deviceId, "capture verification deadline expired");
      }
      if (result.error) {
        throw unavailable(deviceId, result.error);
      }
      const reply = parseBroadcastOutput(`${result.stdout}\n${result.stderr}`);
      const missingReceiver =
        "the CtrlProxy on the device has no guest capture receiver; reinstall the CtrlProxy APK";
      if (!reply.delivered) {
        const output = reply.output.trim().slice(0, 2_048);
        switch (reply.errorCode) {
          case "permission_denied":
            throw unavailable(
              deviceId,
              "the adb shell was refused the CtrlProxy receiver, which needs " +
                `android.permission.DUMP (held by the adb shell): ${output}`,
            );
          case "no_matching_receiver":
            throw unavailable(deviceId, missingReceiver);
          case "protected_broadcast":
            throw unavailable(deviceId, `the guest capture broadcast is protected: ${output}`);
          default:
            // The parser classifies am's explicit missing-receiver error as broadcast_failed.
            if (reply.output.trimStart().startsWith("Error: receiver not found")) {
              throw unavailable(deviceId, missingReceiver);
            }
            throw unavailable(deviceId, `the guest capture broadcast failed: ${output}`);
        }
      }
      if (!reply.resultData) {
        throw unavailable(deviceId, missingReceiver);
      }
      return reply.resultData.slice(0, 2_048);
    };
    const close = async (): Promise<void> => {
      if (closed || !startAttempted) {
        return;
      }
      closed = true;
      try {
        if (emulatorPid === undefined || (await this.emulatorPidFor(deviceId)) !== emulatorPid) {
          logger.debug(`Skipping guest capture cleanup on ${deviceId}: emulator identity changed`);
          return;
        }
      } catch (error) {
        // Skipping cleanup is safe when the emulator identity cannot be verified.
        logger.debug(`Skipping guest capture cleanup on ${deviceId}: ${errorMessage(error)}`);
        return;
      }
      try {
        // Cleanup has its own bounded budget even when verification used the entire deadline.
        const reply = await broadcast("stop", this.now() + BROADCAST_TIMEOUT_MS);
        const state = reply.split(" ", 1)[0];
        if (state !== "stopped" && state !== "absent") {
          throw new ActionableError(`Guest capture stop refused: ${reply}`);
        }
      } catch (error) {
        throw toActionableError(error, `Failed to close guest audio capture on ${deviceId}`);
      }
    };
    try {
      emulatorPid = await this.emulatorPidFor(deviceId);
      lease = this.ids.next();
      if (!lease || /[\r\n\0]/.test(lease)) {
        throw unavailable(deviceId, "the capture lease is invalid");
      }
      startAttempted = true;
      const started = await broadcast("start", deadline);
      if (started.split(" ", 1)[0] !== "running") {
        throw unavailable(deviceId, started);
      }
      const runningSince = this.now();
      while (this.now() < deadline) {
        const now = this.now();
        if (now - runningSince >= this.settleMs) {
          return { close };
        }
        await this.timer.sleep(Math.min(this.pollMs, deadline - now));
        const status = await broadcast("status", deadline);
        // A non-running sample refuses immediately; a later sample cannot revive this open.
        if (status.split(" ", 1)[0] !== "running") {
          throw unavailable(deviceId, status);
        }
      }
      throw unavailable(deviceId, "capture verification deadline expired");
    } catch (error) {
      await close().catch((cleanupError: unknown) => {
        logger.warn(
          `Failed guest capture start cleanup on ${deviceId}: ${errorMessage(cleanupError)}`,
        );
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
}
