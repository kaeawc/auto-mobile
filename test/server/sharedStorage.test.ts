import { describe, expect, test } from "bun:test";
import { stageSharedStorageSchema } from "../../src/server/sharedStorageContract";
import { createSharedStorageServiceForTesting } from "../../src/server/sharedStorageService";
import { shellQuote } from "../../src/utils/shellQuote";
import { FakeAdbClientFactory } from "../fakes/FakeAdbClientFactory";

const device = { deviceId: "emulator-5554", name: "Pixel", platform: "android" as const };

describe("shared storage fixtures", () => {
  test("validates namespaces, source exclusivity, traversal, and duplicates", () => {
    expect(
      stageSharedStorageSchema.safeParse({
        namespace: "run-1",
        files: [{ destinationPath: "a.txt", contentText: "a" }],
      }).success,
    ).toBe(true);
    expect(
      stageSharedStorageSchema.safeParse({
        namespace: "../escape",
        files: [{ destinationPath: "a.txt", contentText: "a" }],
      }).success,
    ).toBe(false);
    expect(
      stageSharedStorageSchema.safeParse({
        namespace: "run-1",
        files: [
          { destinationPath: "a.txt", contentText: "a" },
          { destinationPath: "a\\b/../a.txt", contentText: "b" },
        ],
      }).success,
    ).toBe(false);
    expect(
      stageSharedStorageSchema.safeParse({
        namespace: "run-1",
        files: [{ destinationPath: "a.txt", contentText: "a", contentBase64: "Yg==" }],
      }).success,
    ).toBe(false);
  });

  test("resets only the namespace and reports document/media outcomes", async () => {
    const adbFactory = new FakeAdbClientFactory();
    adbFactory
      .getFakeClient()
      .setCommandResult(
        `shell content query --uri content://media/external/file --projection _data --where ${shellQuote("_data='/storage/emulated/0/Download/AutoMobile/run-1/images/photo.png'")}`,
        "_data=/storage/emulated/0/Download/AutoMobile/run-1/images/photo.png\n",
      );
    const service = createSharedStorageServiceForTesting({ adbFactory });
    const result = await service.stage({
      device,
      namespace: "run-1",
      reset: true,
      files: [
        { destinationPath: "docs/read me.txt", contentText: "hello" },
        { destinationPath: "images/photo.png", contentBase64: "AAEC" },
      ],
    });

    expect(result).toEqual({
      success: true,
      deviceId: "emulator-5554",
      platform: "android",
      namespace: "run-1",
      root: "/storage/emulated/0/Download/AutoMobile/run-1",
      reset: true,
      files: [
        {
          destinationPath: "docs/read me.txt",
          devicePath: "/storage/emulated/0/Download/AutoMobile/run-1/docs/read me.txt",
          byteCount: 5,
          indexing: "notRequested",
          indexingReason:
            "File is not a recognized media type and was written for document-picker use.",
        },
        {
          destinationPath: "images/photo.png",
          devicePath: "/storage/emulated/0/Download/AutoMobile/run-1/images/photo.png",
          byteCount: 3,
          indexing: "verified",
        },
      ],
    });
    const commands = adbFactory.getFakeClient().getAllCommands();
    expect(commands[0]).toContain("rm -rf");
    expect(commands[0]).toContain("/storage/emulated/0/Download/AutoMobile/run-1");
    expect(commands.some((command) => command.includes("MEDIA_SCANNER_SCAN_FILE"))).toBe(true);
    expect(
      commands.some((command) =>
        command.includes("/storage/emulated/0/Download/AutoMobile/run-1/../"),
      ),
    ).toBe(false);
  });
});
