import type { SessionBrokerOptions } from "./broker";
import { cleanDeviceReuseEnabled } from "./brokerOptions";
import { nativeProfile } from "./profile";
import { drainFailureOutcome } from "./brokerSupport";
import { ResetFailureError } from "./ResetFailureError";
import type { BrokerTimingRecorder } from "./timingRecorder";
import type { BrokerRequestRecord, BrokerResourceRecord, DestructionTicket } from "./store";
import type {
  SessionBrokerResetTiming,
  SessionBrokerReleaseResult,
} from "../../devices/sessionBrokerResult";

export class BrokerResetRelease {
  async releaseStatus(
    request: BrokerRequestRecord,
    sessionUuid: string,
  ): Promise<SessionBrokerReleaseResult> {
    const resource = request.resourceId
      ? await this.options.store.getResource(request.resourceId)
      : undefined;
    const pending =
      resource?.requestId === request.requestId &&
      resource.state !== "idle" &&
      resource.state !== "destroyed";
    const latest = await this.options.store.getRequest(request.requestId);
    return {
      sessionUuid,
      outcome: pending ? "cleanup_pending" : "released",
      ...(latest?.timing ? { timing: latest.timing } : {}),
    };
  }

  constructor(
    private readonly options: Pick<
      SessionBrokerOptions,
      "store" | "devices" | "owner" | "limits" | "reuseCleanDevices" | "reuseAndroidCleanDevices"
    >,
    private readonly timing: BrokerTimingRecorder,
    private readonly now: () => number,
    private readonly tryCleanup: (ticket: DestructionTicket, signal?: AbortSignal) => Promise<void>,
  ) {}

  async drainAndReset(
    request: BrokerRequestRecord,
    resource: BrokerResourceRecord,
    sessionUuid: string,
    signal?: AbortSignal,
  ): Promise<"idle" | "destroy" | "pending"> {
    let resetClean = false;
    let timing = this.timing.initialResetTiming(request, resource);
    const record = () => this.timing.recordResetTiming(request, resource, timing);
    try {
      await record();
      const drainStarted = this.now();
      if (!(await this.options.devices.release(sessionUuid)).settled) {
        timing.phases.drain = this.now() - drainStarted;
        await record();
        return "pending";
      }
      timing.phases.drain = this.now() - drainStarted;
      signal?.throwIfAborted();
      if (
        !cleanDeviceReuseEnabled(nativeProfile(resource).platform, this.options) ||
        !this.options.devices.reset ||
        resource.state !== "resetting"
      ) {
        await record();
        return "destroy";
      }
      const resetStarted = this.now();
      const reset = await this.options.devices.reset(resource);
      timing.phases.reset = this.now() - resetStarted;
      timing = this.timing.mergeResetTiming(timing, reset);
      if (
        ![
          "clean",
          "fallback:keep-booted",
          "fallback:erase",
          "fallback:snapshot",
          "fallback:wipe-data",
        ].includes(timing.outcome)
      ) {
        timing.outcome = "pending";
        await record();
        return "destroy";
      }
      signal?.throwIfAborted();
      resetClean = true;
      await this.completeCleanReset(request, resource, timing, signal);
      return "idle";
    } catch (error) {
      timing = resetClean ? timing : this.timing.failedResetTiming(timing, error);
      await record();
      return drainFailureOutcome(
        error instanceof ResetFailureError ? error.cause : error,
        sessionUuid,
        resetClean,
      );
    }
  }

  private async completeCleanReset(
    request: BrokerRequestRecord,
    resource: BrokerResourceRecord,
    timing: SessionBrokerResetTiming,
    signal?: AbortSignal,
  ): Promise<void> {
    const tickets = await this.options.store.completeCleanRelease(
      request.requestId,
      this.options.owner,
      this.options.limits,
    );
    if (tickets.some((ticket) => ticket.resourceId === resource.resourceId)) {
      timing.outcome = "pending";
      timing.retired = true;
      await this.timing.recordResetTiming(request, resource, timing);
    }
    for (const ticket of tickets) {
      signal?.throwIfAborted();
      await this.tryCleanup(ticket, signal);
    }
    const current = await this.options.store.getResource(resource.resourceId);
    if (current?.state === "destroyed") {
      timing.outcome = "destroyed";
    }
    await this.timing.recordResetTiming(request, resource, timing);
  }
}
