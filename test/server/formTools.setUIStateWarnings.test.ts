import { afterEach, beforeEach, expect, test } from "bun:test";
import { registerFormTools, createSetUIStateHandler } from "../../src/server/formTools";
import { ToolRegistry } from "../../src/server/toolRegistry";
import type { BootedDevice } from "../../src/models";
import type { SetUIStateResult } from "../../src/features/action/SetUIState";

const device: BootedDevice = { deviceId: "ios-test", name: "iPhone", platform: "ios" };
const args = { fields: [{ selector: { elementId: "email" }, value: "new" }] };
const fields: SetUIStateResult["fields"] = [
  { selector: { elementId: "email" }, success: true, attempts: 1 },
];
const warnings = ["Email: iOS clear check skipped for a secure field."];

beforeEach(() => {
  registerFormTools();
});

afterEach(() => {
  ToolRegistry.clearTools();
});

test("setUIState forwards warnings into its structured and text output schema", async () => {
  const setUIStateHandler = createSetUIStateHandler({
    setUIStateFactory: () => ({
      execute: async () => ({ success: true, fields, totalAttempts: 1, warnings }),
    }),
  });
  const response = await setUIStateHandler(device, args);
  const structured = response.structuredContent;
  const schema = ToolRegistry.getRegisteredTool("setUIState")?.outputSchema;
  expect(schema).toBeDefined();
  const parsed = schema!.parse(structured);
  expect(parsed).toHaveProperty("warnings", warnings);
  expect(structured.warnings).toEqual(warnings);
  expect(JSON.parse(response.content[0].text)).toHaveProperty("warnings", warnings);
  expect(structured.fields[0]).not.toHaveProperty("warnings");
});

test.each([
  { name: "absent", value: undefined },
  { name: "empty", value: [] },
])("setUIState omits $name warnings", async ({ value }) => {
  const setUIStateHandler = createSetUIStateHandler({
    setUIStateFactory: () => ({
      execute: async () => ({
        success: true,
        fields,
        totalAttempts: 1,
        ...(value === undefined ? {} : { warnings: value }),
      }),
    }),
  });
  const response = await setUIStateHandler(device, args);
  const structured = response.structuredContent;
  expect("warnings" in structured).toBe(false);
  expect(response.content[0].text).toBe(
    JSON.stringify({ success: true, fields, totalAttempts: 1 }),
  );
});
