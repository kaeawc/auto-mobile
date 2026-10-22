import type { Platform } from "../models";
import type { ToolMutation } from "./deviceMutationAdapters";

/**
 * Orchestration tool families: the journal intents recorded before the tool acts (#14359).
 * Returns undefined for a tool this family does not own, [] for an owned call that changes
 * nothing, and the intents otherwise.
 */
export function orchestrationToolMutations(
  _name: string,
  _args: Record<string, unknown>,
  _platform?: Platform,
): ToolMutation[] | undefined {
  return undefined;
}
