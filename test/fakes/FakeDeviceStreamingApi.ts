import type {
  CreateDeviceSessionRequest,
  DeviceStreamingApi,
} from "../../src/devices/remote/deviceStreaming/DeviceStreamingApi";
import type { RemoteDeviceSession } from "../../src/devices/remote/remoteDeviceProvider";

/**
 * In-memory Device Streaming sessions. `create` returns a REQUESTED session named
 * `projects/<project>/deviceSessions/<sessionId>`; script later polls with `queueGets`, otherwise
 * `get` keeps returning the session's latest state. `cancel` finishes the session unless
 * `cancelError` is set.
 */
export class FakeDeviceStreamingApi implements DeviceStreamingApi {
  readonly creates: CreateDeviceSessionRequest[] = [];
  readonly cancels: string[] = [];
  readonly expireTimeUpdates: Array<{ name: string; expireTimeMs: number }> = [];
  getCount = 0;
  cancelError?: Error;
  private readonly sessions = new Map<string, RemoteDeviceSession>();
  private readonly queuedGets = new Map<string, RemoteDeviceSession[]>();

  async create(request: CreateDeviceSessionRequest): Promise<RemoteDeviceSession> {
    this.creates.push(request);
    const session: RemoteDeviceSession = {
      id: `projects/${request.projectId}/deviceSessions/${request.sessionId}`,
      state: "requested",
    };
    this.sessions.set(session.id, session);
    return session;
  }

  /** Each later `get` of `name` returns the next queued session state, then keeps the last one. */
  queueGets(name: string, ...states: Array<Partial<RemoteDeviceSession>>): void {
    const base = this.sessions.get(name) ?? { id: name, state: "requested" };
    this.queuedGets.set(
      name,
      states.map((state) => ({ ...base, ...state })),
    );
  }

  seed(session: RemoteDeviceSession): void {
    this.sessions.set(session.id, session);
  }

  async get(name: string): Promise<RemoteDeviceSession> {
    this.getCount++;
    const next = this.queuedGets.get(name)?.shift();
    if (next) {
      this.sessions.set(name, next);
    }
    const session = this.sessions.get(name);
    if (!session) {
      throw new Error(`FakeDeviceStreamingApi: unknown session ${name}`);
    }
    return session;
  }

  async setExpireTime(name: string, expireTimeMs: number): Promise<RemoteDeviceSession> {
    this.expireTimeUpdates.push({ name, expireTimeMs });
    const session = { ...(await this.get(name)), expireTimeMs };
    this.sessions.set(name, session);
    return session;
  }

  async cancel(name: string): Promise<void> {
    this.cancels.push(name);
    if (this.cancelError) {
      throw this.cancelError;
    }
    const session = this.sessions.get(name);
    if (session) {
      this.sessions.set(name, { ...session, state: "finished" });
    }
  }
}
