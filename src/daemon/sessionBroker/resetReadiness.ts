import { defaultTimer, type Timer } from "../../utils/SystemTimer";
import { raceWithDeadline } from "../../utils/raceWithDeadline";
import type {
  BrokerAdmission,
  BrokerAdmissionInput,
  BrokerResourceRecord,
  BrokerTimingSample,
} from "./store";
import type { SqliteSessionBrokerStore } from "./sqliteStore";
import { readBrokerTimingStats } from "./timingStats";
import { nativeProfile } from "./profile";
import { DEFAULT_PROVISION_DEVICE_TIMEOUT_MS } from "../../utils/deviceTimeouts";
import { SessionBrokerFailureError } from "./devicePort";
import type { SessionBrokerStats } from "../../devices/sessionBrokerResult";
import { logger } from "../../utils/logger";

function successfulTimingSample(sample: BrokerTimingSample): BrokerTimingSample {
  return {
    ...sample,
    timing: {
      acquisition:
        sample.timing.acquisition?.admission === "reuse" ? undefined : sample.timing.acquisition,
      reset:
        sample.timing.reset?.outcome === "clean" ||
        sample.timing.reset?.outcome.startsWith("fallback:")
          ? sample.timing.reset
          : undefined,
    },
  };
}

/**
 * A real cold acquisition also pays the automation-readiness phase (runner/CtrlProxy start,
 * 60-70 s on iOS), so the break-even is the whole create path, not just create + boot (#14791).
 */
function coldCreateMs(
  group: SessionBrokerStats["groups"][number],
  createAndBootMs: number,
): number {
  const phases = group.acquisitionPhases;
  return Math.max(createAndBootMs + (phases.automationReadyMs?.p50 ?? 0), phases.totalMs?.p50 ?? 0);
}

function phaseEstimate(
  group: SessionBrokerStats["groups"][number] | undefined,
): { resetMs: number; thresholdMs: number } | undefined {
  const resetMs = group?.resetPhases.totalMs?.p90;
  const createMs = group?.acquisitionPhases.createMs?.p50;
  const bootMs = group?.acquisitionPhases.bootMs?.p50;
  if (
    resetMs === undefined ||
    createMs === undefined ||
    bootMs === undefined ||
    createMs + bootMs <= 0
  ) {
    return undefined;
  }
  return { resetMs, thresholdMs: coldCreateMs(group!, createMs + bootMs) };
}

type ReadinessStore = Pick<
  SqliteSessionBrokerStore,
  "getResource" | "getRequest" | "listLiveResources" | "timingSamples" | "continueAdmission"
>;

export class ResetReadiness {
  private readonly listeners = new Map<string, Set<() => void>>();
  private readonly activeResets = new Set<string>();
  private readonly waiters = new Map<string, string>();

  constructor(
    private readonly store: ReadinessStore,
    private readonly timer: Pick<Timer, "now" | "setTimeout" | "clearTimeout"> = defaultTimer,
  ) {}

  async snapshot(
    matches: BrokerAdmissionInput["matches"],
  ): Promise<BrokerAdmissionInput["resetReadiness"]> {
    try {
      return await this.readSnapshot(matches);
    } catch (error) {
      logger.warn("Could not estimate resetting simulator readiness", error);
      return undefined;
    }
  }

  setResetActive(resourceId: string, active: boolean): void {
    if (active) {
      this.activeResets.add(resourceId);
    } else {
      this.activeResets.delete(resourceId);
    }
  }

  releaseWait(requestId: string): void {
    this.waiters.delete(requestId);
  }

  private canWait(resourceId: string): boolean {
    return this.activeResets.has(resourceId) && ![...this.waiters.values()].includes(resourceId);
  }

  private async readSnapshot(
    matches: BrokerAdmissionInput["matches"],
  ): Promise<BrokerAdmissionInput["resetReadiness"]> {
    const resources = (await this.store.listLiveResources()).filter(
      (resource) =>
        resource.state === "resetting" &&
        this.canWait(resource.resourceId) &&
        matches(resource.profile) &&
        // A watch reset also re-boots through the simulator boot gate; it is waited on like iOS.
        nativeProfile(resource).platform !== "android",
    );
    if (resources.length === 0) {
      return undefined;
    }
    const stats = await readBrokerTimingStats(
      {
        timingSamples: async (sinceMs, untilMs, limit) =>
          (await this.store.timingSamples(sinceMs, untilMs, limit)).map(successfulTimingSample),
      },
      () => this.timer.now(),
      24 * 60 * 60 * 1000,
      5000,
    );
    const expectedReadyMs = new Map<string, number>();
    let thresholdMs = Number.POSITIVE_INFINITY;
    for (const resource of resources) {
      const group = stats.groups.find(
        (entry) => JSON.stringify(entry.profile) === JSON.stringify(nativeProfile(resource)),
      );
      const estimate = phaseEstimate(group);
      if (!estimate) {
        continue;
      }
      const remainingMs = await this.remainingMs(resource, estimate.resetMs);
      if (remainingMs === undefined) {
        continue;
      }
      expectedReadyMs.set(resource.resourceId, remainingMs);
      thresholdMs = Math.min(thresholdMs, estimate.thresholdMs);
    }
    return expectedReadyMs.size > 0
      ? {
          thresholdMs,
          expectedReadyMs,
          canWait: (resourceId) => this.canWait(resourceId),
          reserveWait: (requestId, resourceId) => this.waiters.set(requestId, resourceId),
        }
      : undefined;
  }

  private async remainingMs(
    resource: BrokerResourceRecord,
    resetMs: number,
  ): Promise<number | undefined> {
    const request = resource.requestId
      ? await this.store.getRequest(resource.requestId)
      : undefined;
    const reset = request?.timing?.reset;
    if (!reset || reset.outcome !== "pending") {
      return undefined;
    }
    const remainingMs = resetMs - (this.timer.now() - reset.startedAtMs);
    return remainingMs < 0 ? undefined : remainingMs;
  }

  notify(resourceId: string): void {
    for (const listener of this.listeners.get(resourceId) ?? []) {
      listener();
    }
  }

  async continueAfterWait(
    admission: BrokerAdmission,
    input: BrokerAdmissionInput,
    preparationTimeoutMs: number | undefined,
    signal: AbortSignal,
  ): Promise<{ admission: BrokerAdmission; preparationTimeoutMs: number | undefined }> {
    if (admission.kind !== "wait") {
      return { admission, preparationTimeoutMs };
    }
    const deadlineMs =
      (input.timingStartedAtMs ?? this.timer.now()) +
      (preparationTimeoutMs ?? DEFAULT_PROVISION_DEVICE_TIMEOUT_MS);
    const extensionMs = input.resetReadiness?.thresholdMs ?? 0;
    try {
      await this.wait(
        admission.resourceId,
        Math.max(0, Math.min(admission.waitMs, deadlineMs - this.timer.now())),
        signal,
      );
      if (
        extensionMs > 0 &&
        (await this.store.getResource(admission.resourceId))?.state === "resetting" &&
        this.activeResets.has(admission.resourceId) &&
        this.timer.now() < deadlineMs
      ) {
        // One cold-create estimate past expiry is break-even for a create started then;
        // the caller's preparation deadline still caps the extension.
        await this.wait(
          admission.resourceId,
          Math.max(0, Math.min(extensionMs, deadlineMs - this.timer.now())),
          signal,
        );
      }
    } finally {
      this.releaseWait(input.requestId);
    }
    signal.throwIfAborted();
    const remainingMs = deadlineMs - this.timer.now();
    if (remainingMs <= 0) {
      throw new SessionBrokerFailureError({
        code: "session_preparation_failed",
        message: "Session preparation deadline expired waiting for a resetting simulator",
        retryable: true,
      });
    }
    input.resetReadiness = undefined;
    return {
      admission: await this.store.continueAdmission(input),
      preparationTimeoutMs: remainingMs,
    };
  }

  async wait(resourceId: string, waitMs: number, signal: AbortSignal): Promise<void> {
    const settled = Promise.withResolvers<void>();
    const listeners = this.listeners.get(resourceId) ?? new Set<() => void>();
    this.listeners.set(resourceId, listeners);
    listeners.add(settled.resolve);
    const handle = this.timer.setTimeout(settled.resolve, waitMs);
    try {
      const resource = await this.store.getResource(resourceId);
      if (resource?.state !== "resetting" || !this.activeResets.has(resourceId)) {
        return;
      }
      await raceWithDeadline(() => settled.promise, {
        timer: this.timer,
        signal,
        label: "Waiting for resetting simulator",
      });
    } finally {
      this.timer.clearTimeout(handle);
      listeners.delete(settled.resolve);
      if (listeners.size === 0) {
        this.listeners.delete(resourceId);
      }
    }
  }
}
