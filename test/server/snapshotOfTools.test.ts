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

  test("captures once, writes secure PNG, and returns metadata without bytes", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "snapshot-of-test-"));
    paths.push(dir);
    const image = new FakeImageBackend();
    image.setMetadataResult({ width: 4, height: 4, format: "png", size: 8 });
    image.setExecuteResult(Buffer.from("png-crop"));
    let captures = 0;
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
    });
    const tool = ToolRegistry.getTool("snapshotOf")!;
    expect(tool.defaultEnabled).toBe(false);
    const response = await tool.deviceAwareHandler!(
      device,
      tool.schema.parse({ elementId: "target" }),
    );
    const result = JSON.parse(response.content[0].text);
    expect(captures).toBe(1);
    expect(result).toMatchObject({
      path: path.join(dir, "snapshot-of-crop-1.png"),
      imageSize: { width: 2, height: 2 },
      clipped: false,
      unit: "pixels",
    });
    expect(JSON.stringify(result)).not.toContain("png-crop");
    expect(await fs.readFile(result.path, "utf8")).toBe("png-crop");
    expect((await fs.stat(result.path)).mode & 0o777).toBe(0o600);
    await expect(
      tool.deviceAwareHandler!(device, tool.schema.parse({ elementId: "missing" })),
    ).rejects.toThrow("not found");
    await expect(
      tool.deviceAwareHandler!(device, tool.schema.parse({ elementId: "duplicate" })),
    ).rejects.toThrow("ambiguous");
    expect(captures).toBe(1);
  });
});
