/** Android Auto's package on a phone image (the preinstalled stub and the sideloaded release). */
export const ANDROID_AUTO_PACKAGE = "com.google.android.projection.gearhead";

/** Android Auto's settings entry point; opens the screen whose **Version** row unlocks developer mode. */
export const ANDROID_AUTO_SETTINGS_ACTION = "com.android.settings.action.IA_SETTINGS";

/** Port the head unit server listens on, on the phone, and the DHU dials on the host. */
export const HEAD_UNIT_SERVER_PORT = 5277;

/** Android Auto's notification listener; the head unit asks for it before showing the launcher. */
export const ANDROID_AUTO_NOTIFICATION_LISTENER =
  "com.google.android.projection.gearhead/com.google.android.gearhead.notifications.SharedNotificationListenerManager$ListenerService";

/** DHU console command that gives the headless head unit video focus; `screenshot` fails without it. */
export const DHU_FOCUS_VIDEO_COMMAND = "focus video";

/** Line a `--headless` DHU prints instead of writing a `screenshot` while it has no video focus. */
export const DHU_NO_VIDEO_FOCUS_MARKER = "Don't have video focus";

/** Line the DHU prints once its transport reaches the phone (it prints it even when the server is down). */
export const DHU_CONNECTED_MARKER = "connected.";

/** Line the DHU repeats when the projection stalls after connecting. */
export const DHU_PING_TIMEOUT_MARKER = "Ping timeout";
