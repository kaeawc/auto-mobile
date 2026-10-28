/**
 * Production wiring for host-proxied prototype channels (#14268), beside `prototypeRequestWiring`:
 * the coordinator the daemon prototype host owns and the attachment of a per-socket channel host to
 * each device client.
 */
import type { Timer } from "../../utils/SystemTimer";
import {
  KindPrototypeChannelExecutor,
  type PrototypeChannelExecutor,
} from "./PrototypeChannelExecutor";
import { PrototypeChannelCoordinator } from "./PrototypeChannelCoordinator";
import { SsePrototypeChannelExecutor } from "./SsePrototypeChannelExecutor";
import { WebSocketPrototypeChannelExecutor } from "./WebSocketPrototypeChannelExecutor";
import { createPrototypeChannelHost, type PrototypeChannelHost } from "./prototypeChannelHost";

export type { PrototypeChannelCoordinator };

type ChannelTimer = Pick<
  Timer,
  "setTimeout" | "clearTimeout" | "setInterval" | "clearInterval" | "now"
>;

/** The WebSocket- and SSE-backed coordinator the daemon prototype host owns (`executor` for tests). */
export function createPrototypeChannelCoordinator(
  timer: ChannelTimer,
  executor: PrototypeChannelExecutor = new KindPrototypeChannelExecutor(
    new WebSocketPrototypeChannelExecutor({ timer }),
    new SsePrototypeChannelExecutor({ timer }),
  ),
): PrototypeChannelCoordinator {
  return new PrototypeChannelCoordinator(executor);
}

/** Ends a prototype's or a device's work in several coordinators with one call. */
export function combinedPrototypeCancellation(
  ...parts: {
    cancelPrototype(deviceId: string, prototypeId: string): void;
    cancelDevice(deviceId: string): void;
  }[]
): {
  cancelPrototype(deviceId: string, prototypeId: string): void;
  cancelDevice(deviceId: string): void;
} {
  return {
    cancelPrototype: (deviceId, prototypeId) =>
      parts.forEach((part) => part.cancelPrototype(deviceId, prototypeId)),
    cancelDevice: (deviceId) => parts.forEach((part) => part.cancelDevice(deviceId)),
  };
}

/** Routes an iOS prototype agent's `prototype_channel_*` frames and disconnects to the coordinator. */
export function attachIosPrototypeChannels(
  agent: { attachChannelHost?(host: PrototypeChannelHost | undefined): void },
  deviceId: string,
  channels: PrototypeChannelCoordinator | undefined,
): void {
  if (channels !== undefined) {
    agent.attachChannelHost?.(createPrototypeChannelHost(deviceId, channels));
  }
}

/** Routes an Android client's `prototype_channel_*` frames and disconnects to the coordinator. */
export function attachAndroidPrototypeChannels(
  client: { attachPrototypeChannelHost?(host: PrototypeChannelHost | undefined): void },
  deviceId: string,
  channels: PrototypeChannelCoordinator | undefined,
): void {
  if (channels !== undefined) {
    client.attachPrototypeChannelHost?.(createPrototypeChannelHost(deviceId, channels));
  }
}
