import { ANDROID_PACKAGE_NAME_PATTERN } from "../../../utils/androidPackageName";
import { shellQuote } from "../../../utils/shellQuote";

const POSTED_PREFIX = "posted:";
const CHANNEL_PREFIX = "channel:";

/** The channel the SDK posts to when the caller names none (`AutoMobileNotifications`). */
export const SDK_DEFAULT_NOTIFICATION_CHANNEL_ID = "automobile_test_notifications";

/**
 * Channel ids the journal can name and the reset port can pass to a shell broadcast. A caller
 * channel outside this set keeps the escalating app fallback instead of a channel row.
 */
const CHANNEL_ID_PATTERN = /^[A-Za-z0-9_.-]{1,200}$/;

const SDK_NOTIFICATION_RECEIVER =
  "dev.jasonpearson.automobile.sdk.notifications.AutoMobileNotificationReceiver";
const CHANNEL_QUERY_ACTION = "dev.jasonpearson.automobile.sdk.NOTIFICATION_CHANNEL_QUERY";
const CHANNEL_DELETE_ACTION = "dev.jasonpearson.automobile.sdk.NOTIFICATION_CHANNEL_DELETE";
const CHANNEL_ID_EXTRA = "channel_id";
/** Receiver result codes for both channel actions: the channel's state after the action ran. */
const CHANNEL_ABSENT_RESULT = 3;
const CHANNEL_PRESENT_RESULT = 4;

/**
 * Key of the `notification` row an Android `postNotification` journals: the app whose SDK
 * receiver posted it. Keep-booted reset reverts it by force-stopping that app, which makes the
 * system cancel every notification the app posted, then reads back that none remain.
 */
export function postedNotificationKey(appId: string): string | undefined {
  return ANDROID_PACKAGE_NAME_PATTERN.test(appId) ? `${POSTED_PREFIX}${appId}` : undefined;
}

/** The app a posted-notification key names, or undefined for any other key. */
export function postedNotificationAppId(key: string): string | undefined {
  if (!key.startsWith(POSTED_PREFIX)) {
    return undefined;
  }
  const appId = key.slice(POSTED_PREFIX.length);
  return ANDROID_PACKAGE_NAME_PATTERN.test(appId) ? appId : undefined;
}

export interface PostedNotificationChannel {
  appId: string;
  channelId: string;
}

/**
 * Key of the `notification` row naming the channel a `postNotification` creates in `appId`:
 * the caller's `channelId`, or the SDK default when it names none (an empty string is not sent).
 * Undefined when either cannot be named safely.
 */
export function postedNotificationChannelKey(
  appId: string,
  channelId: unknown,
): string | undefined {
  const channel =
    channelId === undefined || channelId === "" ? SDK_DEFAULT_NOTIFICATION_CHANNEL_ID : channelId;
  return ANDROID_PACKAGE_NAME_PATTERN.test(appId) &&
    typeof channel === "string" &&
    CHANNEL_ID_PATTERN.test(channel)
    ? `${CHANNEL_PREFIX}${appId}:${channel}`
    : undefined;
}

/** The app and channel a channel key names, or undefined for any other key. */
export function postedNotificationChannel(key: string): PostedNotificationChannel | undefined {
  if (!key.startsWith(CHANNEL_PREFIX)) {
    return undefined;
  }
  const rest = key.slice(CHANNEL_PREFIX.length);
  const separator = rest.indexOf(":");
  const appId = rest.slice(0, separator);
  const channelId = rest.slice(separator + 1);
  return separator > 0 &&
    ANDROID_PACKAGE_NAME_PATTERN.test(appId) &&
    CHANNEL_ID_PATTERN.test(channelId)
    ? { appId, channelId }
    : undefined;
}

/**
 * The adb command asking the app's SDK receiver about one channel: `query` reports whether it
 * exists, `delete` deletes it first. Both answer with the channel's state after the action as the
 * broadcast result code. The broadcast includes stopped packages because the posted-row revert
 * force-stops the same app.
 */
export function notificationChannelBroadcastCommand(
  { appId, channelId }: PostedNotificationChannel,
  action: "query" | "delete",
): string {
  return [
    "shell am broadcast --include-stopped-packages",
    `-n ${shellQuote(`${appId}/${SDK_NOTIFICATION_RECEIVER}`)}`,
    `-a ${action === "query" ? CHANNEL_QUERY_ACTION : CHANNEL_DELETE_ACTION}`,
    `--es ${CHANNEL_ID_EXTRA} ${shellQuote(channelId)}`,
  ].join(" ");
}

/**
 * The channel state an `am broadcast` answer reports, or undefined when it reports anything
 * else: an SDK without the channel actions leaves the result at 0, and a missing receiver,
 * an error line or a second result line is not an answer.
 */
export function notificationChannelBroadcastState(
  output: string,
): "present" | "absent" | undefined {
  const lines = output
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line !== "");
  const results = lines.filter((line) => line.startsWith("Broadcast completed:"));
  const others = lines.filter(
    (line) =>
      !line.startsWith("Broadcast completed:") && !line.startsWith("Broadcasting: Intent {"),
  );
  if (results.length !== 1 || others.length > 0) {
    return undefined;
  }
  const code = /^Broadcast completed: result=(-?\d+)$/.exec(results[0]!)?.[1];
  return code === String(CHANNEL_ABSENT_RESULT)
    ? "absent"
    : code === String(CHANNEL_PRESENT_RESULT)
      ? "present"
      : undefined;
}
