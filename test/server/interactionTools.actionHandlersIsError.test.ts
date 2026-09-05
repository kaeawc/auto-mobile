import { afterEach, describe, expect, test } from "bun:test";
import {
  clearTextHandler,
  dragAndDropHandler,
  imeActionHandler,
  pressButtonHandler,
  resetClearTextFactory,
  resetDragAndDropFactory,
  resetImeActionFactory,
  resetPressButtonFactory,
  resetSelectAllTextFactory,
  resetTapAnyElementFactory,
  selectAllTextHandler,
  setClearTextFactory,
  setDragAndDropFactory,
  setImeActionFactory,
  setPressButtonFactory,
  setSelectAllTextFactory,
  setTapAnyElementFactory,
  tapAnyHandler,
} from "../../src/server/interactionTools";
import type {
  ClearTextArgs,
  DragAndDropArgs,
  ImeActionArgs,
  PressButtonArgs,
  SelectAllTextArgs,
  TapAnyArgs,
} from "../../src/server/interactionToolTypes";
import type {
  BootedDevice,
  ClearTextResult,
  DragAndDropResult,
  ImeActionResult,
  PressButtonResult,
  SelectAllTextResult,
  TapOnElementResult,
} from "../../src/models";

// #6163: the tapOn (#6152) and inputText (#5902) fix — gate the message on
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

describe("clearTextHandler (registered handler wiring)", () => {
  const args: ClearTextArgs = { platform: "android" };

  afterEach(() => {
    resetClearTextFactory();
  });

  const fakeResult = (overrides: Partial<ClearTextResult>): ClearTextResult => ({
    success: false,
    ...overrides,
  });

  test("a failure sets isError and reports the failure, not a completed clear", async () => {
    setClearTextFactory(() => ({
      execute: async () => fakeResult({ error: "Failed to clear text" }),
    }));

    const response = (await clearTextHandler(fakeDevice, args)) as ToolResponse;
    expect(response.isError).toBe(true);
    expect(parsePayload(response).message).toBe("Failed to clear text: Failed to clear text");
    expect(parsePayload(response).success).toBe(false);
  });

  test("a success has no isError and the unchanged success message", async () => {
    setClearTextFactory(() => ({
      execute: async () => fakeResult({ success: true }),
    }));

    const response = (await clearTextHandler(fakeDevice, args)) as ToolResponse;
    expect(response.isError).toBeUndefined();
    expect(parsePayload(response).message).toBe("Cleared text from input field");
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

describe("imeActionHandler (registered handler wiring)", () => {
  const args: ImeActionArgs = { action: "done", platform: "android" };

  afterEach(() => {
    resetImeActionFactory();
  });

  const fakeResult = (overrides: Partial<ImeActionResult>): ImeActionResult => ({
    success: false,
    action: "done",
    ...overrides,
  });

  test("a failure sets isError and reports the failure, not a completed action", async () => {
    setImeActionFactory(() => ({
      execute: async () => fakeResult({ error: "No focused input field" }),
    }));

    const response = (await imeActionHandler(fakeDevice, args)) as ToolResponse;
    expect(response.isError).toBe(true);
    expect(parsePayload(response).message).toBe(
      'Failed to execute IME action "done": No focused input field',
    );
    expect(parsePayload(response).success).toBe(false);
  });

  test("a success has no isError and the unchanged success message", async () => {
    setImeActionFactory(() => ({
      execute: async () => fakeResult({ success: true }),
    }));

    const response = (await imeActionHandler(fakeDevice, args)) as ToolResponse;
    expect(response.isError).toBeUndefined();
    expect(parsePayload(response).message).toBe('Executed IME action "done"');
  });
});
