import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createMultiTouchHandler, registerMultiTouchTools } from "../../src/server/multiTouchTools";
import { createSwipeAtHandler, registerSwipeAtTools } from "../../src/server/swipeAtTools";
import { registerSnapshotOfTools } from "../../src/server/snapshotOfTools";
import {
  multiTouchResultSchema,
  swipeAtResultSchema,
} from "../../src/server/gestureToolOutputSchemas";
import { snapshotOfResultSchema } from "../../src/server/snapshotOfToolOutputSchemas";
import { ToolRegistry } from "../../src/server/toolRegistry";
import { SearchableHierarchy } from "../../src/features/utility/SearchableNode";
import type { BootedDevice, ViewHierarchyResult } from "../../src/models";
import { CountingIdGenerator } from "../../src/utils/IdGenerator";
import { FakeImageBackend } from "../fakes/FakeImageBackend";
import { FakeScreenshotPathProtection } from "../fakes/FakeScreenshotPathProtection";
import { FakeTimer } from "../fakes/FakeTimer";
import { isolateToolRegistry } from "../helpers/withTemporaryTool";

isolateToolRegistry();

const device: BootedDevice = { deviceId: "fake-device", name: "Fake", platform: "android" };

type Envelope = { content: Array<{ type: string; text?: string }>; structuredContent: unknown };

function expectTextEqualsStructured(response: Envelope): void {
  expect(JSON.parse(response.content[0].text!)).toEqual(
    JSON.parse(JSON.stringify(response.structuredContent)),
  );
}

describe("swipeAt, multiTouch and snapshotOf output schemas (#11830)", () => {
  beforeEach(() => ToolRegistry.clearTools());
  afterEach(() => ToolRegistry.clearTools());

  test("each tool declares its outputSchema", () => {
    registerSwipeAtTools();
    registerMultiTouchTools();
    registerSnapshotOfTools();
    expect(ToolRegistry.getTool("swipeAt")?.outputSchema).toBe(swipeAtResultSchema);
    expect(ToolRegistry.getTool("multiTouch")?.outputSchema).toBe(multiTouchResultSchema);
    expect(ToolRegistry.getTool("snapshotOf")?.outputSchema).toBe(snapshotOfResultSchema);
  });

  test.each([true, false])(
    "swipeAt (success=%s) keeps the text payload and validates structuredContent",
    async (success) => {
      const handler = createSwipeAtHandler({
        swipeAtFactory: () => ({
          execute: async () => ({
            success,
            x1: 1,
            y1: 2,
            x2: 3,
            y2: 4,
            duration: 300,
            ...(success ? {} : { error: "boom" }),
          }),
        }),
      });
      const response = (await handler(device, {
        from: { x: 1, y: 2 },
        to: { x: 3, y: 4 },
      } as never)) as Envelope;
      expectTextEqualsStructured(response);
      expect(swipeAtResultSchema.safeParse(response.structuredContent).success).toBe(true);
    },
  );

  test.each([true, false])(
    "multiTouch (success=%s) keeps the text payload and validates structuredContent",
    async (success) => {
      const handler = createMultiTouchHandler({
        multiTouchFactory: () => ({
          execute: async () => ({
            success,
            action: "tap" as const,
            fingers: 2,
            fingerSpacing: 40,
            points: [
              { x: 1, y: 2 },
              { x: 41, y: 2 },
            ],
            x1: 1,
            y1: 2,
            x2: 1,
            y2: 2,
            duration: 50,
            ...(success ? {} : { error: "boom" }),
          }),
        }),
      });
      const response = (await handler(device, {
        action: "tap",
        fingers: 2,
        x: 1,
        y: 2,
      } as never)) as Envelope;
      expectTextEqualsStructured(response);
      expect(multiTouchResultSchema.safeParse(response.structuredContent).success).toBe(true);
    },
  );

  test("snapshotOf keeps the text payload and validates structuredContent", async () => {
    const hierarchy: ViewHierarchyResult = {
      screenWidth: 4,
      screenHeight: 4,
      hierarchy: {},
    };
    const image = new FakeImageBackend();
    image.setMetadataResult({ width: 4, height: 4, format: "png", size: 8 });
    image.setExecuteResult(Buffer.from("png-crop"));
    registerSnapshotOfTools({
      pathProtection: new FakeScreenshotPathProtection(new FakeTimer()),
      hierarchyCaptureFactory: () => ({
        capture: async (request) => ({
          captureId: "capture",
          platform: "android",
          requestedFreshness: request.freshness,
          receivedAt: 0,
          hierarchy,
          nodes: new SearchableHierarchy().project(hierarchy),
        }),
      }),
      screenshotFactory: () => ({ execute: async () => ({ success: true, path: "fake.png" }) }),
      readFile: async () => Buffer.from("source"),
      imageBackend: image,
      writer: { write: async () => {}, remove: async () => {} },
      outputDirectory: () => "/fake/screenshots",
      ids: new CountingIdGenerator("crop"),
    });
    const tool = ToolRegistry.getTool("snapshotOf")!;
    const response = (await tool.deviceAwareHandler!(
      device,
      tool.schema.parse({ rectangle: { left: 0, top: 0, right: 2, bottom: 2 } }),
    )) as Envelope;
    expectTextEqualsStructured(response);
    expect(snapshotOfResultSchema.safeParse(response.structuredContent).success).toBe(true);
  });
});
