import { z } from "zod/v4";
import { ToolRegistry } from "./toolRegistry";
import { ActionableError, BootedDevice, Platform } from "../models";
import { createJSONToolResponse } from "../utils/toolUtils";
import { addDeviceTargetingToSchema, withAppIdAliases } from "./toolSchemaHelpers";
import { ANDROID_PACKAGE_NAME_PATTERN, PostNotification, PostNotificationOptions } from "../features/utility/PostNotification";
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
  imagePath: z.string().optional().describe("Host image path for bigPicture"),
  actions: z.array(actionSchema).optional().describe("Android action buttons"),
  channelId: z.string().optional().describe("Android channel ID / iOS APNs category"),
};

const postNotificationAppIdDescription =
  "Android target package name or iOS target bundle ID; Android defaults to the live foreground app when omitted";

export const postNotificationSchema = withAppIdAliases(z.discriminatedUnion("platform", [
  addDeviceTargetingToSchema(z.object({
    ...postNotificationCommonShape,
    appId: z.string({ error: iosAppIdRequiredMessage })
      .min(1, iosAppIdRequiredMessage)
      .describe(postNotificationAppIdDescription),
    platform: z.literal("ios")
  })),
  addDeviceTargetingToSchema(z.object({
    ...postNotificationCommonShape,
    appId: z.string()
      .min(1)
      .regex(ANDROID_PACKAGE_NAME_PATTERN, "appId must be an Android package name")
      .optional()
      .describe(postNotificationAppIdDescription),
    platform: z.literal("android")
  }))
]));

export const getNotificationPolicySchema = withAppIdAliases(addDeviceTargetingToSchema(z.object({
  appId: z.string().min(1),
})));

export const setNotificationPolicySchema = withAppIdAliases(addDeviceTargetingToSchema(z.object({
  appId: z.string().min(1),
  policyAccess: z.boolean().describe("Android: allow DND policy access"),
})));

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
    "Post notification via Android SDK hooks or iOS Simulator simctl push.",
    postNotificationSchema,
    postNotificationHandler
  );

  ToolRegistry.registerDeviceAware(
    "getNotificationPolicy",
    "Read app notification/DND policy state",
    getNotificationPolicySchema,
    getNotificationPolicyHandler
  );

  ToolRegistry.registerDeviceAware(
    "setNotificationPolicy",
    "Set app notification/DND policy state",
    setNotificationPolicySchema,
    setNotificationPolicyHandler
  );
}
