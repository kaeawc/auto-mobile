import { LONG_PRESS_HARD_MAX_MS } from "../../src/features/action/tapAtGesture";
import {
  SEND_KEYS_MAX_COMMANDS,
  SEND_KEYS_MAX_MODIFIERS,
} from "../../src/features/action/SendKeys";
import { afterEach, expect, test } from "bun:test";
import { z } from "zod/v4";
import {
  dragAndDropSchema,
  dragAndDropHandler,
  setDragAndDropFactory,
  resetDragAndDropFactory,
  swipeOnSchema,
  pinchOnSchema,
  sendKeysSchema,
  tapAnySchema,
  tapOnSchema,
  swipeOnHandler,
  setSwipeOnFactory,
  resetSwipeOnFactory,
} from "../../src/server/interactionTools";
import type { BootedDevice } from "../../src/models";
import {
  PRESS_DURATION_MIN_MS,
  PRESS_DURATION_MAX_MS,
  DRAG_DURATION_MIN_MS,
  DRAG_DURATION_MAX_MS,
  HOLD_DURATION_MIN_MS,
  HOLD_DURATION_MAX_MS,
} from "../../src/features/action/DragAndDrop";
import {
  SWIPE_APEX_PAUSE_MIN_MS,
  SWIPE_RETURN_SPEED_EXCLUSIVE_MIN,
  validateSwipeTimingOptions,
} from "../../src/features/action/swipeon/swipeTiming";

import {
  PINCH_DISTANCE_EXCLUSIVE_MIN,
  PINCH_SCALE_EXCLUSIVE_MIN,
  PINCH_DURATION_MIN_MS,
  PINCH_DURATION_MAX_MS,
} from "../../src/features/action/PinchOn";

test("schema bounds follow the implementation constants", () => {
  const bounds = [
    {
      field: "duration",
      schema: pinchOnSchema.shape.duration,
      min: PINCH_DURATION_MIN_MS,
      max: PINCH_DURATION_MAX_MS,
      exclusive: false,
      integer: true,
    },
    {
      field: "pressDurationMs",
      schema: dragAndDropSchema.shape.pressDurationMs,
      min: PRESS_DURATION_MIN_MS,
      max: PRESS_DURATION_MAX_MS,
      exclusive: false,
    },
    {
      field: "dragDurationMs",
      schema: dragAndDropSchema.shape.dragDurationMs,
      min: DRAG_DURATION_MIN_MS,
      max: DRAG_DURATION_MAX_MS,
      exclusive: false,
    },
    {
      field: "holdDurationMs",
      schema: dragAndDropSchema.shape.holdDurationMs,
      min: HOLD_DURATION_MIN_MS,
      max: HOLD_DURATION_MAX_MS,
      exclusive: false,
    },
    {
      field: "apexPause",
      schema: swipeOnSchema.shape.apexPause,
      min: SWIPE_APEX_PAUSE_MIN_MS,
      max: undefined,
      exclusive: false,
    },
    {
      field: "returnSpeed",
      schema: swipeOnSchema.shape.returnSpeed,
      min: SWIPE_RETURN_SPEED_EXCLUSIVE_MIN,
      max: undefined,
      exclusive: true,
    },
    {
      field: "scale",
      schema: pinchOnSchema.shape.scale,
      min: PINCH_SCALE_EXCLUSIVE_MIN,
      max: undefined,
      exclusive: true,
    },
    {
      field: "distanceStart",
      schema: pinchOnSchema.shape.distanceStart,
      min: PINCH_DISTANCE_EXCLUSIVE_MIN,
      max: undefined,
      exclusive: true,
    },
    {
      field: "distanceEnd",
      schema: pinchOnSchema.shape.distanceEnd,
      min: PINCH_DISTANCE_EXCLUSIVE_MIN,
      max: undefined,
      exclusive: true,
    },
  ];
  for (const { field, schema, min, max, exclusive, integer } of bounds) {
    const json = z.toJSONSchema(schema);
    expect(json[exclusive ? "exclusiveMinimum" : "minimum"]).toBe(min);
    expect(json.maximum).toBe(max);
    expect(schema.safeParse(min - 1).success).toBe(false);
    expect(schema.safeParse(min).success).toBe(!exclusive);
    expect(schema.safeParse(min + 0.01).success).toBe(!integer);
    if (integer) {
      expect(json.type).toBe("integer");
    }
    expect(schema.description).toContain(`${min}`);
    if (max !== undefined) {
      expect(schema.safeParse(max).success).toBe(true);
      const invalid = schema.safeParse(max + 1);
      expect(invalid.success).toBe(false);
      if (invalid.success) {
        throw new Error(`Expected ${field} upper-bound error`);
      }
      expect(invalid.error.issues[0].code).toBe("too_big");
      expect(schema.description).toContain(`${max}`);
    } else {
      expect(schema.safeParse(Number.MAX_SAFE_INTEGER).success).toBe(true);
      if (field === "apexPause" || field === "returnSpeed") {
        expect(validateSwipeTimingOptions({ boomerang: true, [field]: min - 1 })).not.toBeNull();
        expect(validateSwipeTimingOptions({ boomerang: true, [field]: min + 0.01 })).toBeNull();
      }
    }
  }
});

test("registered schemas report invalid duration and timing fields before dispatch", () => {
  const cases = [
    {
      schema: dragAndDropSchema,
      input: {
        source: { text: "a" },
        target: { text: "b" },
        dragDurationMs: DRAG_DURATION_MAX_MS + 1,
      },
      field: "dragDurationMs",
      code: "too_big",
    },
    {
      schema: swipeOnSchema,
      input: { direction: "up", boomerang: true, apexPause: SWIPE_APEX_PAUSE_MIN_MS - 1 },
      field: "apexPause",
      code: "too_small",
    },
    {
      schema: swipeOnSchema,
      input: { direction: "up", boomerang: true, returnSpeed: SWIPE_RETURN_SPEED_EXCLUSIVE_MIN },
      field: "returnSpeed",
      code: "too_small",
    },
  ];
  for (const { schema, input, field, code } of cases) {
    const result = schema.safeParse(input);
    expect(result.success).toBe(false);
    if (result.success) {
      throw new Error(`Expected ${field} schema error`);
    }
    expect(result.error.issues).toContainEqual(expect.objectContaining({ path: [field], code }));
  }
});

const device: BootedDevice = {
  deviceId: "schema-bounds-fake",
  platform: "android",
  name: "Schema bounds fake",
};

afterEach(() => {
  resetDragAndDropFactory();
  resetSwipeOnFactory();
});

test("pinch schema rejects the nonpositive values already rejected by the action", () => {
  for (const field of ["scale", "distanceStart", "distanceEnd"]) {
    for (const value of [-1, 0]) {
      const result = pinchOnSchema.safeParse({ direction: "out", [field]: value });
      expect(result.success).toBe(false);
      if (result.success) {
        throw new Error(`Expected ${field} positivity error`);
      }
      expect(result.error.issues).toContainEqual(
        expect.objectContaining({ path: [field], code: "too_small" }),
      );
    }
    expect(pinchOnSchema.safeParse({ direction: "out", [field]: 0.01 }).success).toBe(true);
  }
});

test("implementation-supported drag duration reaches the fake action unchanged", async () => {
  const dragInput = {
    source: { text: "source" },
    target: { text: "target" },
    dragDurationMs: 1500,
  };
  const parsedDrag = dragAndDropSchema.parse(dragInput);
  setDragAndDropFactory(() => ({
    execute: async (options) => {
      expect(options.dragDurationMs).toBe(dragInput.dragDurationMs);
      return { success: true, duration: 1500, distance: 10 };
    },
  }));
  expect((await dragAndDropHandler(device, parsedDrag)).isError).toBeUndefined();
});

test.each([{ apexPause: 3001 }, { returnSpeed: 0.05 }, { returnSpeed: 4 }])(
  "implementation-supported swipe timing reaches the fake action: %j",
  async (timing) => {
    const parsedSwipe = swipeOnSchema.parse({ direction: "up", boomerang: true, ...timing });
    setSwipeOnFactory(() => ({
      execute: async (options) => {
        expect(options.apexPause).toBe(timing.apexPause);
        expect(options.returnSpeed).toBe(timing.returnSpeed);
        return { success: true };
      },
    }));
    expect((await swipeOnHandler(device, parsedSwipe)).isError).toBeUndefined();
  },
);

test.each([1, 10000, 0, -1, 1.5, 10001])("pinch duration schema boundary %s", (duration) => {
  const parsed = pinchOnSchema.safeParse({ direction: "in", duration });
  expect(parsed.success).toBe(duration === 1 || duration === 10000);
  if (!parsed.success) {
    expect(parsed.error.issues[0].path).toEqual(["duration"]);
  }
});

test("sendKeys schema caps raw arrays", () => {
  const key = { action: "key", key: "tab", modifiers: ["shift", "ctrl", "alt", "meta"] };
  expect(
    sendKeysSchema.safeParse({
      commands: Array.from({ length: SEND_KEYS_MAX_COMMANDS }, () => key),
    }).success,
  ).toBe(true);
  expect(
    sendKeysSchema.safeParse({
      commands: Array.from({ length: SEND_KEYS_MAX_COMMANDS + 1 }, () => key),
    }).success,
  ).toBe(false);
  const commandsJson = z.toJSONSchema(sendKeysSchema.shape.commands);
  expect(commandsJson.maxItems).toBe(SEND_KEYS_MAX_COMMANDS);
  const command = sendKeysSchema.shape.commands.element;
  const keySchema = command.options.find((option) => option.shape.action.value === "key");
  if (!keySchema || !("modifiers" in keySchema.shape)) {
    throw new Error("Missing key modifiers schema");
  }
  expect(z.toJSONSchema(keySchema.shape.modifiers).maxItems).toBe(SEND_KEYS_MAX_MODIFIERS);
  for (const fifth of ["shift", "super"]) {
    expect(
      sendKeysSchema.safeParse({ commands: [{ ...key, modifiers: [...key.modifiers, fifth] }] })
        .success,
    ).toBe(false);
  }
});

test("tapAny describes the action longPress maximum", () => {
  expect(tapAnySchema.shape.duration.description).toContain(`${LONG_PRESS_HARD_MAX_MS}`);
});

for (const [name, schema, input] of [
  ["tapOn", tapOnSchema, { selector: { text: "ListItem" } }],
  ["tapAny", tapAnySchema, {}],
] as const) {
  test(`${name} bounds long press duration before dispatch`, () => {
    for (const duration of [LONG_PRESS_HARD_MAX_MS + 1, LONG_PRESS_HARD_MAX_MS + 0.1]) {
      const result = schema.safeParse({ ...input, action: "longPress", duration });
      expect(result.success).toBe(false);
      if (result.success) {
        throw new Error("Expected duration bound error");
      }
      expect(result.error.issues[0].path).toEqual(["duration"]);
      expect(result.error.issues[0].message).toContain(`${LONG_PRESS_HARD_MAX_MS}`);
    }
    for (const duration of [undefined, 0, 1, 200, 1500, 17000, LONG_PRESS_HARD_MAX_MS]) {
      expect(schema.safeParse({ ...input, action: "longPress", duration }).success).toBe(true);
    }
    expect(z.toJSONSchema(schema.shape.duration).maximum).toBe(LONG_PRESS_HARD_MAX_MS);
    expect(schema.shape.duration.description).toContain(`${LONG_PRESS_HARD_MAX_MS}`);
  });
}
