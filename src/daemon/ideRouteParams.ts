import { z } from "zod";
import { ToolRegistry } from "../server/toolRegistry";

/**
 * Param schemas for the `ide/*` routes that validate their own params (#11813), replacing the
 * inline `request.params as {...}` checks. Refusal text is part of the wire contract, so each
 * schema carries the exact message its hand-written check threw, and the field checks keep the old
 * truthiness semantics (an empty string or 0 is "missing"; a non-string truthy value passes).
 * `test/daemon/ideRouteParams.test.ts` pins every case against goldens captured from the old
 * checks.
 *
 * The one deliberate difference: nullish params used to throw the engine's TypeError (reading a
 * property of undefined); they now get the route's own refusal, as an empty object does.
 */

const truthy = <T = string>(message: string) => z.custom<T>((value) => Boolean(value), { message });

/** A parser that throws the route's refusal `Error` for the first failing field. */
function ideParser<T>(schema: z.ZodType<T, z.ZodTypeDef, unknown>): (params: unknown) => T {
  return (params) => {
    const source =
      params !== null && typeof params === "object" && !Array.isArray(params) ? params : {};
    const parsed = schema.safeParse(source);
    if (!parsed.success) {
      throw new Error(parsed.error.issues[0].message);
    }
    return parsed.data;
  };
}

export const parseSetFeatureFlagParams = ideParser(
  z.object({
    key: truthy("setFeatureFlag requires 'key' (string) and 'enabled' (boolean) params"),
    enabled: z.custom<boolean>((value) => typeof value === "boolean", {
      message: "setFeatureFlag requires 'key' (string) and 'enabled' (boolean) params",
    }),
    config: z.custom<Record<string, unknown> | null | undefined>(() => true),
  }),
);

const SESSION_TOOL_MESSAGE =
  "setSessionToolEnabled requires sessionUuid, a user-configurable toolName, and enabled boolean params";
export const parseSetSessionToolEnabledParams = ideParser(
  z.object({
    sessionUuid: truthy(SESSION_TOOL_MESSAGE),
    toolName: z.custom<string>(
      (value) => Boolean(value) && ToolRegistry.isUserConfigurableTool(value as string),
      { message: SESSION_TOOL_MESSAGE },
    ),
    enabled: z.custom<boolean>((value) => typeof value === "boolean", {
      message: SESSION_TOOL_MESSAGE,
    }),
  }),
);

const UPDATE_SERVICE_MESSAGE =
  "updateService requires 'deviceId' (string) and 'platform' (string) params";
export const parseUpdateServiceParams = ideParser(
  z
    .object({
      deviceId: truthy(UPDATE_SERVICE_MESSAGE),
      platform: truthy<string>(UPDATE_SERVICE_MESSAGE).refine(
        (value) => value === "android" || value === "ios",
        (value) => ({ message: `Invalid platform: ${value}. Must be 'android' or 'ios'.` }),
      ),
      force: z.unknown(),
    })
    .transform(({ deviceId, platform, force }) => ({
      deviceId,
      platform: platform as "android" | "ios",
      force: force === true,
    })),
);

const SET_KEY_VALUE_MESSAGE =
  "setKeyValue requires deviceId, appId, fileName, key, and type params";
export const parseSetKeyValueParams = ideParser(
  z.object({
    platform: z.custom<string | undefined>(() => true),
    deviceId: truthy(SET_KEY_VALUE_MESSAGE),
    appId: truthy(SET_KEY_VALUE_MESSAGE),
    fileName: truthy(SET_KEY_VALUE_MESSAGE),
    key: truthy(SET_KEY_VALUE_MESSAGE),
    type: truthy(SET_KEY_VALUE_MESSAGE),
    value: z.custom<string | null | undefined>(() => true),
  }),
);

const REMOVE_KEY_VALUE_MESSAGE =
  "removeKeyValue requires deviceId, appId, fileName, and key params";
export const parseRemoveKeyValueParams = ideParser(
  z.object({
    platform: z.custom<string | undefined>(() => true),
    deviceId: truthy(REMOVE_KEY_VALUE_MESSAGE),
    appId: truthy(REMOVE_KEY_VALUE_MESSAGE),
    fileName: truthy(REMOVE_KEY_VALUE_MESSAGE),
    key: truthy(REMOVE_KEY_VALUE_MESSAGE),
  }),
);

const CLEAR_KEY_VALUE_FILE_MESSAGE =
  "clearKeyValueFile requires deviceId, appId, and fileName params";
export const parseClearKeyValueFileParams = ideParser(
  z.object({
    platform: z.custom<string | undefined>(() => true),
    deviceId: truthy(CLEAR_KEY_VALUE_FILE_MESSAGE),
    appId: truthy(CLEAR_KEY_VALUE_FILE_MESSAGE),
    fileName: truthy(CLEAR_KEY_VALUE_FILE_MESSAGE),
  }),
);
