import { TapAnyElement } from "../../src/features/action/TapAnyElement";
import { FakeTimer } from "../fakes/FakeTimer";
import { FakeAdbExecutor } from "../fakes/FakeAdbExecutor";
import { warmedTests } from "../helpers/interactionCancellation";
import { afterEach, describe, expect } from "bun:test";
import {
  dragAndDropHandler,
  pressButtonHandler,
  resetDragAndDropFactory,
  resetPressButtonFactory,
  resetRotateFactory,
  resetSelectAllTextFactory,
  resetTapAnyElementFactory,
  rotateHandler,
  setPostureHandler,
  setSetPostureFactory,
  resetSetPostureFactory,
  selectAllTextHandler,
  setDragAndDropFactory,
  setPressButtonFactory,
  setRotateFactory,
  setSelectAllTextFactory,
  setTapAnyElementFactory,
  tapAnyHandler,
} from "../../src/server/interactionTools";
import type {
  DragAndDropArgs,
  PressButtonArgs,
  RotateArgs,
  SelectAllTextArgs,
  TapAnyArgs,
} from "../../src/server/interactionToolTypes";
import type {
  BootedDevice,
  DragAndDropResult,
  PressButtonResult,
  RotateResult,
  SelectAllTextResult,
  TapOnElementResult,
} from "../../src/models";

const test = warmedTests(() => {
  resetTapAnyElementFactory();
  resetDragAndDropFactory();
  resetSelectAllTextFactory();
  resetPressButtonFactory();
  resetRotateFactory();
  resetSetPostureFactory();
});

// #6163: the tapOn (#6152) fix — gate the message on
// `result.success` and set `isError: true` on the MCP envelope when the
// underlying execute() reports a failure — generalized to the rest of the
// action-tool family. Each suite below exercises the REGISTERED handler (not
// just a formatter) through an injected fake so a revert of the gating is
// caught by a test.
//
// These handlers return either `createJSONToolResponse` (no `structuredContent`)
// or `createStructuredToolResponse` (payload under `structuredContent`); both
// always serialize the full payload into `content[0].text`, so parsing that
// text is the one accessor that works for every handler here.

type ToolResponse = { isError?: true; content: Array<{ type: string; text: string }> };

const parsePayload = (response: ToolResponse): { message: string; success: boolean } =>
  JSON.parse(response.content[0].text) as { message: string; success: boolean };

const fakeDevice = { deviceId: "fake", platform: "android" } as unknown as BootedDevice;

describe("tapAnyHandler (registered handler wiring)", () => {
  const args: TapAnyArgs = { action: "tap", platform: "android" };

  afterEach(() => {
    resetTapAnyElementFactory();
  });

  const fakeResult = (overrides: Partial<TapOnElementResult>): TapOnElementResult =>
    ({
      success: false,
      action: "tap",
      element: { bounds: { left: 0, top: 0, right: 0, bottom: 0 } },
      ...overrides,
    }) as TapOnElementResult;

  test.each([undefined, 123456])(
    "forwards transport deadline %s through internal context",
    async (deadline) => {
      let received: { requestDeadlineMs?: number } | undefined;
      setTapAnyElementFactory(() => ({
        execute: async (_options, _progress, _signal, request) => {
          received = request;
          return fakeResult({ success: true });
        },
      }));
      const internalArgs = { ...args, __mcpRequestDeadlineMs: deadline };
      await tapAnyHandler(fakeDevice, internalArgs);
      expect(received).toEqual({ requestDeadlineMs: deadline });
    },
  );

  test("over-budget longPress returns the real tapAny MCP failure payload before device work", async () => {
    const device: BootedDevice = { name: "Test", deviceId: "budget-tap-any", platform: "android" };
    const timer = new FakeTimer();
    timer.advanceTime(1000);
    const adb = new FakeAdbExecutor();
    const action = new TapAnyElement(device, adb, { timer });
    setTapAnyElementFactory(() => action);

    const response = await tapAnyHandler(device, {
      action: "longPress",
      duration: 20000,
      __mcpRequestDeadlineMs: timer.now() + 5000,
    });
    const error =
      "Failed to tap clickable element: longPress duration 20000 ms does not fit the remaining request budget (5000 ms; needs 22000 ms including dispatch headroom); the press was not started. Increase the request timeout or use a shorter duration.";
    expect(response.isError).toBe(true);
    expect(parsePayload(response).message).toBe(error);
    expect(parsePayload(response).success).toBe(false);
    expect(response.structuredContent).toMatchObject({ success: false, message: error, error });
    expect(adb.getExecutedCommands()).toEqual([]);
  });

  test("a failure sets isError and reports the failure, not a completed tap", async () => {
    setTapAnyElementFactory(() => ({
      execute: async () => fakeResult({ error: "No clickable element found" }),
    }));

    const response = (await tapAnyHandler(fakeDevice, args)) as ToolResponse;
    expect(response.isError).toBe(true);
    expect(parsePayload(response).message).toBe(
      "Failed to tap clickable element: No clickable element found",
    );
    expect(parsePayload(response).success).toBe(false);
  });

  test("a success has no isError and the unchanged success message", async () => {
    setTapAnyElementFactory(() => ({
      execute: async () => fakeResult({ success: true }),
    }));

    const response = (await tapAnyHandler(fakeDevice, args)) as ToolResponse;
    expect(response.isError).toBeUndefined();
    expect(parsePayload(response).message).toBe("Tapped clickable element");
  });
});

describe("dragAndDropHandler (registered handler wiring)", () => {
  const args: DragAndDropArgs = {
    source: { text: "Item" },
    target: { text: "Trash" },
    platform: "android",
  };

  afterEach(() => {
    resetDragAndDropFactory();
  });

  const fakeResult = (overrides: Partial<DragAndDropResult>): DragAndDropResult =>
    ({ success: false, duration: 0, distance: 0, ...overrides }) as DragAndDropResult;

  test("a failure sets isError and reports the failure, not a completed drag", async () => {
    setDragAndDropFactory(() => ({
      execute: async () =>
        fakeResult({ error: "Unable to get view hierarchy, cannot drag and drop" }),
    }));

    const response = (await dragAndDropHandler(fakeDevice, args)) as ToolResponse;
    expect(response.isError).toBe(true);
    expect(parsePayload(response).message).toBe(
      "Failed to drag element to target: Unable to get view hierarchy, cannot drag and drop",
    );
    expect(parsePayload(response).success).toBe(false);
  });

  test("a success has no isError and the unchanged success message", async () => {
    setDragAndDropFactory(() => ({
      execute: async () => fakeResult({ success: true }),
    }));

    const response = (await dragAndDropHandler(fakeDevice, args)) as ToolResponse;
    expect(response.isError).toBeUndefined();
    expect(parsePayload(response).message).toBe("Dragged element to target");
  });
});

describe("selectAllTextHandler (registered handler wiring)", () => {
  const args: SelectAllTextArgs = { platform: "android" };

  afterEach(() => {
    resetSelectAllTextFactory();
  });

  const fakeResult = (overrides: Partial<SelectAllTextResult>): SelectAllTextResult => ({
    success: false,
    ...overrides,
  });

  test("a failure sets isError and reports the failure, not a completed selection", async () => {
    setSelectAllTextFactory(() => ({
      execute: async () => fakeResult({ error: "No focused input field" }),
    }));

    const response = (await selectAllTextHandler(fakeDevice, args)) as ToolResponse;
    expect(response.isError).toBe(true);
    expect(parsePayload(response).message).toBe(
      "Failed to select all text: No focused input field",
    );
    expect(parsePayload(response).success).toBe(false);
  });

  test("a success has no isError and the unchanged success message", async () => {
    setSelectAllTextFactory(() => ({
      execute: async () => fakeResult({ success: true }),
    }));

    const response = (await selectAllTextHandler(fakeDevice, args)) as ToolResponse;
    expect(response.isError).toBeUndefined();
    expect(parsePayload(response).message).toBe("Selected all text in focused input field");
  });
});

describe("pressButtonHandler (registered handler wiring)", () => {
  const args: PressButtonArgs = { button: "back", platform: "android" };

  afterEach(() => {
    resetPressButtonFactory();
  });

  const fakeResult = (overrides: Partial<PressButtonResult>): PressButtonResult =>
    ({ success: false, button: "back", keyCode: 4, ...overrides }) as PressButtonResult;

  test("a failure sets isError and reports the failure, not a completed press", async () => {
    setPressButtonFactory(() => ({
      execute: async () => fakeResult({ error: "Unsupported button: back" }),
    }));

    const response = (await pressButtonHandler(fakeDevice, args)) as ToolResponse;
    expect(response.isError).toBe(true);
    expect(parsePayload(response).message).toBe(
      "Failed to press button back: Unsupported button: back",
    );
    expect(parsePayload(response).success).toBe(false);
  });

  test("a success has no isError and the unchanged success message", async () => {
    setPressButtonFactory(() => ({
      execute: async () => fakeResult({ success: true }),
    }));

    const response = (await pressButtonHandler(fakeDevice, args)) as ToolResponse;
    expect(response.isError).toBeUndefined();
    expect(parsePayload(response).message).toBe("Pressed button back");
  });
});

describe("rotateHandler (registered handler wiring)", () => {
  const args: RotateArgs = {
    orientation: "portrait",
    lockOrientation: true,
    platform: "android",
  };

  afterEach(() => {
    resetRotateFactory();
  });

  const fakeResult = (overrides: Partial<RotateResult>): RotateResult => ({
    success: false,
    orientation: "portrait",
    value: 0,
    ...overrides,
  });

  test("a persistent-lock failure is an MCP error, not a successful rotation", async () => {
    setRotateFactory(() => ({
      execute: async () =>
        fakeResult({
          error: "Rotated to portrait, but the persistent orientation lock could not be confirmed.",
          orientationLockState: "unlocked",
        }),
    }));

    const response = (await rotateHandler(fakeDevice, args)) as ToolResponse;

    expect(response.isError).toBe(true);
    expect(parsePayload(response).success).toBe(false);
    expect(parsePayload(response).message).toContain(
      "Failed to rotate device: Rotated to portrait",
    );
    expect(response).toHaveProperty("structuredContent.success", false);
  });

  test("returns structured content for a successful orientation no-op", async () => {
    const observation = {
      updatedAt: 1,
      screenSize: { width: 1080, height: 1920 },
      systemInsets: { top: 0, bottom: 0, left: 0, right: 0 },
      viewHierarchy: { hierarchy: {} },
    };
    const result = fakeResult({
      success: true,
      currentOrientation: "portrait",
      previousOrientation: "portrait",
      rotationPerformed: false,
      orientationLockState: "unlocked",
      observation,
      message: "Device is already in portrait orientation",
    });
    setRotateFactory(() => ({ execute: async () => result }));

    const response = await rotateHandler(fakeDevice, { orientation: "portrait" });

    expect(response.isError).toBeUndefined();
    expect(response.structuredContent).toEqual(result);
    expect(JSON.parse(response.content[0].text)).toEqual(response.structuredContent);
  });

  test("forwards lockOrientation to the rotate implementation", async () => {
    let receivedLockOrientation: boolean | undefined;
    setRotateFactory(() => ({
      execute: async (_orientation, _progress, lockOrientation) => {
        receivedLockOrientation = lockOrientation;
        return fakeResult({ success: true });
      },
    }));

    const response = (await rotateHandler(fakeDevice, args)) as ToolResponse;

    expect(response.isError).toBeUndefined();
    expect(receivedLockOrientation).toBe(true);
  });
});

describe("setPostureHandler structured result", () => {
  afterEach(() => resetSetPostureFactory());

  test.each([
    {
      posture: "opened",
      display: { key: "inner", role: "inner", posture: "opened", generation: 1 },
    },
    { status: "unsupported", message: "Physical iOS hinge posture can only be read, not set." },
  ] as const)("keeps the text payload unchanged for %j", async (result) => {
    setSetPostureFactory(() => ({
      execute: async () => result,
      executeHingeAngle: async () => result,
    }));
    const response = await setPostureHandler(fakeDevice, { posture: "opened" });
    const message = "status" in result ? result.message : "Set device posture to opened";
    expect(response.structuredContent).toEqual({ message, ...result });
    expect(JSON.parse(response.content[0].text)).toEqual(response.structuredContent);
    expect(response.isError).toBeUndefined();
  });

  test("operational failures still throw actionable errors", async () => {
    setSetPostureFactory(() => ({
      executeHingeAngle: async () => {
        throw new Error("posture failed");
      },
      execute: async () => {
        throw new Error("posture failed");
      },
    }));
    await expect(setPostureHandler(fakeDevice, { posture: "opened" })).rejects.toThrow(
      "Failed to set device posture: posture failed",
    );
  });
});
