import type { Timer } from "../../../utils/SystemTimer";
import type { ScreenIdentity } from "../../../models";
import type { IosSdkEventIngestor } from "./IosSdkEventIngestor";
import { decodeSdkEventBatches, type DecodedSdkEvent } from "./decodeSdkEventBatches";
import type {
  CtrlProxySdkScreenIdentity,
  SdkScreenIdentityPollGeneration,
} from "./CtrlProxySdkScreenIdentity";
import { raceWithDeadline } from "../../../utils/raceWithDeadline";
import { logger } from "../../../utils/logger";
export type SdkEventPollResult = {
  receivedEvents: boolean;
  rememberedApplicationIds: Set<string>;
};
interface SdkEventsHost {
  readonly timer: Timer;
  readonly screenIdentity: CtrlProxySdkScreenIdentity;
  getSdkEventIngestor(): IosSdkEventIngestor;
  getPort(): number;
  hasLogDemand(): boolean;
  resolveWebSocketHost(): string;
  pollSdkEvents(): Promise<SdkEventPollResult>;
  getSdkScreenIdentity(appId?: string): ScreenIdentity | undefined;
  getSdkAvailability(appId?: string): boolean | undefined;
}
/** Long-poll scheduling, backoff and generation-bound event ingestion. */
export class CtrlProxySdkEvents {
  constructor(private readonly host: SdkEventsHost) {}

  private sdkEventPollGeneration = 0;

  private sdkEventPollAbortController: AbortController | null = null;

  private sdkEventPollInFlight: {
    generation: number;
    promise: Promise<SdkEventPollResult>;
  } | null = null;

  private static readonly SDK_EVENT_POLL_TIMEOUT_MS = 2000;

  // Fast cadence for the CtrlProxy /sdk-events long-poll (was a bare `2000`).
  private static readonly SDK_EVENT_POLL_INTERVAL_MS = 2000;

  // After this many consecutive empty batches (e.g. an app with no SDK
  // integrated) the poll backs off to the slower cadence below. App activity on
  // WS resets the counter and restores fast cadence (#5472, AC#2).
  private static readonly SDK_EVENT_POLL_EMPTY_BATCHES_BEFORE_BACKOFF = 5;

  private static readonly SDK_EVENT_POLL_BACKOFF_INTERVAL_MS = 30_000;

  private sdkEventPollConsecutiveEmpty = 0;

  private static readonly SDK_IDENTITY_REFRESH_TIMEOUT_MS = 100;

  private static readonly SDK_IDENTITY_REFRESH_RETRY_MS = 10;

  /**
   * Drain the CtrlProxy SDK-event queue before returning the current identity.
   * Observe calls this after reading the hierarchy so a navigation event does
   * not wait for the background poll interval before it reaches the diff gate.
   */
  public async refreshSdkScreenIdentity(
    applicationId?: string,
    capturedAt?: number,
  ): Promise<ScreenIdentity | undefined> {
    const available = this.host.getSdkAvailability(applicationId);
    // #4463: a newer capture may precede its navigation event in /sdk-events.
    // Missing capability/freshness evidence keeps the conservative 100 ms retry.
    // #14432: a cached SDK absence may predate the in-app SDK server's start, so
    // it skips the retry but still drains the queue once.
    const needsRetry =
      available === undefined ||
      (available === true &&
        !this.host.screenIdentity.hasSdkScreenIdentityForCapture(applicationId, capturedAt));
    const deadline = this.host.timer.now() + CtrlProxySdkEvents.SDK_IDENTITY_REFRESH_TIMEOUT_MS;
    while (this.host.timer.now() < deadline) {
      const result = await this.pollSdkEventsUntil(deadline);
      const refreshed = applicationId
        ? result?.rememberedApplicationIds.has(applicationId)
        : result?.receivedEvents;
      if (refreshed || !needsRetry) {
        break;
      }
      const remaining = deadline - this.host.timer.now();
      if (remaining <= 0) {
        break;
      }
      await this.host.timer.sleep(
        Math.min(CtrlProxySdkEvents.SDK_IDENTITY_REFRESH_RETRY_MS, remaining),
      );
    }
    return this.host.getSdkScreenIdentity(applicationId);
  }

  private async pollSdkEventsUntil(deadline: number): Promise<SdkEventPollResult | undefined> {
    const remaining = deadline - this.host.timer.now();
    if (remaining <= 0) {
      return undefined;
    }
    const timedOut = new Error("SDK event poll timed out");
    try {
      return await raceWithDeadline(this.host.pollSdkEvents(), {
        timer: this.host.timer,
        timeoutMs: remaining,
        label: "SDK event poll",
        timeoutError: () => timedOut,
      });
    } catch (error) {
      if (error === timedOut) {
        return undefined;
      }
      throw error;
    }
  }

  private sdkEventPollTimer: ReturnType<typeof setTimeout> | null = null;

  startSdkEventPolling(): void {
    this.stopSdkEventPolling();
    this.sdkEventPollConsecutiveEmpty = 0;
    // Self-rescheduling loop (was a fixed setInterval) so the cadence can adapt:
    // an immediate poll, then reschedule at fast or backed-off cadence based on
    // whether batches keep coming back empty.
    void this.runSdkEventPollCycle(this.sdkEventPollGeneration);
  }

  async runSdkEventPollCycle(generation: number): Promise<void> {
    if (generation !== this.sdkEventPollGeneration) {
      return;
    }
    const result = await this.host.pollSdkEvents();
    if (generation !== this.sdkEventPollGeneration) {
      return;
    }
    if (result.receivedEvents) {
      this.sdkEventPollConsecutiveEmpty = 0;
    } else {
      this.sdkEventPollConsecutiveEmpty++;
    }
    this.scheduleNextSdkEventPoll(generation);
  }

  private scheduleNextSdkEventPoll(generation: number): void {
    if (generation !== this.sdkEventPollGeneration) {
      return;
    }
    if (this.sdkEventPollTimer) {
      this.host.timer.clearTimeout(this.sdkEventPollTimer);
    }
    this.sdkEventPollTimer = this.host.timer.setTimeout(() => {
      void this.runSdkEventPollCycle(generation);
    }, this.currentSdkEventPollIntervalMs());
  }

  currentSdkEventPollIntervalMs(): number {
    if (this.host.hasLogDemand()) {
      return CtrlProxySdkEvents.SDK_EVENT_POLL_INTERVAL_MS;
    }
    return this.sdkEventPollConsecutiveEmpty >=
      CtrlProxySdkEvents.SDK_EVENT_POLL_EMPTY_BATCHES_BEFORE_BACKOFF
      ? CtrlProxySdkEvents.SDK_EVENT_POLL_BACKOFF_INTERVAL_MS
      : CtrlProxySdkEvents.SDK_EVENT_POLL_INTERVAL_MS;
  }

  /**
   * A hierarchy update or request response signals app activity,
   * so reset the empty-batch backoff and — if we had already backed off — restore
   * fast cadence immediately rather than waiting out the long backoff timer.
   */
  noteSdkEventPollWsActivity(): void {
    if (this.sdkEventPollConsecutiveEmpty === 0) {
      return;
    }
    const wasBackedOff =
      this.sdkEventPollConsecutiveEmpty >=
      CtrlProxySdkEvents.SDK_EVENT_POLL_EMPTY_BATCHES_BEFORE_BACKOFF;
    this.sdkEventPollConsecutiveEmpty = 0;
    if (wasBackedOff && this.sdkEventPollTimer) {
      this.scheduleNextSdkEventPoll(this.sdkEventPollGeneration);
    }
  }

  /**
   * Run one SDK event poll (joining an in-flight one for the same generation). Public so
   * tests can drive polling directly with an injected FakeTimer instead of waiting on the
   * scheduler.
   */
  async pollSdkEvents(): Promise<SdkEventPollResult> {
    const generation = this.sdkEventPollGeneration;
    if (this.sdkEventPollInFlight?.generation === generation) {
      return this.sdkEventPollInFlight.promise;
    }

    const promise = this.pollSdkEventsOnce(generation);
    const inFlight = { generation, promise };
    this.sdkEventPollInFlight = inFlight;
    void promise
      .finally(() => {
        if (this.sdkEventPollInFlight === inFlight) {
          this.sdkEventPollInFlight = null;
        }
      })
      .catch((error) => logger.debug(`[IOSCtrlProxy] SDK event poll cleanup failed: ${error}`));
    return promise;
  }

  private async pollSdkEventsOnce(generation: number): Promise<SdkEventPollResult> {
    const pollGeneration = this.host.screenIdentity.capturePollGeneration();
    const host = this.host.resolveWebSocketHost();
    const url = `http://${host}:${this.host.getPort()}/sdk-events${this.host.hasLogDemand() ? "?logs=1" : ""}`;
    const abortController = new AbortController();
    this.sdkEventPollAbortController = abortController;
    const timeoutId = this.host.timer.setTimeout(
      () => abortController.abort(),
      CtrlProxySdkEvents.SDK_EVENT_POLL_TIMEOUT_MS,
    );
    try {
      const resp = await fetch(url, { signal: abortController.signal });
      if (generation !== this.sdkEventPollGeneration) {
        return this.emptySdkEventPollResult();
      }
      if (!resp.ok) {
        return this.emptySdkEventPollResult();
      }
      const batches = (await resp.json()) as Array<{
        bundleId?: string;
        events?: Array<{ eventType: string; payload: string }>;
      }>;
      const pollResult = await this.processSdkEventBatches(batches, generation, pollGeneration);
      return pollResult;
    } catch (error) {
      // Polling failure is non-fatal (endpoint down, timeout) — trace at debug.
      logger.debug(`[IOSCtrlProxy] SDK event poll failed: ${error}`);
      return this.emptySdkEventPollResult();
    } finally {
      this.host.timer.clearTimeout(timeoutId);
      if (this.sdkEventPollAbortController === abortController) {
        this.sdkEventPollAbortController = null;
      }
    }
  }

  private async processSdkEventBatches(
    batches: Array<{ bundleId?: string; events?: Array<{ eventType: string; payload: string }> }>,
    generation: number,
    pollGeneration: SdkScreenIdentityPollGeneration,
  ): Promise<SdkEventPollResult> {
    const events = this.decodeSdkEventBatches(batches, generation);
    const rememberedApplicationIds = new Set<string>();
    for (const event of events) {
      if (generation !== this.sdkEventPollGeneration) {
        return this.emptySdkEventPollResult();
      }
      const lifecycleEventHasCurrentPoll = this.host.screenIdentity.isSdkScreenIdentityPollCurrent(
        event.applicationId,
        pollGeneration,
      );
      if (this.host.screenIdentity.applySdkScreenIdentityLifecycleEvent(event)) {
        if (lifecycleEventHasCurrentPoll && event.applicationId) {
          pollGeneration.applicationGenerations.set(
            event.applicationId,
            this.host.screenIdentity.getSdkScreenIdentityGeneration(event.applicationId),
          );
        }
        continue;
      }
      if (
        this.host.screenIdentity.isSdkScreenIdentityPollCurrent(
          event.applicationId,
          pollGeneration,
        ) &&
        this.host.screenIdentity.rememberSdkScreenIdentity(
          event.eventType,
          event.applicationId,
          event.payload,
          event.timestamp,
          event.sequenceNumber,
        )
      ) {
        rememberedApplicationIds.add(event.applicationId!);
      }
    }
    for (const event of events) {
      if (generation !== this.sdkEventPollGeneration) {
        return this.emptySdkEventPollResult();
      }
      await this.host
        .getSdkEventIngestor()
        .recordSdkEvent(
          { type: event.eventType, timestamp: event.timestamp, payload: event.payload },
          event.applicationId ?? null,
        );
    }
    return { receivedEvents: events.length > 0, rememberedApplicationIds };
  }

  decodeSdkEventBatches(
    batches: Array<{ bundleId?: string; events?: Array<{ eventType: string; payload: string }> }>,
    generation: number,
  ): DecodedSdkEvent[] {
    return decodeSdkEventBatches(
      batches,
      () => this.host.timer.now(),
      () => generation === this.sdkEventPollGeneration,
    ).events;
  }

  stopSdkEventPolling(): void {
    if (this.sdkEventPollTimer) {
      this.host.timer.clearTimeout(this.sdkEventPollTimer);
      this.sdkEventPollTimer = null;
    }
  }

  private emptySdkEventPollResult(): SdkEventPollResult {
    return { receivedEvents: false, rememberedApplicationIds: new Set() };
  }
  close(): void {
    this.stopSdkEventPolling();
    this.sdkEventPollGeneration++;
    this.sdkEventPollAbortController?.abort();
    this.sdkEventPollAbortController = null;
  }
  diagnostics() {
    return {
      generation: this.sdkEventPollGeneration,
      consecutiveEmpty: this.sdkEventPollConsecutiveEmpty,
    };
  }
}
