import { z } from "zod/v4";
import { ToolRegistry } from "./toolRegistry";
import { addDeviceTargetingToSchema, withAppIdAliases } from "./toolSchemaHelpers";
import { createJSONToolResponse } from "../utils/toolUtils";
import type { BootedDevice } from "../models";
import {
  AppPreferences,
  type GetPreferenceInput,
  type SetPreferenceInput,
} from "../features/preferences/AppPreferences";

const preferenceScopeSchema = z.enum(["systemProperty", "sharedPreferences", "userDefaults"]);
const preferenceValueTypeSchema = z.enum(["string", "bool", "int", "float"]);
const preferenceValueSchema = z.union([z.string(), z.boolean(), z.number()]);

// #6348: the advertised `additionalProperties: false` was not enforced at
// runtime — a plain z.object silently DROPPED undeclared keys. The concrete
// harm: `fileName` (the file selector on the sibling setKeyValue/removeKeyValue
// tools, but NOT here — this surface's selector is `suite`) was ignored,
// setPreference wrote the DEFAULT prefs file, and still reported verified:true.
// `.strict()` rejects unknown keys the way enum/type validation already does.
// `withAppIdAliases` runs its `z.preprocess` normalization (packageName -> appId,
// alias deleted) before this schema ever parses, so documented aliases still
// work under strict mode; `.extend()` (below and in addDeviceTargetingToSchema)
// preserves strict while widening the accepted key set.
const getPreferenceBaseSchema = z
  .object({
    scope: preferenceScopeSchema.describe("Preference scope"),
    appId: z.string().optional().describe("App package or bundle id"),
    suite: z
      .string()
      .regex(/^(?:\s*|[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)*)$/)
      .optional()
      .describe("SharedPreferences file name or UserDefaults suite/app group"),
    key: z.string().min(1).describe("Preference key or Android system property name"),
    userId: z
      .number()
      .int()
      .nonnegative()
      .optional()
      .describe(
        "Android sharedPreferences only: user whose copy of the app to read/write (e.g. a work profile). Defaults to user 0 when the app is installed for it; otherwise to the one other running user that has it (an error asks for userId if several do). The result reports the userId used.",
      ),
  })
  .strict();

const setPreferenceBaseSchema = getPreferenceBaseSchema.extend({
  value: preferenceValueSchema.describe("Value to write"),
  type: preferenceValueTypeSchema.describe("Value type for typed preference stores"),
});

export const getPreferenceSchema = withAppIdAliases(
  addDeviceTargetingToSchema(getPreferenceBaseSchema),
).superRefine(validatePreferenceArgs);

export const setPreferenceSchema = withAppIdAliases(
  addDeviceTargetingToSchema(setPreferenceBaseSchema),
).superRefine(validatePreferenceArgs);

export type GetPreferenceToolArgs = z.infer<typeof getPreferenceSchema>;
export type SetPreferenceToolArgs = z.infer<typeof setPreferenceSchema>;

export interface PreferenceToolsDependencies {
  appPreferencesFactory: (device: BootedDevice) => {
    getPreference(input: GetPreferenceInput): Promise<unknown>;
    setPreference(input: SetPreferenceInput): Promise<unknown>;
  };
}

let preferenceToolsDependencies: PreferenceToolsDependencies | null = null;

function getPreferenceToolsDependencies(): PreferenceToolsDependencies {
  if (!preferenceToolsDependencies) {
    preferenceToolsDependencies = {
      appPreferencesFactory: (device) => new AppPreferences(device),
    };
  }
  return preferenceToolsDependencies;
}

export function resetPreferenceToolsDependencies(): void {
  preferenceToolsDependencies = null;
}

export function registerPreferenceTools(): void {
  ToolRegistry.registerDeviceAware(
    "getPreference",
    "Read an Android system property, Android SharedPreferences key, or iOS UserDefaults key. On iOS, appId is required and the store selector is suite (not name or fileName as on setKeyValue); omit suite or use Standard for the default store. Uses an already connected embedded AutoMobile SDK with storage inspection enabled; never starts a runner. Reads can fall back to the simulator data container's on-disk plist, which may lag the running app. Writes use the container only when no SDK connection is open before sending; SDK write failures never trigger a second write. App-group suites require the connected SDK.",
    getPreferenceSchema,
    async (device: BootedDevice, args: GetPreferenceToolArgs) => {
      const result = await getPreferenceToolsDependencies()
        .appPreferencesFactory(device)
        .getPreference(args);
      return createJSONToolResponse(result);
    },
    {
      defaultEnabled: false,
      // Reads only; a non-holder watches a held device through the read-only path (#10830).
      deviceReadOnly: true,
    },
  );

  ToolRegistry.registerDeviceAware(
    "setPreference",
    "Write an Android system property, Android SharedPreferences key, or iOS UserDefaults key and return read-back verification. On iOS, appId is required and the store selector is suite (not name or fileName as on setKeyValue); omit suite or use Standard for the default store. Uses an already connected embedded AutoMobile SDK with storage inspection enabled; never starts a runner. Reads can fall back to the simulator data container's on-disk plist, which may lag the running app. Writes use the container only when no SDK connection is open before sending; SDK write failures never trigger a second write. App-group suites require the connected SDK.",
    setPreferenceSchema,
    async (device: BootedDevice, args: SetPreferenceToolArgs) => {
      const result = await getPreferenceToolsDependencies()
        .appPreferencesFactory(device)
        .setPreference(args);
      return createJSONToolResponse(result);
    },
    { defaultEnabled: false },
  );
}

function validatePreferenceArgs(
  args: z.infer<typeof getPreferenceBaseSchema> & { platform?: string },
  context: z.RefinementCtx,
): void {
  if ((args.scope === "sharedPreferences" || args.scope === "userDefaults") && !args.appId) {
    context.addIssue({
      code: "custom",
      path: ["appId"],
      message: `appId is required when scope is ${args.scope}`,
    });
  }

  if (args.platform === "ios" && args.scope !== "userDefaults") {
    context.addIssue({
      code: "custom",
      path: ["scope"],
      message: `${args.scope} is only supported on Android`,
    });
  }

  if (args.platform === "android" && args.scope === "userDefaults") {
    context.addIssue({
      code: "custom",
      path: ["scope"],
      message: "userDefaults is only supported on iOS",
    });
  }

  if (args.userId !== undefined && args.scope !== "sharedPreferences") {
    context.addIssue({
      code: "custom",
      path: ["userId"],
      message: "userId is only supported for Android sharedPreferences.",
    });
  }

  if (args.scope === "systemProperty" && args.appId) {
    context.addIssue({
      code: "custom",
      path: ["appId"],
      message: "appId is not used for Android systemProperty preferences.",
    });
  }
}
