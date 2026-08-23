export interface BackoffPolicy {
  delayForAttempt(attempt: number): number;
}

export interface ExponentialBackoffOptions {
  readonly initialDelayMs: number;
  readonly multiplier?: number;
  readonly maxDelayMs?: number;
}

export type BackoffInput =
  | number
  | readonly number[]
  | BackoffPolicy
  | ((attempt: number) => number);

export const fixedBackoff = (delayMs: number): BackoffPolicy => {
  const normalized = normalizeDelay(delayMs);
  return {
    delayForAttempt(attempt: number): number {
      assertAttempt(attempt);
      return normalized;
    },
  };
};

export const sequenceBackoff = (delaysMs: readonly number[]): BackoffPolicy => {
  if (delaysMs.length === 0) {
    throw new Error("sequenceBackoff requires at least one delay");
  }

  const normalized = delaysMs.map(normalizeDelay);
  return {
    delayForAttempt(attempt: number): number {
      assertAttempt(attempt);
      return normalized[Math.min(attempt - 1, normalized.length - 1)]!;
    },
  };
};

export const exponentialBackoff = (options: ExponentialBackoffOptions): BackoffPolicy => {
  const initialDelayMs = normalizeDelay(options.initialDelayMs);
  const multiplier = options.multiplier ?? 2;
  const maxDelayMs =
    options.maxDelayMs === undefined
      ? Number.POSITIVE_INFINITY
      : normalizeDelay(options.maxDelayMs);

  if (!Number.isFinite(multiplier) || multiplier < 1) {
    throw new Error(`exponentialBackoff multiplier must be >= 1, got ${multiplier}`);
  }

  return {
    delayForAttempt(attempt: number): number {
      assertAttempt(attempt);
      return normalizeDelay(Math.min(initialDelayMs * multiplier ** (attempt - 1), maxDelayMs));
    },
  };
};

export const normalizeBackoff = (input: BackoffInput): BackoffPolicy => {
  if (typeof input === "number") {
    return fixedBackoff(input);
  }
  if (Array.isArray(input)) {
    return sequenceBackoff(input);
  }
  if (typeof input === "function") {
    return {
      delayForAttempt(attempt: number): number {
        assertAttempt(attempt);
        return normalizeDelay(input(attempt));
      },
    };
  }
  return input;
};

export const delayForAttempt = (input: BackoffInput, attempt: number): number =>
  normalizeBackoff(input).delayForAttempt(attempt);

const assertAttempt = (attempt: number): void => {
  if (!Number.isInteger(attempt) || attempt < 1) {
    throw new Error(`Backoff attempt must be a positive integer, got ${attempt}`);
  }
};

const normalizeDelay = (delayMs: number): number => {
  if (!Number.isFinite(delayMs)) {
    throw new Error(`Backoff delay must be finite, got ${delayMs}`);
  }
  return Math.max(0, Math.floor(delayMs));
};
