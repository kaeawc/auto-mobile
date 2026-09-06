import { z } from "zod/v4";
import { ToolRegistry } from "./toolRegistry";
import { ActionableError, BootedDevice, Platform } from "../models";
import { createJSONToolResponse } from "../utils/toolUtils";
import {
  addDeviceTargetingToSchema,
  platformSchema,
  withAppIdAliases,
  withJsonSchemaOverride,
} from "./toolSchemaHelpers";
import {
  ANDROID_PACKAGE_NAME_PATTERN,
  PostNotification,
  PostNotificationOptions,
} from "../features/utility/PostNotification";
import { NotificationPolicy } from "../features/utility/NotificationPolicy";

export interface PostNotificationArgs extends PostNotificationOptions {
  // #6154: optional — resolved from deviceId/session when omitted.
  platform?: Platform;
}

const iosAppIdRequiredMessage = "appId is required when platform is ios";

const actionSchema = z.object({
  label: z.string().min(1).describe("Action label"),
  actionId: z.string().min(1).describe("Action identifier"),
});

const postNotificationCommonShape = {
  title: z.string().min(1).describe("Notification title"),
  body: z.string().min(1).describe("Notification body"),
  imageType: z
    .enum(["normal", "bigPicture"])
    .optional()
    .describe("Notification image type (default: normal)"),
  imagePath: z.string().optional().describe("Host image path for bigPicture"),
  actions: z.array(actionSchema).optional().describe("Android action buttons"),
  channelId: z.string().optional().describe("Android channel ID / iOS APNs category"),
};

const postNotificationAppIdDescription =
  "Android target package name or iOS target bundle ID; Android defaults to the live foreground app when omitted";

const androidAppIdInvalidMessage = "appId must be an Android package name";

/**
 * #6154 follow-up: `postNotification` used a `z.discriminatedUnion("platform", ...)`,
 * which requires the discriminator field to be present to pick a branch — so
 * `platform` could not be made optional (resolved from deviceId/session) without
 * restructuring away from the union. These per-platform appId rules (iOS requires
 * it, Android's must look like a package name) now run through this single
 * checker: from the schema's `superRefine` when the caller provided an explicit
 * `platform` (fast, parse-time feedback), and from `postNotificationHandler`
 * against the resolved `device.platform` when the caller omitted it — mirroring
 * the pattern used for `changeLocalization`/`observe`.
 */
export function checkPostNotificationPlatformConstraints(
  platform: Platform | undefined,
  args: Pick<PostNotificationArgs, "appId">,
): { path: "appId"; message: string } | null {
  if (platform === "ios" && !args.appId) {
    return { path: "appId", message: iosAppIdRequiredMessage };
  }
  if (platform === "android" && args.appId && !ANDROID_PACKAGE_NAME_PATTERN.test(args.appId)) {
    return { path: "appId", message: androidAppIdInvalidMessage };
  }
  return null;
}

export const postNotificationSchema = withAppIdAliases(
  withJsonSchemaOverride(
    addDeviceTargetingToSchema(
      z.object({
        ...postNotificationCommonShape,
        appId: z.string().min(1).optional().describe(postNotificationAppIdDescription),
        // #5870/#6154: a `sessionUuid`/`deviceId` resolves the platform, so
        // `platform` is not required — a device handle from getAndroid/getApple
        // is sufficient on its own. The per-platform appId rules below only
        // fire when the caller provided an explicit `platform`; the omitted
        // case is enforced post-resolution in postNotificationHandler.
        platform: platformSchema.optional(),
      }),
    ).superRefine((values, ctx) => {
      const violation = checkPostNotificationPlatformConstraints(values.platform, values);
      if (violation) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: [violation.path],
          message: violation.message,
        });
      }
    }),
    (jsonSchema) => {
      jsonSchema.if = {
        properties: { platform: { const: "ios" } },
        required: ["platform"],
      };
      jsonSchema.then = { required: ["appId"] };
    },
  ),
);

export const getNotificationPolicySchema = withAppIdAliases(
  addDeviceTargetingToSchema(
    z.object({
      appId: z.string().min(1),
    }),
  ),
);

export const setNotificationPolicySchema = withAppIdAliases(
  addDeviceTargetingToSchema(
    z.object({
      appId: z.string().min(1),
      policyAccess: z.boolean().describe("Android: allow DND policy access"),
    }),
  ),
);

export type GetNotificationPolicyArgs = z.infer<typeof getNotificationPolicySchema>;

export type SetNotificationPolicyArgs = z.infer<typeof setNotificationPolicySchema>;

export function registerNotificationTools() {
  const postNotificationHandler = async (device: BootedDevice, args: PostNotificationArgs) => {
    // #6154 follow-up: `platform` is optional on the wire, so the schema's
    // per-platform appId checks (raw request platform) are skipped entirely
    // when the caller omitted it. Re-validate against the resolved
    // `device.platform`, before the try/catch below so the actionable message
    // isn't re-wrapped as a generic execution failure.
    const violation = checkPostNotificationPlatformConstraints(device.platform, args);
    if (violation) {
      throw new ActionableError(violation.message);
    }

    try {
      const postNotification = new PostNotification(device);
      const result = await postNotification.execute({
        title: args.title,
        body: args.body,
        imageType: args.imageType,
        imagePath: args.imagePath,
        actions: args.actions,
        channelId: args.channelId,
        appId: args.appId,
      });

      const message = result.success
        ? `Posted notification${result.method ? ` via ${result.method}` : ""}`
        : `Failed to post notification${result.error ? `: ${result.error}` : ""}`;

      const response = createJSONToolResponse({
        message,
        ...result,
      });
      // A receiver-reported failure means the notification was never delivered
      // — the primary operation did not succeed, so the MCP envelope must say
      // so too, exactly as tapOn/inputText do (#6200, #6251).
      return result.success ? response : { ...response, isError: true as const };
    } catch (error) {
      throw new ActionableError(`Failed to post notification: ${error}`);
    }
  };

  const getNotificationPolicyHandler = async (
    device: BootedDevice,
    args: GetNotificationPolicyArgs,
  ) => {
    const notificationPolicy = new NotificationPolicy(device);
    const result = await notificationPolicy.getPolicy(args.appId);

    return createJSONToolResponse({
      message: result.success
        ? `Read notification policy for ${args.appId}`
        : (result.error ?? `Failed to read notification policy for ${args.appId}`),
      ...result,
    });
  };

  const setNotificationPolicyHandler = async (
    device: BootedDevice,
    args: SetNotificationPolicyArgs,
  ) => {
    const notificationPolicy = new NotificationPolicy(device);
    const result = await notificationPolicy.setPolicy(args.appId, {
      policyAccess: args.policyAccess,
    });

    return createJSONToolResponse({
      message: result.success
        ? `${args.policyAccess ? "Allowed" : "Revoked"} notification policy access for ${args.appId}`
        : (result.error ?? `Failed to set notification policy for ${args.appId}`),
      ...result,
    });
  };

  ToolRegistry.registerDeviceAware(
    "postNotification",
    "Post notification via Android SDK hooks or iOS Simulator simctl push.",
    postNotificationSchema,
    postNotificationHandler,
    { defaultEnabled: false },
  );

  ToolRegistry.registerDeviceAware(
    "getNotificationPolicy",
    "Read app notification/DND policy state",
    getNotificationPolicySchema,
    getNotificationPolicyHandler,
    { defaultEnabled: false },
  );

  ToolRegistry.registerDeviceAware(
    "setNotificationPolicy",
    "Set app notification/DND policy state",
    setNotificationPolicySchema,
    setNotificationPolicyHandler,
    { defaultEnabled: false },
  );
}
