/**
 * Wire messages for host-proxied prototype channels (`channels` with `via: "host"`, #14268).
 * The device opens a connection by its own `connectionId` and the host relays frames both ways.
 * These are transport relay messages, not prototype events: what a spec or `awaitEvent` sees
 * stays on `prototype_platform_event`. Not in the Kotlin-mirrored wire manifest.
 */
import { z } from "zod";
import { PROTOTYPE_REQUEST_ERROR_CODES } from "./prototypeRequestProtocol";

export const PROTOTYPE_CHANNEL_OPEN_MESSAGE_TYPE = "prototype_channel_open";
export const PROTOTYPE_CHANNEL_SEND_MESSAGE_TYPE = "prototype_channel_send";
export const PROTOTYPE_CHANNEL_CLOSE_MESSAGE_TYPE = "prototype_channel_close";
export const PROTOTYPE_CHANNEL_OPENED_MESSAGE_TYPE = "prototype_channel_opened";
export const PROTOTYPE_CHANNEL_FRAME_MESSAGE_TYPE = "prototype_channel_frame";
export const PROTOTYPE_CHANNEL_CLOSED_MESSAGE_TYPE = "prototype_channel_closed";

export const PROTOTYPE_CHANNEL_KINDS = ["websocket", "sse"] as const;
export type PrototypeChannelKind = (typeof PROTOTYPE_CHANNEL_KINDS)[number];

/** The request codes plus the handshake refusal, which carries the HTTP status when there is one. */
export const PROTOTYPE_CHANNEL_ERROR_CODES = [
  ...PROTOTYPE_REQUEST_ERROR_CODES,
  "handshake_failed",
] as const;
export type PrototypeChannelErrorCode = (typeof PROTOTYPE_CHANNEL_ERROR_CODES)[number];

const channelErrorSchema = z.object({
  code: z.enum(PROTOTYPE_CHANNEL_ERROR_CODES),
  message: z.string(),
  status: z.number().int().optional(),
});
export type PrototypeChannelError = z.infer<typeof channelErrorSchema>;

export const prototypeChannelOpenMessageSchema = z.object({
  type: z.literal(PROTOTYPE_CHANNEL_OPEN_MESSAGE_TYPE),
  connectionId: z.string().min(1),
  /** The prototype that owns the channel; dismissing it closes the connection. */
  prototypeId: z.string().min(1),
  channel: z.string().min(1),
  kind: z.enum(PROTOTYPE_CHANNEL_KINDS),
  url: z.string(),
  protocols: z.array(z.string()).optional(),
  headers: z.record(z.string()).optional(),
  /** SSE only: sent as `Last-Event-ID` when the device reconnects. */
  lastEventId: z.string().optional(),
});

export const prototypeChannelSendMessageSchema = z.object({
  type: z.literal(PROTOTYPE_CHANNEL_SEND_MESSAGE_TYPE),
  connectionId: z.string().min(1),
  data: z.string(),
});

export const prototypeChannelCloseMessageSchema = z.object({
  type: z.literal(PROTOTYPE_CHANNEL_CLOSE_MESSAGE_TYPE),
  connectionId: z.string().min(1),
  code: z.number().int().optional(),
  reason: z.string().optional(),
});

export const prototypeChannelOpenedMessageSchema = z.object({
  type: z.literal(PROTOTYPE_CHANNEL_OPENED_MESSAGE_TYPE),
  connectionId: z.string(),
  protocol: z.string().optional(),
});

export const prototypeChannelFrameMessageSchema = z.object({
  type: z.literal(PROTOTYPE_CHANNEL_FRAME_MESSAGE_TYPE),
  connectionId: z.string(),
  data: z.string(),
  /** SSE event name and id. */
  event: z.string().optional(),
  id: z.string().optional(),
});

export const prototypeChannelClosedMessageSchema = z.object({
  type: z.literal(PROTOTYPE_CHANNEL_CLOSED_MESSAGE_TYPE),
  connectionId: z.string(),
  code: z.number().int().optional(),
  reason: z.string().optional(),
  error: channelErrorSchema.optional(),
});

export type PrototypeChannelOutboundMessage =
  | z.infer<typeof prototypeChannelOpenedMessageSchema>
  | z.infer<typeof prototypeChannelFrameMessageSchema>
  | z.infer<typeof prototypeChannelClosedMessageSchema>;
