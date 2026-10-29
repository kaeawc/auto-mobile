import { z } from "zod/v4";
import { APP_TRIM_MEMORY_LEVELS } from "../models/AppLifecycleResult";
import {
  addDeviceTargetingToSchema,
  responseShapeControlFields,
  withAppIdAliases,
  withJsonSchemaOverride,
} from "../utils/schemaHelpers";
import { SIGNING_SHA256_PATTERN } from "../utils/signingIdentity";
import { installAppResultSchema, listAppsResultSchema } from "./appToolOutputSchemas";
import { defineDeviceTool } from "./defineTool";

// Schema definitions
// #6613: these app schemas advertised `additionalProperties: false` but were
// not `.strict()`, so an undeclared caller argument (e.g. `installApp{userId}`,
// which this tool does not support) was silently dropped and the call ran
// against the auto-detected user instead of failing. `withAppIdAliases` runs its
// `z.preprocess` alias normalization before these schemas parse, so documented
// aliases still work under strict mode (same precedent as launchApp).
export const packageNameSchema = withAppIdAliases(
  addDeviceTargetingToSchema(
    z
      .object({
        appId: z.string(),
      })
      .strict(),
  ),
);

// terminateApp embeds a post-action observation, so it carries the same
// response-shape control as the other action tools (issue #5886): the embedded
// observation defaults to the compact skeleton, opt-out-able via raw/project.
export const terminateAppSchema = withAppIdAliases(
  addDeviceTargetingToSchema(
    z
      .object({
        appId: z.string(),
        ...responseShapeControlFields,
      })
      .strict(),
  ),
);

export const crashAppSchema = withAppIdAliases(
  addDeviceTargetingToSchema(
    z
      .object({
        appId: z.string().trim().min(1),
      })
      .strict(),
  ),
);

export const appLifecycleSchema = withAppIdAliases(
  addDeviceTargetingToSchema(
    z
      .object({
        appId: z.string().trim().min(1),
        action: z.enum(["background", "killBackgrounded", "trimMemory"]),
        level: z
          .enum(APP_TRIM_MEMORY_LEVELS)
          .optional()
          .describe("onTrimMemory level to send; required for trimMemory, rejected otherwise"),
      })
      .strict(),
  ),
);

const intentExtraKey = z.string().min(1).describe("Extra key");

/** Typed `am start` extras; shared with sendBroadcast (#14081). */
export const androidIntentExtraSchema = z.discriminatedUnion("type", [
  z.object({ key: intentExtraKey, type: z.literal("string"), value: z.string() }).strict(),
  z
    .object({ key: intentExtraKey, type: z.enum(["int", "long", "float"]), value: z.number() })
    .strict(),
  z.object({ key: intentExtraKey, type: z.literal("boolean"), value: z.boolean() }).strict(),
  z
    .object({ key: intentExtraKey, type: z.literal("stringArray"), value: z.array(z.string()) })
    .strict(),
  z.object({ key: intentExtraKey, type: z.literal("uri"), value: z.string().min(1) }).strict(),
]);

/** Android launch intent (#14080); every value is shell-quoted, never passed as raw command text. */
export const androidIntentSchema = z
  .object({
    component: z
      .string()
      .min(1)
      .optional()
      .describe(
        'Activity of the launched app: ".DebugActivity", a fully qualified class, or "<appId>/<class>". Omitted: Android resolves action/data within the app (one of them is required). Other packages are refused',
      ),
    action: z.string().min(1).optional().describe("Intent action, e.g. android.intent.action.VIEW"),
    data: z.string().min(1).optional().describe("Data URI"),
    mimeType: z.string().min(1).optional(),
    categories: z.array(z.string().min(1)).optional(),
    extras: z.array(androidIntentExtraSchema).optional(),
    flags: z
      .array(z.enum(["clearTask", "newTask", "singleTop", "clearTop", "noHistory"]))
      .optional(),
  })
  .strict();

export const launchAppSchema = withAppIdAliases(
  addDeviceTargetingToSchema(
    z
      .object({
        appId: z.string(),
        clearAppData: z
          .boolean()
          .optional()
          .describe("Clear app data before launch (default false)"),
        coldBoot: z.boolean().optional().describe("Cold boot app (default false)"),
        launchArguments: z
          .array(z.string())
          .optional()
          .describe("Arguments passed to the launched iOS app. On Android use intent instead."),
        intent: androidIntentSchema
          .optional()
          .describe(
            "Android only: start the app with this intent (component, action, data, categories, typed extras, flags) instead of the launcher intent. Always launches, even when the app is in front; am start refusals are typed (activity_not_exported, activity_not_found, intent_unresolved).",
          ),
        prototype: z
          .boolean()
          .optional()
          .describe(
            "iOS simulator only: inject the prototype agent so the prototype tool can draw over this " +
              "app. Always relaunches the app, losing its state. Rejected on physical iOS devices " +
              "(use the in-app SDK), on Android (prototypes need no injection) and for com.apple.* apps.",
          ),
        ...responseShapeControlFields,
      })
      // #6154: the advertised `additionalProperties: false` was not actually
      // enforced at runtime — `.strict()` closes that gap. `withAppIdAliases`
      // runs its `z.preprocess` normalization (packageName -> appId, alias
      // deleted) before this schema ever parses, so the documented alias still
      // works under strict mode.
      .strict(),
  ),
);

const expectedSigningSha256Schema = z
  .array(
    z
      .string()
      .regex(
        SIGNING_SHA256_PATTERN,
        "Expected a SHA-256 digest: 64 hex characters, optionally colon-separated",
      ),
  )
  .min(1)
  .max(16);

const bundleKeystoreSchema = z
  .object({
    path: z.string().min(1).describe("Keystore file path"),
    alias: z.string().min(1).describe("Key alias"),
    storePassword: z.string().min(1).describe("Keystore password (redacted from logs)"),
    keyPassword: z
      .string()
      .min(1)
      .optional()
      .describe("Key password (redacted from logs; default storePassword)"),
  })
  .strict();

const installBundleSchema = z
  .object({
    keystore: bundleKeystoreSchema
      .optional()
      .describe(".aab: signing key for the built APKs (default ~/.android/debug.keystore)"),
    modules: z
      .array(z.string().min(1))
      .min(1)
      .optional()
      .describe("Dynamic feature modules to install, or ['_ALL_']"),
    localTesting: z
      .boolean()
      .optional()
      .describe(".aab: build with bundletool --local-testing for on-demand modules"),
  })
  .strict();

/**
 * installApp, uninstallApp and listApps accept an Apple Watch simulator (#14908), so their
 * `platform` names "watchos" too. Every other tool keeps the shared Android/iOS enum.
 */
const watchAwarePlatformSchema = () =>
  z
    .enum(["android", "ios", "watchos"])
    .optional()
    .describe('Device platform; "watchos" must be named to target an Apple Watch simulator');

const installAppInput = z.object({
  platform: watchAwarePlatformSchema(),
  artifactPath: z
    .string()
    .describe(
      "Android: .apk, .apks, .aab (needs bundletool), or a directory of split APKs; iOS: .app or .ipa; watchOS: .app",
    ),
  splits: z
    .array(z.string().min(1))
    .min(1)
    .optional()
    .describe("Android: split APKs installed with the base .apk artifactPath (install-multiple)"),
  bundle: installBundleSchema.optional().describe("Android .aab/.apks options"),
  grantAllPermissions: z
    .boolean()
    .optional()
    .describe("Android: grant all requested runtime permissions (install -g)"),
  allowDowngrade: z
    .boolean()
    .optional()
    .describe("Android: allow a lower versionCode (install -d; debuggable apps only)"),
  expectedSigningSha256: expectedSigningSha256Schema
    .optional()
    .describe(
      "Android: complete signer set (SHA-256 of every signing certificate) an already " +
        "installed copy must have before it is replaced; any other signer set, or signers " +
        "that cannot be read, refuses the install. See inspectPackageSigning.",
    ),
  allowDestructiveRecovery: z
    .boolean()
    .optional()
    .describe(
      "Android: false refuses the uninstall-and-reinstall recovery after " +
        "INSTALL_FAILED_VERSION_DOWNGRADE (default true)",
    ),
});

export const installAppTool = defineDeviceTool({
  name: "installApp",
  description: "Install app on device (.apk, split APKs, .apks, .aab, .app, or .ipa)",
  input: installAppInput,
  options: {
    defaultEnabled: true,
    // Installation is a platform package-manager operation. Requiring
    // accessibility automation here creates a dependency cycle on iOS:
    // a freshly erased/booted simulator cannot install the app because its
    // CtrlProxy runner is still starting, even though simctl install itself
    // does not use CtrlProxy.
    deviceReadiness: "booted",
    replacesProcess: true,
    outputSchema: installAppResultSchema,
  },
});

export const installAppSchema = installAppTool.schema;

export const uninstallAppSchema = withAppIdAliases(
  addDeviceTargetingToSchema(
    z
      .object({
        appId: z.string(),
        platform: watchAwarePlatformSchema(),
        keepData: z
          .boolean()
          .optional()
          .describe(
            "Keep app data after uninstall (Android only, default false; refused on watchOS)",
          ),
        expectedSigningSha256: expectedSigningSha256Schema
          .optional()
          .describe(
            "Android: complete signer set (SHA-256 of every signing certificate) the installed " +
              "package must have; a different signer set, absence, or signers that cannot be " +
              "read refuses the uninstall, and removal is confirmed by a fresh presence read.",
          ),
      })
      .strict(),
  ),
);

const appPermissionActionSchema = z.enum(["grant", "revoke", "reset"]);

export const setAppPermissionsSchema = withJsonSchemaOverride(
  withAppIdAliases(
    addDeviceTargetingToSchema(
      z
        .object({
          appId: z.string().trim().min(1),
          action: appPermissionActionSchema
            .optional()
            .describe(
              "Action (default grant). Android reset requires permissions=['all'] device-wide; " +
                "iOS physical devices support reset only.",
            ),
          permissions: z
            .array(z.string().min(1))
            .optional()
            .describe("Permissions; Android reset accepts only 'all'; physical iOS accepts it too"),
          userId: z
            .number()
            .int()
            .nonnegative()
            .optional()
            .describe("Android user ID for grant/revoke, not reset"),
          notificationsEnabled: z
            .boolean()
            .optional()
            .describe(
              "Android notification state: POST_NOTIFICATIONS permission on API 33+; POST_NOTIFICATION appop before API 33",
            ),
          notificationPolicyAccess: z
            .boolean()
            .optional()
            .describe("Android: set DND policy access"),
          scheduleExactAlarm: z
            .enum(["allow", "deny"])
            .optional()
            .describe("Android: set SCHEDULE_EXACT_ALARM appop"),
        })
        .strict(),
    ),
  )
    .refine(
      (args) =>
        (args.permissions !== undefined && args.permissions.length > 0) ||
        args.notificationsEnabled !== undefined ||
        args.notificationPolicyAccess !== undefined ||
        args.scheduleExactAlarm !== undefined,
      "Provide at least one permission or platform-specific permission option",
    )
    .refine(
      (args) => args.action !== "reset" || args.userId === undefined,
      "Android reset is device-wide and does not support userId",
    )
    .refine(
      (args) =>
        args.action !== "reset" ||
        args.permissions?.some((permission) => permission.trim().length > 0) === true,
      "Reset requires permissions",
    )
    .refine(
      (args) =>
        args.action !== "reset" ||
        args.platform !== "android" ||
        (args.permissions?.length === 1 && args.permissions[0] === "all"),
      "Android reset requires permissions=['all']",
    ),
  (jsonSchema) => {
    const properties = jsonSchema.properties as Record<string, Record<string, unknown>>;
    delete properties.appId?.minLength;
    delete properties.action?.type;
    delete properties.scheduleExactAlarm?.type;
    for (const name of [
      "action",
      "permissions",
      "userId",
      "notificationsEnabled",
      "notificationPolicyAccess",
      "scheduleExactAlarm",
      "sessionUuid",
      "device",
    ]) {
      delete properties[name]?.description;
    }
  },
);

export const getAppPermissionsSchema = withAppIdAliases(
  addDeviceTargetingToSchema(
    z
      .object({
        appId: z.string(),
        permissions: z
          .array(z.string().min(1))
          .optional()
          .describe("Optional permissions or simulator privacy services to query"),
      })
      .strict(),
  ),
);

export const inspectPackageSigningSchema = withAppIdAliases(
  addDeviceTargetingToSchema(
    z
      .object({
        appId: z.string(),
        userId: z
          .number()
          .int()
          .nonnegative()
          .optional()
          .describe(
            "Android user/profile to inspect; when omitted it is resolved and reported. Refused on iOS",
          ),
      })
      .strict(),
  ),
);

export const resetKeychainSchema = withAppIdAliases(
  addDeviceTargetingToSchema(
    z
      .object({
        appId: z
          .string()
          .trim()
          .min(1)
          .describe(
            "Required. The app whose Keychain/Keystore state to reset. NOTE: iOS Simulator only supports a device-wide reset and erases EVERY app's Keychain regardless of this value.",
          ),
        confirm: z
          .boolean()
          .describe(
            "Required. Must be true to proceed. On iOS Simulator this erases the Keychain for EVERY app on the target simulator, not just appId.",
          ),
      })
      .strict(),
  ),
);

// #6613: `listApps` advertises `additionalProperties: false` in tools/list, so
// its runtime schema must reject undeclared arguments too. Without `.strict()`
// a call such as `listApps({ appId: "com.example" })` had the unsupported
// filter silently dropped and returned the full unfiltered listing.
const listAppsInput = z.object({
  platform: watchAwarePlatformSchema(),
  type: z
    .enum(["launchable", "user", "system", "all"])
    .optional()
    .describe(
      "Filter by app type. Defaults to 'launchable': every app with a launcher entry point, " +
        "user-installed or preinstalled, so the apps a human names (Contacts, Clock, Settings) " +
        "are visible while content providers and RRO overlays are not. 'user' and 'system' " +
        "keep their meaning and must be asked for explicitly; 'all' returns every installed " +
        "package. The default degrades to 'user' when the device reports no launchability " +
        "signal, and an explicit 'launchable' is then rejected rather than silently empty. " +
        "On a physical iOS device, where user/system classification is unavailable (devicectl " +
        "reports no such signal), an omitted type returns every app (reported as 'all') and an " +
        "explicit 'user' or 'system' filter is rejected rather than silently honored.",
    ),
  search: z
    .string()
    .optional()
    .describe(
      "Filter by a case-insensitive substring of the package name/bundle id or of the app's " +
        "display label ('contacts' matches both com.android.contacts and an app labelled " +
        "Contacts). Android labels require the installed CtrlProxy APK; without it only the " +
        "package name is matched.",
    ),
  profile: z
    .number()
    .int()
    .min(0)
    .optional()
    .describe("Filter to apps visible to this user profile id."),
});

export const listAppsTool = defineDeviceTool({
  name: "listApps",
  description:
    "List installed apps on a device, with optional display label and launchable fields when " +
    "reported by the platform or transport. The label is typically omitted on Android when " +
    "the installed CtrlProxy APK lacks label support; launchable is typically omitted for " +
    "physical iOS/devicectl records. Filters by type (default: launchable — every app with a launcher entry point, " +
    "preinstalled ones included), search (package name or label), and profile.",
  input: listAppsInput,
  options: {
    defaultEnabled: true,
    // Listing installed apps only needs adb/simctl/devicectl — never CtrlProxy
    // automation — so it should not pay for (or trigger) automation-readiness
    // setup on the target device (#6216 review).
    deviceReadiness: "booted",
    // Reads only; a non-holder watches a held device through the read-only path (#10830).
    deviceReadOnly: true,
    outputSchema: listAppsResultSchema,
  },
});

export const listAppsSchema = listAppsTool.schema;

export type ListAppsArgs = z.output<typeof listAppsTool.schema>;
export type InstallAppArgs = z.output<typeof installAppTool.schema>;

// Export interfaces for type safety
export type AppActionArgs = z.output<typeof terminateAppSchema>;

export type CrashAppActionArgs = z.output<typeof crashAppSchema>;

export type LaunchAppActionArgs = z.output<typeof launchAppSchema>;

export type UninstallAppArgs = z.output<typeof uninstallAppSchema>;

export type SetAppPermissionsArgs = z.infer<typeof setAppPermissionsSchema>;

export type InspectPackageSigningArgs = z.infer<typeof inspectPackageSigningSchema>;

export type GetAppPermissionsArgs = z.infer<typeof getAppPermissionsSchema>;

export type ResetKeychainArgs = z.infer<typeof resetKeychainSchema>;
