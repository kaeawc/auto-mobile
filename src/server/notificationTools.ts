import { z } from "zod";
import { ToolRegistry } from "./toolRegistry";
import { ActionableError, BootedDevice, Platform } from "../models";
import { createJSONToolResponse } from "../utils/toolUtils";
import { addDeviceTargetingToSchema } from "./toolSchemaHelpers";
import { PostNotification, PostNotificationOptions } from "../features/utility/PostNotification";
import { NotificationPolicy } from "../features/utility/NotificationPolicy";

export interface PostNotificationArgs extends PostNotificationOptions {
  platform: Platform;
}

const iosAppIdRequiredMessage = "appId is required when platform is ios";

const actionSchema = z.object({
  label: z.string().min(1).describe("Action label"),
  actionId: z.string().min(1).describe("Action identifier")
});

const postNotificationCommonShape = {
  title: z.string().min(1).describe("Notification title"),
  body: z.string().min(1).describe("Notification body"),
  imageType: z.enum(["normal", "bigPicture"]).optional().describe("Notification image type (default: normal)"),
  imagePath: z.string().optional().describe("Host image file path to push to /sdcard/Download/automobile when imageType is bigPicture"),
  actions: z.array(actionSchema).optional().describe("Action buttons to include (Android only)"),
  channelId: z.string().optional().describe("Notification channel ID (Android); reused as the APNs category on iOS"),
};

export const postNotificationSchema = z.discriminatedUnion("platform", [
  addDeviceTargetingToSchema(z.object({
    ...postNotificationCommonShape,
    appId: z.string({ error: iosAppIdRequiredMessage })
      .min(1, iosAppIdRequiredMessage)
      .describe("iOS bundle identifier to target (required on iOS; maps to APNs 'Simulator Target Bundle'). Ignored on Android."),
    platform: z.literal("ios").describe("Target platform")
  })),
  addDeviceTargetingToSchema(z.object({
    ...postNotificationCommonShape,
    appId: z.string().min(1).optional().describe("iOS bundle identifier to target (required on iOS; maps to APNs 'Simulator Target Bundle'). Ignored on Android."),
    platform: z.literal("android").describe("Target platform")
  }))
]);

export const getNotificationPolicySchema = addDeviceTargetingToSchema(z.object({
  appId: z.string().min(1).describe("App package ID or bundle identifier"),
}));

export const setNotificationPolicySchema = addDeviceTargetingToSchema(z.object({
  appId: z.string().min(1).describe("App package ID or bundle identifier"),
  policyAccess: z.boolean().describe("Android only: allow or revoke app notification policy / DND access"),
}));

export type GetNotificationPolicyArgs = z.infer<typeof getNotificationPolicySchema>;

export type SetNotificationPolicyArgs = z.infer<typeof setNotificationPolicySchema>;

export function registerNotificationTools() {
  const postNotificationHandler = async (device: BootedDevice, args: PostNotificationArgs) => {
    try {
      const postNotification = new PostNotification(device);
      const result = await postNotification.execute({
        title: args.title,
        body: args.body,
        imageType: args.imageType,
        imagePath: args.imagePath,
        actions: args.actions,
        channelId: args.channelId,
        appId: args.appId
      });

      const message = result.success
        ? `Posted notification${result.method ? ` via ${result.method}` : ""}`
        : `Failed to post notification${result.error ? `: ${result.error}` : ""}`;

      return createJSONToolResponse({
        message,
        ...result
      });
    } catch (error) {
      throw new ActionableError(`Failed to post notification: ${error}`);
    }
  };

  const getNotificationPolicyHandler = async (device: BootedDevice, args: GetNotificationPolicyArgs) => {
    const notificationPolicy = new NotificationPolicy(device);
    const result = await notificationPolicy.getPolicy(args.appId);

    return createJSONToolResponse({
      message: result.success
        ? `Read notification policy for ${args.appId}`
        : result.error ?? `Failed to read notification policy for ${args.appId}`,
      ...result,
    });
  };

  const setNotificationPolicyHandler = async (device: BootedDevice, args: SetNotificationPolicyArgs) => {
    const notificationPolicy = new NotificationPolicy(device);
    const result = await notificationPolicy.setPolicy(args.appId, {
      policyAccess: args.policyAccess,
    });

    return createJSONToolResponse({
      message: result.success
        ? `${args.policyAccess ? "Allowed" : "Revoked"} notification policy access for ${args.appId}`
        : result.error ?? `Failed to set notification policy for ${args.appId}`,
      ...result,
    });
  };

  ToolRegistry.registerDeviceAware(
    "postNotification",
    "Post a notification: on Android, from the app-under-test when AutoMobile SDK hooks are installed; " +
    "on the iOS Simulator, deliver a simulated remote push to the given bundle id via 'simctl push' (requires appId; physical iOS devices unsupported).",
    postNotificationSchema,
    postNotificationHandler
  );

  ToolRegistry.registerDeviceAware(
    "getNotificationPolicy",
    "Read app notification policy state, including Android Do Not Disturb policy access",
    getNotificationPolicySchema,
    getNotificationPolicyHandler
  );

  ToolRegistry.registerDeviceAware(
    "setNotificationPolicy",
    "Set app notification policy state, including Android Do Not Disturb policy access",
    setNotificationPolicySchema,
    setNotificationPolicyHandler
  );
}
