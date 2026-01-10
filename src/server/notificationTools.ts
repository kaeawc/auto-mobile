import { z } from "zod";
import { ToolRegistry } from "./toolRegistry";
import { ActionableError, BootedDevice, Platform } from "../models";
import { createJSONToolResponse } from "../utils/toolUtils";
import { addDeviceTargetingToSchema } from "./toolSchemaHelpers";
import { PostNotification, PostNotificationOptions } from "../features/utility/PostNotification";

export interface PostNotificationArgs extends PostNotificationOptions {
  platform: Platform;
}

const actionSchema = z.object({
  label: z.string().min(1).describe("Action label"),
  actionId: z.string().min(1).describe("Action identifier")
});

export const postNotificationSchema = addDeviceTargetingToSchema(
  z.object({
    title: z.string().min(1).describe("Notification title"),
    body: z.string().min(1).describe("Notification body"),
    style: z.enum(["default", "bigText", "bigPicture"]).optional().describe("Notification style"),
    imagePath: z.string().optional().describe("Host image file path to push to /sdcard/Download/automobile (bigPicture only)"),
    actions: z.array(actionSchema).optional().describe("Action buttons to include"),
    channelId: z.string().optional().describe("Notification channel ID (Android only)"),
    platform: z.enum(["android", "ios"]).describe("Platform")
  }).superRefine((value, ctx) => {
    if (value.style === "bigPicture" && !value.imagePath) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "imagePath is required when style is bigPicture"
      });
    }
  })
);

export function registerNotificationTools() {
  const postNotificationHandler = async (device: BootedDevice, args: PostNotificationArgs) => {
    try {
      const postNotification = new PostNotification(device);
      const result = await postNotification.execute({
        title: args.title,
        body: args.body,
        style: args.style,
        imagePath: args.imagePath,
        actions: args.actions,
        channelId: args.channelId
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

  ToolRegistry.registerDeviceAware(
    "postNotification",
    "Post a notification from the app-under-test when AutoMobile SDK hooks are installed.",
    postNotificationSchema,
    postNotificationHandler
  );
}
