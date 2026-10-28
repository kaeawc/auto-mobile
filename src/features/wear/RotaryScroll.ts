import { toActionableError } from "../../models/ActionableError";
import type { AdbCommandRunner } from "../../utils/android-cmdline-tools/interfaces/AdbExecutor";
import type { Timer } from "../../utils/SystemTimer";
import { logger } from "../../utils/logger";
import { errorMessage } from "../../utils/describeUnknownError";
import {
  effectiveSize,
  parseWmSize,
  wmSizeReadCommand,
} from "../utility/androidDisplayGeometryCommands";

/**
 * Wear OS rotary (crown) scroll (#14948). The native SCROLL axis command is confirmed on
 * a Wear OS emulator; its axis sign is inverted relative to delta. The emulator-console
 * candidate and physical-device behaviour remain unconfirmed (see
 * docs/design-docs/plat/android/form-factors.md, checklist row 6).
 * Each candidate is tried in order and followed by a read-back (the screen
 * fingerprint changed), so a command a release lacks costs one attempt, not a wrong answer.
 */

export const ROTARY_METHODS = ["input_rotaryencoder", "emulator_rotary", "swipe"] as const;
export type RotaryMethod = (typeof ROTARY_METHODS)[number];

export interface RotaryScrollAttempt {
  method: RotaryMethod;
  command: string;
  outcome: "scrolled" | "unchanged" | "failed";
  error?: string;
}

export interface RotaryScrollResult {
  /** Some candidate changed the screen on read-back. */
  success: boolean;
  delta: number;
  /** The first candidate whose read-back showed the screen change. */
  method?: RotaryMethod;
  attempts: RotaryScrollAttempt[];
  reason?: string;
}

/** Drives rotary scroll and reads the effect back. Positive delta scrolls content down. */
export interface RotaryScroller {
  scroll(request: { delta: number; signal?: AbortSignal }): Promise<RotaryScrollResult>;
}

/** Reads a value that changes when the visible UI scrolls; undefined when unreadable. */
export type ScreenFingerprintReader = (signal?: AbortSignal) => Promise<string | undefined>;

export interface RotaryScrollerDeps {
  adb: AdbCommandRunner;
  timer: Timer;
  deviceId: string;
  fingerprint: ScreenFingerprintReader;
}

/** Rotary detents a call may send; a detent is one notch of the crown. */
export const ROTARY_MAX_DELTA = 50;
/** How long a candidate gets to take effect before the read-back. */
export const ROTARY_SETTLE_MS = 300;
const COMMAND_TIMEOUT_MS = 10_000;
const SWIPE_DURATION_MS = 250;
/** Swipe fallback: each detent moves the finger this fraction of the screen height. */
const SWIPE_FRACTION_PER_DETENT = 0.1;
const SWIPE_MAX_FRACTION = 0.8;

/** Output that means a shell or emulator-console command did not run. */
const COMMAND_FAILED =
  /^(?:Error|Exception|KO)\b|Invalid command|Unknown command|No shell command|Unknown source/m;

interface Candidate {
  method: RotaryMethod;
  /** The adb argument string, without the leading `-s <serial>`. */
  command: string;
}

/** A vertical centre-column swipe; a positive delta moves the finger up so content scrolls down. */
export function swipeCommand(size: { width: number; height: number }, delta: number): string {
  const x = Math.round(size.width / 2);
  const centre = Math.round(size.height / 2);
  const half = Math.round(
    (Math.min(SWIPE_MAX_FRACTION, Math.abs(delta) * SWIPE_FRACTION_PER_DETENT) * size.height) / 2,
  );
  const [from, to] = delta > 0 ? [centre + half, centre - half] : [centre - half, centre + half];
  return `shell input swipe ${x} ${from} ${x} ${to} ${SWIPE_DURATION_MS}`;
}

export class AdbRotaryScroller implements RotaryScroller {
  constructor(private readonly deps: RotaryScrollerDeps) {}

  async scroll(request: { delta: number; signal?: AbortSignal }): Promise<RotaryScrollResult> {
    const { delta, signal } = request;
    const attempts: RotaryScrollAttempt[] = [];
    let baseline = await this.deps.fingerprint(signal);
    if (baseline === undefined) {
      return {
        success: false,
        delta,
        attempts,
        reason:
          "The screen could not be read before scrolling, so no rotary command can be verified (is the CtrlProxy enabled?).",
      };
    }
    for (const candidate of await this.candidates(delta, signal)) {
      const attempt = await this.attempt(candidate, baseline, signal);
      attempts.push(attempt.record);
      if (attempt.record.outcome === "scrolled") {
        return { success: true, delta, method: candidate.method, attempts };
      }
      baseline = attempt.after ?? baseline;
    }
    return {
      success: false,
      delta,
      attempts,
      reason: "No rotary candidate changed the screen on read-back.",
    };
  }

  private async candidates(delta: number, signal?: AbortSignal): Promise<Candidate[]> {
    const candidates: Candidate[] = [
      {
        method: "input_rotaryencoder",
        command: `shell input rotaryencoder scroll --axis SCROLL,${-delta}`,
      },
    ];
    if (this.deps.deviceId.startsWith("emulator-")) {
      candidates.push({
        method: "emulator_rotary",
        command: `emu event send EV_REL:REL_WHEEL:${delta}`,
      });
    }
    const wmSize = parseWmSize(
      await this.run(wmSizeReadCommand(undefined), signal).catch(() => ""),
    );
    const size = wmSize && effectiveSize(wmSize);
    if (size) {
      candidates.push({ method: "swipe", command: swipeCommand(size, delta) });
    }
    return candidates;
  }

  private async attempt(
    candidate: Candidate,
    baseline: string,
    signal?: AbortSignal,
  ): Promise<{ record: RotaryScrollAttempt; after?: string }> {
    const base = { method: candidate.method, command: candidate.command };
    try {
      const output = await this.run(candidate.command, signal);
      if (COMMAND_FAILED.test(output)) {
        return { record: { ...base, outcome: "failed", error: output.slice(0, 200) } };
      }
      await this.deps.timer.sleep(ROTARY_SETTLE_MS);
      const after = await this.deps.fingerprint(signal);
      const outcome = after !== undefined && after !== baseline ? "scrolled" : "unchanged";
      return { record: { ...base, outcome }, after };
    } catch (error) {
      signal?.throwIfAborted();
      // A failed candidate is data in the attempts list; the next candidate still runs.
      logger.warn(`rotaryScroll ${candidate.method} failed: ${errorMessage(error)}`, error);
      return { record: { ...base, outcome: "failed", error: errorMessage(error) } };
    }
  }

  private async run(command: string, signal?: AbortSignal): Promise<string> {
    try {
      const result = await this.deps.adb.executeCommand(command, {
        timeoutMs: COMMAND_TIMEOUT_MS,
        noRetry: true,
        signal,
      });
      return result.stdout.trim();
    } catch (error) {
      throw toActionableError(error, `Failed to run adb ${command}`);
    }
  }
}
