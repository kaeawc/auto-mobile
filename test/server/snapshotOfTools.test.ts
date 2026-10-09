import { isolateToolRegistry } from "../helpers/withTemporaryTool";
import { FakeScreenshotPathProtection } from "../fakes/FakeScreenshotPathProtection";
import { FakeTimer } from "../fakes/FakeTimer";
import { SCREENSHOT_PATH_MIN_LIFETIME_MS } from "../../src/features/observe/ScreenshotRetention";
import { afterEach, describe, expect, test } from "bun:test";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { registerSnapshotOfTools, snapshotOfSchema } from "../../src/server/snapshotOfTools";
import { ToolRegistry } from "../../src/server/toolRegistry";
import { SearchableHierarchy } from "../../src/features/utility/SearchableNode";
import type { ViewHierarchyResult } from "../../src/models";
import { CountingIdGenerator } from "../../src/utils/IdGenerator";
import { FakeImageBackend } from "../fakes/FakeImageBackend";

isolateToolRegistry();

const device = { deviceId: "device", platform: "android" as const, name: "Test" };
const hierarchy: ViewHierarchyResult = {
  screenWidth: 4,
  screenHeight: 4,
  hierarchy: {
    node: [
      { "resource-id": "target", bounds: { left: 1, top: 1, right: 3, bottom: 3 } },
      { "resource-id": "duplicate", bounds: { left: 0, top: 0, right: 1, bottom: 1 } },
      { "resource-id": "duplicate", bounds: { left: 2, top: 2, right: 4, bottom: 4 } },
    ],
  },
};

describe("snapshotOf tool", () => {
  const paths: string[] = [];
  afterEach(async () => {
    for (const dir of paths.splice(0)) {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  test("requires exactly one source", () => {
    expect(snapshotOfSchema.safeParse({}).success).toBe(false);
    expect(
      snapshotOfSchema.safeParse({
        elementId: "x",
        rectangle: { left: 0, top: 0, right: 1, bottom: 1 },
      }).success,
    ).toBe(false);
  });

  test.each([1, 3])(
    "iOS snapshotOf rotation %s uses the upright shared crop for both sources",
    async (rotation) => {
      const image = new FakeImageBackend();
      image.setMetadataResult({ width: 1206, height: 2622, format: "png", size: 8 });
      const landscape = structuredClone(hierarchy);
      landscape.screenWidth = 874;
      landscape.screenHeight = 402;
      landscape.rotation = rotation;
      // Keep the existing selector fixture intact; rectangle form also exercises a nonsquare crop.
      const bounds = { left: 0, top: 0, right: 200, bottom: 100 };
      const writes: Buffer[] = [];
      registerSnapshotOfTools({
        pathProtection: new FakeScreenshotPathProtection(new FakeTimer()),
        hierarchyCaptureFactory: () => ({
          capture: async (request) => ({
            captureId: "capture",
            platform: "ios",
            requestedFreshness: request.freshness,
            receivedAt: 0,
            hierarchy: landscape,
            nodes: new SearchableHierarchy().project(landscape),
          }),
        }),
        screenshotFactory: () => ({ execute: async () => ({ success: true, path: "fake.png" }) }),
        readFile: async () => Buffer.from("source"),
        imageBackend: image,
        writer: {
          write: async (_path, data) => {
            writes.push(data);
          },
          remove: async () => {},
        },
        outputDirectory: () => "/fake/screenshots",
        ids: new CountingIdGenerator("crop"),
      });
      const tool = ToolRegistry.getTool("snapshotOf")!;
      for (const args of [{ elementId: "target" }, { rectangle: bounds }]) {
        const response = await tool.deviceAwareHandler!(
          { ...device, platform: "ios" },
          tool.schema.parse(args),
        );
        const result = JSON.parse(response.content[0].text);
        const requested = "elementId" in args ? { left: 1, top: 1, right: 3, bottom: 3 } : bounds;
        expect(result).toMatchObject({
          imageSize: {
            width: (requested.right - requested.left) * 3,
            height: (requested.bottom - requested.top) * 3,
          },
          screenshotOrientation: "display",
          requestedBounds: requested,
        });
        expect(image.lastPipeline?.operations).toEqual([
          {
            type: "crop",
            x: (rotation === 1 ? 402 - requested.bottom : requested.top) * 3,
            y: (rotation === 1 ? requested.left : 874 - requested.right) * 3,
            width: (requested.bottom - requested.top) * 3,
            height: (requested.right - requested.left) * 3,
          },
          { type: "rotate", degrees: rotation === 1 ? 270 : 90 },
        ]);
      }
      expect(writes).toHaveLength(2);
    },
  );

  test("captures once, writes secure PNG, and returns metadata without bytes", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "snapshot-of-test-"));
    paths.push(dir);
    const image = new FakeImageBackend();
    image.setMetadataResult({ width: 4, height: 4, format: "png", size: 8 });
    image.setExecuteResult(Buffer.from("png-crop"));
    let captures = 0;
    const timer = new FakeTimer();
    const protection = new FakeScreenshotPathProtection(timer);
    registerSnapshotOfTools({
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
      screenshotFactory: () => ({
        execute: async () => {
          captures++;
          return { success: true, path: "fake.png" };
        },
      }),
      readFile: async () => Buffer.from("source"),
      imageBackend: image,
      outputDirectory: () => dir,
      ids: new CountingIdGenerator("crop"),
      pathProtection: protection,
    });
    const tool = ToolRegistry.getTool("snapshotOf")!;
    expect(tool.defaultEnabled).toBe(false);
    const response = await tool.deviceAwareHandler!(
      device,
      tool.schema.parse({ elementId: "target" }),
    );
    const result = JSON.parse(response.content[0].text);
    expect(protection.isProtected(result.path)).toBe(true);
    timer.advanceTime(SCREENSHOT_PATH_MIN_LIFETIME_MS);
    expect(protection.isProtected(result.path)).toBe(false);
    expect(captures).toBe(1);
    expect(result).toMatchObject({
      path: path.join(dir, "snapshot-of-crop-1.png"),
      imageSize: { width: 2, height: 2 },
      clipped: false,
      unit: "pixels",
      expiresAt: SCREENSHOT_PATH_MIN_LIFETIME_MS,
    });
    expect(JSON.stringify(result)).not.toContain("png-crop");
    expect(await fs.readFile(result.path, "utf8")).toBe("png-crop");
    if (process.platform !== "win32") {
      // Windows does not enforce POSIX file permission modes.
      expect((await fs.stat(result.path)).mode & 0o777).toBe(0o600);
    }
    await expect(
      tool.deviceAwareHandler!(device, tool.schema.parse({ elementId: "missing" })),
    ).rejects.toThrow("not found");
    await expect(
      tool.deviceAwareHandler!(device, tool.schema.parse({ elementId: "duplicate" })),
    ).rejects.toThrow("ambiguous");
    expect(captures).toBe(1);
  });
});
