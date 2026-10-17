/**
 * Lock owner identity uses Linux's /proc start tick plus boot ID, or Darwin's
 * ps lstart pinned to UTC. Other platforms supply no token. An unavailable,
 * unreadable, or incomparable sample is unknown: the live owner's lock stays held.
 */
import type { LockOwnerGenerationProbe, LockOwnerGenerationVerdict } from "./fileLock";
import { errorMessage } from "./describeUnknownError";
import { logger } from "./logger";
import { defaultTimer } from "./SystemTimer";
import { testOverrides } from "./testOverrides";
import {
  compareProcessGenerationTokens,
  readDarwinProcessGenerationToken,
  readLinuxProcessGenerationToken,
} from "./processGeneration";

export interface LockOwnerGenerationProbeDependencies {
  platform?: NodeJS.Platform;
  readLinuxProcessGenerationToken?: (pid: number) => string | undefined;
  readDarwinProcessGenerationToken?: (pid: number) => string | undefined;
  now?: () => number;
  captureDisabled?: () => boolean;
  sameVerdictTtlMs?: number;
}

export function createLockOwnerGenerationProbe(
  deps: LockOwnerGenerationProbeDependencies = {},
): LockOwnerGenerationProbe {
  const platform = deps.platform ?? process.platform;
  const now = deps.now ?? (() => defaultTimer.now());
  const captureDisabled =
    deps.captureDisabled ?? (() => testOverrides.processGenerationCaptureDisabled?.() ?? false);
  const ttl = deps.sameVerdictTtlMs ?? 1_000;
  const currentTokens = new Map<number, { token: string; at: number }>();
  const unavailableCurrent = new Map<number, number>();
  const sameVerdicts = new Map<number, { token?: string; at: number }>();

  function read(pid: number): string | undefined {
    try {
      const reader =
        platform === "linux"
          ? (deps.readLinuxProcessGenerationToken ?? readLinuxProcessGenerationToken)
          : platform === "darwin"
            ? (deps.readDarwinProcessGenerationToken ?? readDarwinProcessGenerationToken)
            : undefined;
      return reader?.(pid);
    } catch (error) {
      // Failure to sample proves nothing; unknown preserves a possibly live owner.
      logger.debug(`Lock owner process generation unreadable: ${errorMessage(error)}`);
      return undefined;
    }
  }

  return {
    current(pid): string | undefined {
      if (captureDisabled()) {
        return undefined;
      }
      const at = now();
      for (const [ownerPid, memo] of currentTokens) {
        if (at - memo.at >= ttl) {
          currentTokens.delete(ownerPid);
        }
      }
      for (const [ownerPid, sampledAt] of unavailableCurrent) {
        if (at - sampledAt >= ttl) {
          unavailableCurrent.delete(ownerPid);
        }
      }
      if (unavailableCurrent.has(pid)) {
        return undefined;
      }
      const memo = currentTokens.get(pid);
      if (memo) {
        return memo.token;
      }
      const token = read(pid);
      if (token !== undefined) {
        currentTokens.set(pid, { token, at: now() });
      } else {
        unavailableCurrent.set(pid, now());
      }
      return token;
    },
    compare(pid, recorded): LockOwnerGenerationVerdict {
      if (captureDisabled()) {
        sameVerdicts.clear();
        return "unknown";
      }
      const at = now();
      for (const [ownerPid, memo] of sameVerdicts) {
        if (at - memo.at >= ttl) {
          sameVerdicts.delete(ownerPid);
        }
      }
      const memo = sameVerdicts.get(pid);
      if (memo !== undefined) {
        if (memo.token === undefined) {
          return "unknown";
        }
        if (memo.token === recorded) {
          return "same";
        }
      }
      sameVerdicts.delete(pid);
      const fresh = read(pid);
      if (fresh === undefined) {
        sameVerdicts.set(pid, { at: now() });
        return "unknown";
      }
      const comparison = compareProcessGenerationTokens(recorded, fresh);
      if (comparison === "same") {
        sameVerdicts.set(pid, { token: recorded, at });
      }
      return comparison === "incomparable" ? "unknown" : comparison;
    },
  };
}

export const defaultLockOwnerGenerationProbe = createLockOwnerGenerationProbe();
