import { ENV, readEnvEnum } from "../config/env";

/** `AUTOMOBILE_ELICITATION=off` disables the device question in every era (#15590). */
export function elicitationEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return readEnvEnum(ENV.ELICITATION, env) !== "off";
}

/**
 * Remembers, for one connection, the candidate sets a person declined or cancelled so the same
 * ambiguity is not asked again on every call. A different candidate set is a new question. Only
 * legacy connections are stateful, so only they use it.
 */
export class DeclineMemory {
  private readonly declined = new Set<string>();

  private static key(deviceIds: readonly string[]): string {
    return [...new Set(deviceIds)].sort().join("\u0000");
  }

  remembers(deviceIds: readonly string[]): boolean {
    return this.declined.has(DeclineMemory.key(deviceIds));
  }

  remember(deviceIds: readonly string[]): void {
    this.declined.add(DeclineMemory.key(deviceIds));
  }
}
