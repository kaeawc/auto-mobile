import contract from "../../../schemas/prototype-spec-contract.json";

/**
 * Notification contract limits (#14280), shared with the native validators and runtimes. The spec
 * contract's `notifications` call, state and channel-block rules repeat these values; a unit test
 * keeps them equal. Active count, total size, reply size and update coalescing are enforced on the
 * device once the runtime resolves a notification.
 */
export const {
  MAX_PROTOTYPE_NOTIFICATION_CHANNELS,
  MAX_PROTOTYPE_NOTIFICATION_ACTIONS,
  MAX_PROTOTYPE_NOTIFICATION_ID_LENGTH,
  MAX_PROTOTYPE_NOTIFICATION_TITLE_LENGTH,
  MAX_PROTOTYPE_NOTIFICATION_BODY_LENGTH,
  MAX_PROTOTYPE_NOTIFICATION_DATA_BYTES,
  MAX_PROTOTYPE_NOTIFICATION_REPLY_BYTES,
  MAX_PROTOTYPE_NOTIFICATION_BYTES,
  MAX_PROTOTYPE_NOTIFICATION_BADGE,
  MAX_PROTOTYPE_NOTIFICATIONS_ACTIVE,
  MAX_PROTOTYPE_NOTIFICATION_UPDATES_PER_SECOND,
} = contract.limits;
