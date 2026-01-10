/**
 * Result of a postNotification action.
 */
export interface PostNotificationResult {
  success: boolean;
  supported: boolean;
  method?: "sdk";
  style?: "default" | "bigText" | "bigPicture";
  appId?: string;
  channelId?: string;
  warning?: string;
  error?: string;
}
