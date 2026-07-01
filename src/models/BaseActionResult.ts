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
}
