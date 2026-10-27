import type { Socket } from "node:net";
import type { FramesDroppedMessage } from "../deviceDataStream/streamContracts";

/** A threshold, not a maximum frame size: one full screenshot can itself exceed this. */
export const PUSH_SOCKET_WRITABLE_LIMIT_BYTES = 8 * 1024 * 1024;

interface PendingPush {
  message: unknown;
  serialized?: string;
  subscriptionId?: string;
}

type PushSocketWriter = Pick<Socket, "write" | "writableLength" | "destroyed">;

/** Per-connection FIFO, with latest-wins slots scoped to each subscription, device and epoch. */
export class PushSubscriberOutbox {
  private readonly pending = new Map<string | number, PendingPush>();
  private readonly reportedDrops = new Map<string, string | undefined>();
  private sequence = 0;

  constructor(private readonly socket: PushSocketWriter) {}

  send(message: unknown, drainPending: boolean, serialized?: string | (() => string)): boolean {
    if (this.socket.writableLength <= PUSH_SOCKET_WRITABLE_LIMIT_BYTES) {
      this.reportedDrops.clear();
    }
    const fields = this.fields(message);
    if (
      fields.type === "screenshot_update" &&
      !fields.correlated &&
      this.socket.writableLength > PUSH_SOCKET_WRITABLE_LIMIT_BYTES
    ) {
      const key = this.stateKey(
        fields.subscriptionId,
        fields.deviceId,
        fields.deviceSessionUuid,
        fields.type,
      );
      this.pending.delete(key);
      if (this.reportedDrops.has(key)) {
        return !drainPending;
      }
      this.reportedDrops.set(key, fields.subscriptionId);
      message = {
        type: "frames_dropped",
        subscriptionId: fields.subscriptionId,
        deviceId: fields.deviceId,
        deviceSessionUuid: fields.deviceSessionUuid,
        droppedType: "screenshot_update",
        reason: "backpressure",
      } satisfies FramesDroppedMessage;
      serialized = undefined;
    }
    const line = typeof serialized === "function" ? serialized() : serialized;
    if (drainPending) {
      this.enqueue(message, line);
      return false;
    }
    return this.write(message, line);
  }

  flush(): boolean {
    this.reportedDrops.clear();
    for (const [key, entry] of this.pending) {
      this.pending.delete(key);
      const ok =
        !this.socket.destroyed &&
        (typeof key === "string"
          ? this.send(entry.message, false, entry.serialized)
          : this.socket.write(entry.serialized!));
      if (!ok) {
        return false;
      }
    }
    return true;
  }

  removeSubscription(subscriptionId: string): void {
    for (const [key, entry] of this.pending) {
      if (typeof key === "string" && entry.subscriptionId === subscriptionId) {
        this.pending.delete(key);
      }
    }
    for (const [key, owner] of this.reportedDrops) {
      if (owner === subscriptionId) {
        this.reportedDrops.delete(key);
      }
    }
  }

  private enqueue(message: unknown, serialized?: string): void {
    const { type, subscriptionId, deviceId, deviceSessionUuid, correlated } = this.fields(message);
    // Only these full-state observation frames are replaceable. hierarchy_update
    // carries the complete tree; hierarchyDiff is advisory. There is no separate
    // observation_update wire type. Correlated replies (id/requestId), even
    // when named like state updates, and everything else are lossless FIFO, including
    // ping/pong, error, subscription_response, frames_dropped, lifecycle, build
    // context, navigation/storage/performance updates, telemetry_push,
    // performance_push, failure_push and unknown future types. Those can carry
    // deltas, request correlation or transitions; their names alone do not prove
    // that skipping them preserves protocol semantics.
    const key =
      !correlated && (type === "screenshot_update" || type === "hierarchy_update")
        ? this.stateKey(subscriptionId, deviceId, deviceSessionUuid, type)
        : ++this.sequence;
    // Map.set replaces in place, keeping state ahead of later acknowledgements.
    this.pending.set(key, {
      message: typeof key === "string" ? message : undefined,
      subscriptionId,
      // Snapshot lossless events now: callers may reuse/mutate their event data.
      serialized:
        serialized ?? (typeof key === "number" ? JSON.stringify(message) + "\n" : undefined),
    });
  }

  private write(message: unknown, serialized?: string): boolean {
    return this.socket.write(serialized ?? JSON.stringify(message) + "\n");
  }

  private stateKey(
    subscriptionId: string | undefined,
    deviceId: string | undefined,
    deviceSessionUuid: string | null | undefined,
    type: string,
  ): string {
    return [subscriptionId, deviceId, deviceSessionUuid, type]
      .map((field) => {
        if (field === undefined) {
          return "unset";
        }
        if (field === null) {
          return "null";
        }
        return `${field.length}:${field}`;
      })
      .join(":");
  }

  private fields(message: unknown): {
    type?: string;
    subscriptionId?: string;
    deviceId?: string;
    deviceSessionUuid?: string | null;
    correlated?: boolean;
  } {
    if (typeof message !== "object" || message === null) {
      return {};
    }
    const frame = message as Record<string, unknown>;
    return {
      correlated: "id" in frame || "requestId" in frame,
      type: typeof frame.type === "string" ? frame.type : undefined,
      subscriptionId: typeof frame.subscriptionId === "string" ? frame.subscriptionId : undefined,
      deviceId: typeof frame.deviceId === "string" ? frame.deviceId : undefined,
      deviceSessionUuid:
        typeof frame.deviceSessionUuid === "string" || frame.deviceSessionUuid === null
          ? frame.deviceSessionUuid
          : undefined,
    };
  }
}
