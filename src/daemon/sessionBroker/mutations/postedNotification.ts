import { ANDROID_PACKAGE_NAME_PATTERN } from "../../../utils/androidPackageName";

const POSTED_PREFIX = "posted:";

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
