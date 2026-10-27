import type {
  SessionBrokerPhaseStats,
  SessionBrokerStats,
} from "../../devices/sessionBrokerResult";
import { computePercentile } from "../../utils/percentile";
import type { BrokerTimingSample } from "./store";
import type { SqliteSessionBrokerStore } from "./sqliteStore";
import { ActionableError } from "../../models/ActionableError";
import { RECEIPT_RETENTION_MS } from "./retention";

export async function readBrokerTimingStats(
  store: Pick<SqliteSessionBrokerStore, "timingSamples">,
  now: () => number,
  windowMs: number,
  limit: number,
): Promise<SessionBrokerStats> {
  if (
    !Number.isFinite(windowMs) ||
    windowMs < 0 ||
    windowMs > RECEIPT_RETENTION_MS ||
    !Number.isInteger(limit) ||
    limit < 1 ||
    limit > 10000
  ) {
    throw new ActionableError(
      `Broker stats needs a window of 0 to ${RECEIPT_RETENTION_MS / 86_400_000} days and a limit of 1 to 10000`,
    );
  }
  const untilMs = now();
  const sinceMs = untilMs - windowMs;
  const samples = await store.timingSamples(sinceMs, untilMs, limit + 1);
  return {
    sinceMs,
    untilMs,
    limit,
    truncated: samples.length > limit,
    groups: aggregateBrokerTimings(samples.slice(0, limit), sinceMs, untilMs),
  };
}

export function aggregateBrokerTimings(
  samples: BrokerTimingSample[],
  sinceMs: number,
  untilMs: number,
): SessionBrokerStats["groups"] {
  const groups = new Map<string, BrokerTimingSample[]>();
  for (const sample of samples) {
    const key = JSON.stringify(sample.profile);
    const group = groups.get(key) ?? [];
    group.push(sample);
    groups.set(key, group);
  }
  return [...groups.values()]
    .map((samples) => {
      const inWindow = (completedAtMs: number | undefined) =>
        completedAtMs !== undefined && completedAtMs >= sinceMs && completedAtMs <= untilMs;
      const acquisitions = samples.flatMap((sample) =>
        sample.timing.acquisition?.outcome === "ready" &&
        inWindow(sample.timing.acquisition.completedAtMs)
          ? [sample.timing.acquisition]
          : [],
      );
      const resets = samples.flatMap((sample) =>
        sample.timing.reset && inWindow(sample.timing.reset.completedAtMs)
          ? [sample.timing.reset]
          : [],
      );
      const acquisitionValues: Record<string, number[]> = {};
      const resetValues: Record<string, number[]> = {};
      const add = (
        values: Record<string, number[]>,
        phase: string,
        duration: number | undefined,
      ) => {
        if (duration !== undefined && Number.isFinite(duration) && duration >= 0) {
          (values[phase] ??= []).push(duration);
        }
      };
      for (const acquisition of acquisitions) {
        for (const phase of [
          "queueMs",
          "admissionWaitMs",
          "createMs",
          "bootMs",
          "automationReadyMs",
          "totalMs",
        ] as const) {
          add(acquisitionValues, phase, acquisition[phase]);
        }
      }
      for (const reset of resets) {
        for (const [phase, duration] of Object.entries(reset.phases)) {
          add(resetValues, phase, duration);
        }
        add(resetValues, "totalMs", reset.totalMs);
      }
      const summarize = (
        values: Record<string, number[]>,
      ): Record<string, SessionBrokerPhaseStats> =>
        Object.fromEntries(
          Object.entries(values).map(([phase, durations]) => {
            durations.sort((left, right) => left - right);
            return [
              phase,
              {
                count: durations.length,
                p50: computePercentile(durations, 50),
                p90: computePercentile(durations, 90),
              },
            ];
          }),
        );
      return {
        profile: samples[0].profile,
        acquisitions: acquisitions.length,
        resets: resets.length,
        reuseHitRate: acquisitions.length
          ? acquisitions.filter((record) => record.admission === "reuse").length /
            acquisitions.length
          : 0,
        fallbackRate: resets.length
          ? resets.filter((record) => record.outcome.startsWith("fallback:")).length / resets.length
          : 0,
        retirements: samples.filter(
          ({ timing }) =>
            timing.reset &&
            (timing.reset.retired || timing.reset.outcome === "destroyed") &&
            inWindow(timing.reset.completedAtMs ?? timing.reset.startedAtMs),
        ).length,
        acquisitionPhases: summarize(acquisitionValues),
        resetPhases: summarize(resetValues),
      };
    })
    .filter((group) => group.acquisitions > 0 || group.resets > 0 || group.retirements > 0);
}
