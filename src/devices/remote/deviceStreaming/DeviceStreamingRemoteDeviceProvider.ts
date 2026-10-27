/**
 * {@link RemoteDeviceProvider} backed by the DDP Device Streaming API (#14054). Sessions move
 * REQUESTED -> PENDING -> ACTIVE and the API must be polled; a session that never becomes active
 * within the allocation budget is cancelled so it cannot start billing later.
 */
import { ActionableError } from "../../../models/ActionableError";
import { errorMessage } from "../../../models/describeUnknownError";
import { defaultIdGenerator, type IdGenerator } from "../../../utils/IdGenerator";
import { logger } from "../../../utils/logger";
import type { Timer } from "../../../utils/SystemTimer";
import {
  assertRemoteDeviceRequestAllowed,
  estimateRemoteDeviceCost,
  type RemoteDeviceGuards,
} from "../remoteDeviceCostPolicy";
import {
  isTerminalRemoteSessionState,
  type RemoteDeviceProvider,
  type RemoteDeviceRequest,
  type RemoteDeviceReservation,
  type RemoteDeviceSession,
} from "../remoteDeviceProvider";
import type { DeviceStreamingApi } from "./DeviceStreamingApi";
import { DeviceStreamingApiError } from "./DeviceStreamingApiError";

const DEFAULT_POLL_INTERVAL_MS = 5_000;
const DEFAULT_ALLOCATION_TIMEOUT_MS = 10 * 60_000;
const MINUTE_MS = 60_000;

export interface DeviceStreamingProviderOptions {
  api: DeviceStreamingApi;
  projectId: string;
  guards: RemoteDeviceGuards;
  timer: Pick<Timer, "sleep" | "now">;
  ids?: IdGenerator;
  pollIntervalMs?: number;
  /** How long a session may wait for a device before it is cancelled. */
  allocationTimeoutMs?: number;
}

export class DeviceStreamingRemoteDeviceProvider implements RemoteDeviceProvider {
  private readonly ids: IdGenerator;
  private readonly pollIntervalMs: number;
  private readonly allocationTimeoutMs: number;

  constructor(private readonly options: DeviceStreamingProviderOptions) {
    this.ids = options.ids ?? defaultIdGenerator;
    this.pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
    this.allocationTimeoutMs = options.allocationTimeoutMs ?? DEFAULT_ALLOCATION_TIMEOUT_MS;
  }

  async reserve(
    request: RemoteDeviceRequest,
    signal?: AbortSignal,
  ): Promise<RemoteDeviceReservation> {
    assertRemoteDeviceRequestAllowed(this.options.guards, request.minutes);
    if (signal?.aborted) {
      throw new ActionableError("Remote device reservation was cancelled before it was created.");
    }
    const created = await this.options.api.create({
      projectId: this.options.projectId,
      sessionId: `automobile-${this.ids.next()}`,
      modelId: request.modelId,
      osVersionId: request.osVersionId,
      ttlMinutes: request.minutes,
      locale: request.locale,
      orientation: request.orientation,
    });
    const session = await this.awaitActive(created, signal);
    return { session, cost: estimateRemoteDeviceCost(request.minutes) };
  }

  async extend(sessionId: string, minutes: number): Promise<RemoteDeviceReservation> {
    const current = await this.options.api.get(sessionId);
    if (current.state !== "active" || current.expireTimeMs === undefined) {
      throw new ActionableError(
        `Remote session ${sessionId} cannot be extended while ${current.state}${stateDetail(current)}.`,
      );
    }
    const expireTimeMs = current.expireTimeMs + minutes * MINUTE_MS;
    const startMs = current.activeStartTimeMs ?? this.options.timer.now();
    const sessionMinutes = Math.ceil((expireTimeMs - startMs) / MINUTE_MS);
    assertRemoteDeviceRequestAllowed(this.options.guards, minutes, sessionMinutes);
    const session = await this.options.api.setExpireTime(sessionId, expireTimeMs);
    return { session, cost: estimateRemoteDeviceCost(minutes) };
  }

  get(sessionId: string): Promise<RemoteDeviceSession> {
    return this.options.api.get(sessionId);
  }

  async release(sessionId: string): Promise<void> {
    try {
      await this.options.api.cancel(sessionId);
    } catch (error) {
      if (!(error instanceof DeviceStreamingApiError) || error.httpStatus >= 500) {
        throw error;
      }
      // Cancelling an ended session is refused; that session is already released.
      const session = await this.options.api.get(sessionId);
      if (!isTerminalRemoteSessionState(session.state)) {
        throw error;
      }
      logger.debug(`Remote session ${sessionId} had already ended: ${errorMessage(error)}`);
    }
  }

  private async awaitActive(
    created: RemoteDeviceSession,
    signal: AbortSignal | undefined,
  ): Promise<RemoteDeviceSession> {
    const deadline = this.options.timer.now() + this.allocationTimeoutMs;
    let session = created;
    while (session.state !== "active") {
      if (isTerminalRemoteSessionState(session.state)) {
        throw new ActionableError(
          `Remote device was not allocated: session ${session.id} ended ${session.state}${stateDetail(session)}.`,
        );
      }
      if (signal?.aborted || this.options.timer.now() >= deadline) {
        await this.cancelUnallocated(session.id);
        throw new ActionableError(
          signal?.aborted
            ? `Remote device reservation was cancelled while ${session.state}.`
            : `No remote device was allocated within ${this.allocationTimeoutMs / 1000}s; ` +
                `session ${session.id} was cancelled while ${session.state}.`,
        );
      }
      await this.options.timer.sleep(this.pollIntervalMs);
      session = await this.options.api.get(session.id);
    }
    return session;
  }

  private async cancelUnallocated(sessionId: string): Promise<void> {
    try {
      await this.options.api.cancel(sessionId);
    } catch (error) {
      // The reservation already failed; keep that error and leave a trace of the stranded session.
      logger.warn(`Failed to cancel unallocated remote session ${sessionId}`, error);
    }
  }
}

function stateDetail(session: RemoteDeviceSession): string {
  return session.stateMessage ? ` (${session.stateMessage})` : "";
}
