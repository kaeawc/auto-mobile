import { afterEach, beforeEach, expect, test } from "bun:test";
import androidCapture from "../fixtures/observe/android-home.json";
import { registerFormTools, createSetUIStateHandler } from "../../src/server/formTools";
import { finalizeToolResponse } from "../../src/server/finalizeToolResponse";
import { ToolRegistry } from "../../src/server/toolRegistry";
import type { BootedDevice, ObserveResult } from "../../src/models";
import type { SetUIStateResult } from "../../src/models/SetUIStateResult";
import { isolateToolRegistry } from "../helpers/withTemporaryTool";

isolateToolRegistry();

// Issue #18350 item 4: setUIState already holds a post-field observation but
// dropped it from the tool response, unlike tapOn/sendKeys.
const device: BootedDevice = { deviceId: "emulator-5554", name: "Pixel", platform: "android" };
const observation: ObserveResult = {
  ...androidCapture,
  observationId: "capture",
  deviceId: device.deviceId,
};
const args = { fields: [{ selector: { text: "Phone" }, value: "4155550142" }] };

beforeEach(() => {
  registerFormTools();
});

afterEach(() => {
  ToolRegistry.clearTools();
});

function handlerReturning(result: SetUIStateResult) {
  return createSetUIStateHandler({ setUIStateFactory: () => ({ execute: async () => result }) });
}

test.each([
  {
    name: "success",
    fields: [{ selector: { text: "Phone" }, success: true, attempts: 1 }],
    success: true,
  },
  {
    name: "partial failure",
    fields: [
      { selector: { text: "Phone" }, success: true, attempts: 1 },
      { selector: { text: "0 minutes" }, success: false, attempts: 1, error: "refused" },
    ],
    success: false,
  },
])("setUIState returns its observation on $name", async ({ fields, success }) => {
  const response = await handlerReturning({
    success,
    fields,
    totalAttempts: fields.length,
    observation,
  })(device, args);
  expect(response.structuredContent.observation).toEqual(observation);

  const finalized = finalizeToolResponse(response, { name: "setUIState", args });
  const schema = ToolRegistry.getRegisteredTool("setUIState")?.outputSchema;
  const parsed = schema!.parse(finalized.structuredContent) as Record<string, unknown>;
  expect(parsed.observation).toBeDefined();
});

test("setUIState omits observation when none was captured", async () => {
  const response = await handlerReturning({
    success: false,
    fields: [],
    totalAttempts: 0,
    error: "deadline",
  })(device, args);
  expect("observation" in response.structuredContent).toBe(false);
});
