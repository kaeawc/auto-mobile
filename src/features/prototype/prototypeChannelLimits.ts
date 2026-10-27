import contract from "../../../schemas/prototype-spec-contract.json";

/** Realtime contract budgets; transports and flushing are implemented in later runtime slices. */
export const {
  MAX_PROTOTYPE_CHANNELS,
  MAX_PROTOTYPE_CHANNEL_FRAME_BYTES,
  MAX_PROTOTYPE_CHANNEL_SEND_BYTES,
  MAX_PROTOTYPE_CHANNELS_OPEN,
  PROTOTYPE_CHANNEL_FLUSH_MS,
} = contract.limits;
