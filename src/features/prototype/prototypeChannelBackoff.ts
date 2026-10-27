import { exponentialBackoff } from "../../utils/Backoff";
import type { Random } from "../../utils/Random";

/**
 * The reconnect delay of a realtime channel (#14261): exponential backoff with full jitter. One
 * pure function so the host and the device runtimes agree; the Kotlin twin replays
 * `test/fixtures/prototype-spec/realtime/backoff.json`, which fixes the random sequence.
 */
export interface PrototypeChannelReconnect {
  /** 0 means never reconnect. */
  maxAttempts?: number;
  initialDelayMs?: number;
  maxDelayMs?: number;
}

export const PROTOTYPE_CHANNEL_DEFAULT_RECONNECT = {
  maxAttempts: 8,
  initialDelayMs: 500,
  maxDelayMs: 30000,
} as const;

/**
 * The wait before reconnect attempt `attempt` (1 for the first retry), drawn uniformly from
 * `[0, min(maxDelayMs, initialDelayMs * 2^(attempt-1)))` rounded down with the injected `random`,
 * or undefined once `attempt` exceeds `maxAttempts` (so 0 attempts never reconnects).
 */
export function prototypeChannelBackoffDelay(
  attempt: number,
  reconnect: PrototypeChannelReconnect,
  random: Random,
): number | undefined {
  const maxAttempts = reconnect.maxAttempts ?? PROTOTYPE_CHANNEL_DEFAULT_RECONNECT.maxAttempts;
  if (!Number.isInteger(attempt) || attempt < 1 || attempt > maxAttempts) {
    return undefined;
  }
  const ceiling = exponentialBackoff({
    initialDelayMs: reconnect.initialDelayMs ?? PROTOTYPE_CHANNEL_DEFAULT_RECONNECT.initialDelayMs,
    maxDelayMs: reconnect.maxDelayMs ?? PROTOTYPE_CHANNEL_DEFAULT_RECONNECT.maxDelayMs,
  }).delayForAttempt(attempt);
  return Math.floor(random.next() * ceiling);
}
