import contract from "../../../schemas/prototype-spec-contract.json";

/**
 * Limits for realtime channels (#14261). The shared spec contract
 * (`schemas/prototype-spec-contract.json` `limits`) is the single source, so the spec validator,
 * the host transport and the native runtimes cannot drift apart.
 */
export const {
  /** Channels per spec; a larger `channels` block is a structural error. */
  MAX_PROTOTYPE_CHANNELS,
  /** Routes per channel. */
  MAX_PROTOTYPE_CHANNEL_ROUTES,
  /** WebSocket subprotocols per channel. */
  MAX_PROTOTYPE_CHANNEL_PROTOCOLS,
  /** Header entries per channel. */
  MAX_PROTOTYPE_CHANNEL_HEADERS,
  /** An inbound frame larger than this is dropped and counted in `framesDropped`. */
  MAX_PROTOTYPE_CHANNEL_FRAME_BYTES,
  /** The largest `realtime.send` body; a larger one fails with `invalid_args`. */
  MAX_PROTOTYPE_CHANNEL_SEND_BYTES,
  /** Frames queued by `realtime.send` while a channel is connecting or reconnecting. */
  MAX_PROTOTYPE_CHANNEL_SEND_QUEUE,
  /** Channels open at once on one device. */
  MAX_PROTOTYPE_CHANNELS_OPEN,
  /** The window within which frames writing the same targets coalesce, latest wins. */
  PROTOTYPE_CHANNEL_FLUSH_MS,
  /** A connection that stays `open` this long resets the reconnect attempt counter. */
  PROTOTYPE_CHANNEL_RECONNECT_RESET_MS,
} = contract.limits;
