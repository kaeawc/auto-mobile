import { z } from "zod/v4";
import { ToolRegistry } from "./toolRegistry";
import { addDeviceTargetingToSchema, withAppIdAliases } from "./toolSchemaHelpers";
import { createJSONToolResponse } from "../utils/toolUtils";
import type { BootedDevice } from "../models";
import {
  AppPreferences,
  type GetPreferenceInput,
  type SetPreferenceInput
} from "../features/preferences/AppPreferences";

const preferenceScopeSchema = z.enum(["systemProperty", "sharedPreferences", "userDefaults"]);
const preferenceValueTypeSchema = z.enum(["string", "bool", "int", "float"]);
const preferenceValueSchema = z.union([z.string(), z.boolean(), z.number()]);

const getPreferenceBaseSchema = z.object({
  scope: preferenceScopeSchema.describe("Preference scope"),
  appId: z.string().optional().describe("App package or bundle id"),
  suite: z.string().optional().describe("SharedPreferences file name or UserDefaults suite/app group"),
  key: z.string().min(1).describe("Preference key or Android system property name"),
});

const setPreferenceBaseSchema = getPreferenceBaseSchema.extend({
  value: preferenceValueSchema.describe("Value to write"),
  type: preferenceValueTypeSchema.describe("Value type for typed preference stores"),
});

export const getPreferenceSchema = withAppIdAliases(
  addDeviceTargetingToSchema(getPreferenceBaseSchema)
).superRefine(validatePreferenceArgs);

export const setPreferenceSchema = withAppIdAliases(
  addDeviceTargetingToSchema(setPreferenceBaseSchema)
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
      appPreferencesFactory: device => new AppPreferences(device),
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
    "Read an Android system property, Android SharedPreferences key, or iOS UserDefaults key.",
    getPreferenceSchema,
    async (device: BootedDevice, args: GetPreferenceToolArgs) => {
      const result = await getPreferenceToolsDependencies()
        .appPreferencesFactory(device)
        .getPreference(args);
      return createJSONToolResponse(result);
    }
  );

  ToolRegistry.registerDeviceAware(
    "setPreference",
    "Write an Android system property, Android SharedPreferences key, or iOS UserDefaults key and return read-back verification.",
    setPreferenceSchema,
    async (device: BootedDevice, args: SetPreferenceToolArgs) => {
      const result = await getPreferenceToolsDependencies()
        .appPreferencesFactory(device)
        .setPreference(args);
      return createJSONToolResponse(result);
    }
  );
}

function validatePreferenceArgs(args: z.infer<typeof getPreferenceBaseSchema> & { platform?: string }, context: z.RefinementCtx): void {
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

  if (args.scope === "systemProperty" && args.appId) {
    context.addIssue({
      code: "custom",
      path: ["appId"],
      message: "appId is not used for Android systemProperty preferences.",
    });
  }
}
