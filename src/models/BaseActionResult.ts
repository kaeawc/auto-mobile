import { ObserveResult } from "./ObserveResult";

/**
 * Shared base for action results that report success and optionally attach a
 * post-action observation snapshot.
 *
 * Kept deliberately separate from `observe/shared` `BaseResult` (which carries
 * timing fields and no `observation`) — the two model different concerns.
 */
export interface BaseActionResult {
  success: boolean;
  observation?: ObserveResult;
  error?: string;
  /**
   * Advisory notes about a SUCCESSFUL action: a best-effort post-action epilogue
   * (keyboard dismissal, cleanup) that failed without preventing the primary
   * effect (issue #6868). `error` stays reserved for "the thing you asked for did
   * not happen" — the two are never set together. Populate through
   * `withEpilogueWarning` (`src/utils/bestEffortEpilogue.ts`) so the shape stays
   * uniform, and omit the field entirely when there is nothing to warn about.
   */
  warnings?: string[];
}
