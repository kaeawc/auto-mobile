import { expect, test } from "bun:test";
import { suspendedRefusal } from "../helpers/prototypeSuspendedCapture";
import { typedRefusalFields } from "../../src/models/typedRefusalFields";
import { shapeToolCallError, isTypedToolRefusal } from "../../src/server/shapeToolCallError";
import { mcpRequestFailureDetails } from "../../src/daemon/socketServer";

test("prototype suspension uses the shared MCP and socket typed refusal fields", () => {
  const error = suspendedRefusal();
  const fields = typedRefusalFields(error);
  expect(fields?.code).toBe("prototype_suspended");
  expect(isTypedToolRefusal(error)).toBe(true);
  const shaped = shapeToolCallError(error, { toolName: "observe", source: "MCP" });
  expect(shaped.isError).toBe(true);
  expect(JSON.parse(shaped.content[0].text)).toEqual({
    success: false,
    error: error.message,
    ...fields,
  });
  expect(mcpRequestFailureDetails(error)).toMatchObject(fields!);
});
