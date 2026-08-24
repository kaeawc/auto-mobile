import type { Element, ObserveResult } from "../../../models";

/**
 * Outcome of evaluating a condition predicate against one observation.
 * `candidates` are the near-matches seen this poll — surfaced on timeout so the
 * model can debug a failed wait instead of getting a bare `false`.
 */
export interface ConditionEvaluation {
  matched: boolean;
  /** The element that satisfied the predicate, when matched. */
  matchedElement?: Element;
  /** Near-matches seen this poll (e.g. partial text matches). */
  candidates?: Element[];
}

/**
 * A predicate over a single observation. A lambda can't cross the MCP wire, so
 * the tool layer builds one of these from a declarative selector; the poll loop
 * here is predicate-agnostic and cross-platform.
 */
export type ConditionPredicate = (observation: ObserveResult) => ConditionEvaluation;

/**
 * Options for a wait-for-condition poll (issue #4389).
 */
export interface WaitForConditionOptions {
  /** Hard budget in ms — the mandatory timeout fallback (default 5000). */
  timeoutMs?: number;
  /** Poll interval in ms between observations (default 150). */
  pollMs?: number;
  /** Cancellation signal, checked before each poll and after each observation. */
  signal?: AbortSignal;
}

/**
 * Result of a wait-for-condition poll. On success carries the matched element;
 * on timeout carries the last-seen candidates (never a bare failure).
 */
export interface WaitForConditionResult {
  matched: boolean;
  /** The element that satisfied the predicate (present only when matched). */
  matchedElement?: Element;
  /** Last-seen near-matches; populated on timeout, empty on immediate match. */
  candidates: Element[];
  /** The observation on which the loop stopped (matched or last polled). */
  observation: ObserveResult;
  polls: number;
  waitMs: number;
  timedOut: boolean;
}

/**
 * Poll the screen until a predicate over the hierarchy holds, returning the
 * matched element — or, on timeout, the last-seen near-matches.
 */
export interface WaitForCondition {
  execute(
    predicate: ConditionPredicate,
    options?: WaitForConditionOptions,
  ): Promise<WaitForConditionResult>;
}
