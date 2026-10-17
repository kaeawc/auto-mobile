import { z } from "zod";
import {
  SUPPORTED_INPUT_KEYS,
  isInputKeyName,
  type InputKeyName,
} from "../features/action/InputKey";

/**
 * Param schemas for the control socket's `input/*` routes (#11813), replacing the hand-written
 * `parseInput*Params` checks. Refusal text is part of the wire contract, so each field carries the
 * exact message its hand-written check threw, and shape key order is the order those checks ran
 * (the first failing field's message is the refusal). `test/daemon/inputRouteParams.test.ts` pins
 * every case against goldens captured from the hand-written parsers.
 */

type Platform = "android" | "ios";

const field = <T>(is: (value: unknown) => value is T, message: string) =>
  z.custom<T>(is, { message });

const optionalField = <T>(is: (value: unknown) => value is T, message: string) =>
  z.custom<T | undefined>((value) => value === undefined || is(value), { message });

const isString = (value: unknown): value is string => typeof value === "string";
const isNonEmptyString = (value: unknown): value is string =>
  typeof value === "string" && value.length > 0;
const isFiniteNumber = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value);
const isInteger = (value: unknown): value is number =>
  typeof value === "number" && Number.isInteger(value);
const isBoolean = (value: unknown): value is boolean => typeof value === "boolean";

const platformField = (route: string) =>
  field(
    (value): value is Platform => value === "android" || value === "ios",
    `${route} requires platform 'android' or 'ios'`,
  );
const deviceIdField = (route: string) =>
  optionalField(isString, `${route} deviceId must be a string when provided`);
const frameContextField = (route: string) =>
  optionalField(isNonEmptyString, `${route} frameContext must be a non-empty string when provided`);

export const SUPPORTED_PRESS_BUTTONS = [
  "home",
  "back",
  "menu",
  "power",
  "volume_up",
  "volume_down",
  "recent",
  "app_switch",
] as const;

const tapSchema = z
  .object({
    platform: platformField("input/tap"),
    x: field(isFiniteNumber, "input/tap requires numeric x and y params"),
    y: field(isFiniteNumber, "input/tap requires numeric x and y params"),
    duration: optionalField(
      isInteger,
      "input/tap duration must be an integer number of milliseconds when provided",
    ),
    deviceId: deviceIdField("input/tap"),
    frameContext: frameContextField("input/tap"),
  })
  .transform(({ platform, deviceId, x, y, duration, frameContext }) => ({
    platform,
    deviceId,
    x,
    y,
    duration,
    frameContext,
  }));

const SWIPE_COORDINATES = "input/swipe requires numeric startX, startY, endX, and endY params";
const swipeSchema = z
  .object({
    platform: platformField("input/swipe"),
    startX: field(isFiniteNumber, SWIPE_COORDINATES),
    startY: field(isFiniteNumber, SWIPE_COORDINATES),
    endX: field(isFiniteNumber, SWIPE_COORDINATES),
    endY: field(isFiniteNumber, SWIPE_COORDINATES),
    durationMs: optionalField(
      (value): value is number =>
        isInteger(value) && (value as number) >= 1 && (value as number) <= 60_000,
      "input/swipe durationMs must be integer milliseconds between 1 and 60000",
    ),
    deviceId: deviceIdField("input/swipe"),
    frameContext: frameContextField("input/swipe"),
  })
  .transform(({ platform, deviceId, startX, startY, endX, endY, durationMs, frameContext }) => ({
    platform,
    deviceId,
    startX,
    startY,
    endX,
    endY,
    durationMs: durationMs ?? 300,
    frameContext,
  }));

const TYPE_TEXT_KEYS = [
  "platform",
  "deviceId",
  "text",
  "submit",
  "mode",
  "frameContext",
  "sessionUuid",
] as const;
const typeTextSchema = z
  .object({
    platform: platformField("input/typeText"),
    text: field(isNonEmptyString, "input/typeText requires non-empty string text param"),
    submit: optionalField(isBoolean, "input/typeText submit must be a boolean when provided"),
    deviceId: deviceIdField("input/typeText"),
    frameContext: frameContextField("input/typeText"),
    // "append" adds to the focused field instead of replacing it, which is what an interactive
    // client mirroring one keystroke at a time needs: the default replace semantics would leave
    // only the last character typed (#3351).
    mode: optionalField(
      (value): value is "append" => value === "append",
      'input/typeText mode must be "append" when provided',
    ),
  })
  .transform(({ platform, deviceId, text, submit, mode, frameContext }) => ({
    platform,
    deviceId,
    text,
    submit: submit ?? false,
    append: mode === "append",
    frameContext,
  }));

const pressButtonSchema = z
  .object({
    platform: platformField("input/pressButton"),
    button: z
      .custom<string>(isString, { message: "input/pressButton requires button" })
      .refine((value) => (SUPPORTED_PRESS_BUTTONS as readonly string[]).includes(value), {
        message: `input/pressButton button must be one of: ${SUPPORTED_PRESS_BUTTONS.join(", ")}`,
      }),
    deviceId: deviceIdField("input/pressButton"),
    frameContext: frameContextField("input/pressButton"),
  })
  .transform(({ platform, deviceId, button, frameContext }) => ({
    platform,
    deviceId,
    button: button === "app_switch" ? "recent" : button,
    responseButton: button,
    frameContext,
  }));

const KEY_KEYS = ["platform", "deviceId", "key", "frameContext", "sessionUuid"] as const;
const keySchema = z
  .object({
    platform: platformField("input/key"),
    key: z.custom<string>(isString, { message: "input/key requires key" }).refine(isInputKeyName, {
      message: `input/key key must be one of: ${SUPPORTED_INPUT_KEYS.join(", ")}`,
    }),
    deviceId: deviceIdField("input/key"),
    frameContext: frameContextField("input/key"),
  })
  .transform(({ platform, deviceId, key, frameContext }) => ({
    platform,
    deviceId,
    key: key as InputKeyName,
    frameContext,
  }));

/**
 * Streaming gestures have no XCUITest equivalent, so the wire is Android-only. A client that
 * reaches here for iOS bypassed the tool-selection check; reject rather than silently degrade.
 */
function gestureSchema(route: string) {
  const coordinates = `${route} requires numeric x and y params`;
  return z
    .object({
      platform: field(
        (value): value is "android" => value === "android",
        `${route} is only supported on platform 'android'`,
      ),
      gestureId: field(isNonEmptyString, `${route} requires a non-empty gestureId`),
      x: field(isFiniteNumber, coordinates),
      y: field(isFiniteNumber, coordinates),
      deviceId: deviceIdField(route),
      cancel: optionalField(isBoolean, `${route} cancel must be a boolean when provided`),
    })
    .transform(({ platform, deviceId, gestureId, x, y, cancel }) => ({
      platform,
      deviceId,
      gestureId,
      x,
      y,
      cancel: cancel === true,
    }));
}

/** A parser that throws the route's refusal `Error`, as the hand-written parsers did. */
function routeParser<T>(
  route: string,
  schema: z.ZodType<T, z.ZodTypeDef, unknown>,
  allowedKeys?: readonly string[],
): (params: unknown) => T {
  return (params) => {
    if (!params || typeof params !== "object" || Array.isArray(params)) {
      throw new Error(`${route} requires params object`);
    }
    if (allowedKeys) {
      const unsupported = Object.keys(params).filter((key) => !allowedKeys.includes(key));
      if (unsupported.length > 0) {
        throw new Error(`${route} unsupported params: ${unsupported.join(", ")}`);
      }
    }
    const parsed = schema.safeParse(params);
    if (!parsed.success) {
      throw new Error(parsed.error.issues[0].message);
    }
    return parsed.data;
  };
}

export const parseInputTapParams = routeParser("input/tap", tapSchema);
export const parseInputSwipeParams = routeParser("input/swipe", swipeSchema);
export const parseInputTypeTextParams = routeParser(
  "input/typeText",
  typeTextSchema,
  TYPE_TEXT_KEYS,
);
export const parseInputPressButtonParams = routeParser("input/pressButton", pressButtonSchema);
export const parseInputKeyParams = routeParser("input/key", keySchema, KEY_KEYS);

const GESTURE_PARSERS = new Map(
  ["input/gestureStart", "input/gestureMove", "input/gestureEnd"].map((route) => [
    route,
    routeParser(route, gestureSchema(route)),
  ]),
);

export function parseInputGestureParams(params: unknown, route: string) {
  const parse = GESTURE_PARSERS.get(route) ?? routeParser(route, gestureSchema(route));
  return parse(params);
}

export type InputTapParams = ReturnType<typeof parseInputTapParams>;
export type InputSwipeParams = ReturnType<typeof parseInputSwipeParams>;
export type InputTypeTextParams = ReturnType<typeof parseInputTypeTextParams>;
export type InputPressButtonParams = ReturnType<typeof parseInputPressButtonParams>;
export type InputKeyParams = ReturnType<typeof parseInputKeyParams>;
export type InputGestureParams = ReturnType<typeof parseInputGestureParams>;
