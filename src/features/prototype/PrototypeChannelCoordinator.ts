/**
 * Owns the open host-proxied channel connections (#14268): the per-device open cap and
 * cancellation by prototype, by socket or by device. Mirrors `PrototypeRequestCoordinator`.
 */
import { logger } from "../../utils/logger";
import type {
  PrototypeChannelClose,
  PrototypeChannelExecutor,
  PrototypeChannelHandle,
  PrototypeChannelOpenRequest,
  PrototypeChannelSendResult,
  PrototypeChannelSink,
} from "./PrototypeChannelExecutor";
import { MAX_PROTOTYPE_CHANNELS_OPEN } from "./prototypeChannelLimits";

/** What the event coordinator needs to end channels; narrow on purpose. */
export interface PrototypeChannelCancellation {
  cancelPrototype(deviceId: string, prototypeId: string): void;
  cancelDevice(deviceId: string): void;
}

export interface PrototypeChannelTarget {
  deviceId: string;
  prototypeId: string;
  /** The socket the open arrived on. */
  connection: symbol;
  /** The device's id for the connection. */
  connectionId: string;
}

interface OpenChannel extends PrototypeChannelTarget {
  controller: AbortController;
  handle: PrototypeChannelHandle;
}

export type PrototypeChannelOpenOutcome =
  | { ok: true }
  | { ok: false; error: { code: "too_many_in_flight" | "invalid_request"; message: string } };

export class PrototypeChannelCoordinator implements PrototypeChannelCancellation {
  private readonly open_ = new Set<OpenChannel>();

  constructor(
    private readonly executor: PrototypeChannelExecutor,
    private readonly maxOpen: number = MAX_PROTOTYPE_CHANNELS_OPEN,
  ) {}

  openCount(deviceId?: string): number {
    return [...this.open_].filter((entry) => deviceId === undefined || entry.deviceId === deviceId)
      .length;
  }

  /** Starts the connection; its lifecycle reaches `sink`, which sees `closed` at most once. */
  open(
    target: PrototypeChannelTarget,
    request: PrototypeChannelOpenRequest,
    sink: PrototypeChannelSink,
  ): PrototypeChannelOpenOutcome {
    if (this.find(target.connection, target.connectionId) !== undefined) {
      return {
        ok: false,
        error: { code: "invalid_request", message: "That connection id is already open." },
      };
    }
    if (this.openCount(target.deviceId) >= this.maxOpen) {
      return {
        ok: false,
        error: {
          code: "too_many_in_flight",
          message: `At most ${this.maxOpen} channels may be open per device.`,
        },
      };
    }
    const controller = new AbortController();
    // The entry exists before the executor can report anything, so a synchronous close frees it.
    const entry = { ...target, controller } as OpenChannel;
    this.open_.add(entry);
    entry.handle = this.executor.open(
      request,
      {
        opened: (protocol) => sink.opened(protocol),
        frame: (frame) => sink.frame(frame),
        closed: (close: PrototypeChannelClose) => {
          this.open_.delete(entry);
          sink.closed(close);
        },
      },
      controller.signal,
    );
    return { ok: true };
  }

  send(
    connection: symbol,
    connectionId: string,
    data: string,
  ): PrototypeChannelSendResult | undefined {
    return this.find(connection, connectionId)?.handle.send(data);
  }

  /** The device closed one connection; its `closed` still reaches the sink once the peer answers. */
  close(connection: symbol, connectionId: string, code?: number, reason?: string): boolean {
    const entry = this.find(connection, connectionId);
    entry?.handle.close(code, reason);
    return entry !== undefined;
  }

  cancelPrototype(deviceId: string, prototypeId: string): void {
    this.cancelWhere((entry) => entry.deviceId === deviceId && entry.prototypeId === prototypeId);
  }

  /** Real device removal: ends every channel on the device, whichever socket opened it. */
  cancelDevice(deviceId: string): void {
    this.cancelWhere((entry) => entry.deviceId === deviceId);
  }

  /** A socket closed: ends only the channels it opened, so another app keeps its own. */
  cancelConnection(connection: symbol): void {
    this.cancelWhere((entry) => entry.connection === connection);
  }

  private find(connection: symbol, connectionId: string): OpenChannel | undefined {
    return [...this.open_].find(
      (entry) => entry.connection === connection && entry.connectionId === connectionId,
    );
  }

  private cancelWhere(match: (entry: OpenChannel) => boolean): void {
    for (const entry of [...this.open_].filter(match)) {
      logger.debug(`[PrototypeChannel] cancelling ${entry.deviceId}/${entry.prototypeId}`);
      // The slot frees now, not when the aborted transport settles, so a replacement is not refused.
      this.open_.delete(entry);
      entry.controller.abort();
    }
  }
}
