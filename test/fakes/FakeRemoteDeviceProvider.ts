import { ActionableError } from "../../src/models/ActionableError";
import { estimateRemoteDeviceCost } from "../../src/devices/remote/remoteDeviceCostPolicy";
import type {
  RemoteDeviceProvider,
  RemoteDeviceRequest,
  RemoteDeviceReservation,
  RemoteDeviceSession,
} from "../../src/devices/remote/remoteDeviceProvider";

const MINUTE_MS = 60_000;

/**
 * Remote device provider that allocates immediately. Sessions are `fake-session-<n>`, active from
 * `nowMs` for the requested minutes. Set `reserveError` to make the next reservations fail.
 */
export class FakeRemoteDeviceProvider implements RemoteDeviceProvider {
  readonly reserved: RemoteDeviceRequest[] = [];
  readonly released: string[] = [];
  reserveError?: Error;
  private readonly sessions = new Map<string, RemoteDeviceSession>();

  constructor(public nowMs = 0) {}

  async reserve(request: RemoteDeviceRequest): Promise<RemoteDeviceReservation> {
    if (this.reserveError) {
      throw this.reserveError;
    }
    this.reserved.push(request);
    const session: RemoteDeviceSession = {
      id: `fake-session-${this.reserved.length}`,
      state: "active",
      activeStartTimeMs: this.nowMs,
      expireTimeMs: this.nowMs + request.minutes * MINUTE_MS,
    };
    this.sessions.set(session.id, session);
    return { session, cost: estimateRemoteDeviceCost(request.minutes) };
  }

  async extend(sessionId: string, minutes: number): Promise<RemoteDeviceReservation> {
    const current = await this.get(sessionId);
    if (current.state !== "active" || current.expireTimeMs === undefined) {
      throw new ActionableError(`Remote session ${sessionId} cannot be extended`);
    }
    const session = { ...current, expireTimeMs: current.expireTimeMs + minutes * MINUTE_MS };
    this.sessions.set(sessionId, session);
    return { session, cost: estimateRemoteDeviceCost(minutes) };
  }

  async get(sessionId: string): Promise<RemoteDeviceSession> {
    const session = this.sessions.get(sessionId);
    if (!session) {
      throw new ActionableError(`Unknown remote session ${sessionId}`);
    }
    return session;
  }

  async release(sessionId: string): Promise<void> {
    this.released.push(sessionId);
    const session = this.sessions.get(sessionId);
    if (session) {
      this.sessions.set(sessionId, { ...session, state: "finished" });
    }
  }
}
