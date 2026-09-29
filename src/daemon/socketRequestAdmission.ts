import {
  DAEMON_BOUND_SESSION_PARAM,
  DAEMON_OWNED_SESSIONS_PARAM,
  DAEMON_RELEASED_SESSION_PARAM,
} from "./constants";
import type { DaemonRequest } from "./types";

/**
 * Per-socket admission control for daemon requests (issue #6387).
 *
 * A socket used to run one request at a time, so a call for one device waited
 * behind an unrelated long call for another device and could time out in the
 * queue without ever running. Requests now carry an admission lane:
 *
 * - A lane-less request is a barrier. It starts only once every earlier request
 *   on the socket has finished, and nothing that arrived after it starts until it
 *   finishes. This is the original strict FIFO.
 * - A laned request starts as soon as no earlier barrier is pending or running and
 *   no earlier request in the same lane is pending or running. Requests in
 *   different lanes run concurrently; requests in one lane keep arrival order.
 */
export class SocketRequestAdmissionQueue {
  private readonly pending: Array<{ lane: string | undefined; run: () => Promise<void> }> = [];
  private readonly runningLanes = new Set<string>();
  private runningCount = 0;
  private barrierRunning = false;

  /** Requests admitted to the socket that have not started yet. */
  get pendingCount(): number {
    return this.pending.length;
  }

  run<T>(lane: string | undefined, handler: () => Promise<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      this.pending.push({
        lane,
        run: () => handler().then(resolve, reject),
      });
      this.pump();
    });
  }

  private pump(): void {
    if (this.barrierRunning) {
      return;
    }
    const blockedLanes = new Set<string>();
    let index = 0;
    while (index < this.pending.length) {
      const entry = this.pending[index];
      if (entry.lane === undefined) {
        if (index === 0 && this.runningCount === 0) {
          this.start(this.pending.shift()!);
        }
        return;
      }
      if (this.runningLanes.has(entry.lane) || blockedLanes.has(entry.lane)) {
        blockedLanes.add(entry.lane);
        index++;
        continue;
      }
      this.start(this.pending.splice(index, 1)[0]);
    }
  }

  private start(entry: { lane: string | undefined; run: () => Promise<void> }): void {
    this.runningCount++;
    if (entry.lane === undefined) {
      this.barrierRunning = true;
    } else {
      this.runningLanes.add(entry.lane);
    }
    void entry.run().finally(() => {
      this.runningCount--;
      if (entry.lane === undefined) {
        this.barrierRunning = false;
      } else {
        this.runningLanes.delete(entry.lane);
      }
      this.pump();
    });
  }
}

/** Acquisition and profile tools rebind the socket's routing state, so they stay barriers. */
const SOCKET_ROUTING_MUTATING_TOOLS = new Set([
  "getAndroid",
  "getApple",
  "startDevice",
  "provisionDevice",
  "setActiveDevice",
  "setToolEnabled",
]);

/**
 * Arguments that route to, restore, or rebind a device session. A call carrying any
 * of them can change the socket's bound route, so it stays a barrier.
 */
const SESSION_ROUTING_ARGS = [
  "sessionUuid",
  "device",
  DAEMON_BOUND_SESSION_PARAM,
  DAEMON_OWNED_SESSIONS_PARAM,
  DAEMON_RELEASED_SESSION_PARAM,
];

/**
 * Resolve the admission lane for a request, or undefined for a barrier.
 *
 * Only a `tools/call` that names its physical device with an explicit `deviceId`
 * and carries none of `SESSION_ROUTING_ARGS` gets a lane. Such
 * a call executes under the `device:<deviceId>` key (see `getRequestArgumentScopeKey`)
 * and never writes the socket's bound route, so running it alongside a call for
 * another device cannot reorder anything a later request observes. Everything else,
 * including session-scoped calls that rebind the socket, keeps strict FIFO order.
 */
export function resolveSocketAdmissionLane(request: DaemonRequest): string | undefined {
  const name = request.params?.name;
  if (
    request.method !== "tools/call" ||
    typeof name !== "string" ||
    SOCKET_ROUTING_MUTATING_TOOLS.has(name)
  ) {
    return undefined;
  }
  const deviceId = explicitDeviceIdWithoutSession(request.params?.arguments);
  return deviceId === undefined ? undefined : `device:${deviceId}`;
}

function explicitDeviceIdWithoutSession(args: unknown): string | undefined {
  if (!args || typeof args !== "object" || Array.isArray(args)) {
    return undefined;
  }
  const deviceId = "deviceId" in args ? args.deviceId : undefined;
  if (typeof deviceId !== "string" || deviceId.length === 0) {
    return undefined;
  }
  return SESSION_ROUTING_ARGS.some((key) => key in args) ? undefined : deviceId;
}
