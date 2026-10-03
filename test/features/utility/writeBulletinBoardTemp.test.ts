import { describe, expect, mock, spyOn, test } from "bun:test";
import { writeBulletinBoardTemp } from "../../../src/features/utility/ios/IosNotificationAuthorizationReader";
import { logger } from "../../../src/utils/logger";

function fakeFiles() {
  return {
    mkdtemp: mock(async () => "/fake/bulletin-board"),
    writeFile: mock(async (_file: string, _data: Buffer) => {}),
    rm: mock(async (_directory: string, _options: { recursive: true; force: true }) => {}),
  };
}

describe("writeBulletinBoardTemp", () => {
  for (const cleanupFails of [false, true]) {
    test(`cleans a failed blob write and preserves its error (cleanup fails: ${cleanupFails})`, async () => {
      const files = fakeFiles();
      const original = new Error("disk full");
      const cleanupError = new Error("cleanup denied");
      files.writeFile.mockImplementation(async () => {
        throw original;
      });
      if (cleanupFails) {
        files.rm.mockImplementation(async () => {
          throw cleanupError;
        });
      }
      const warn = spyOn(logger, "warn").mockImplementation(() => {});
      try {
        await expect(writeBulletinBoardTemp(Buffer.from("blob"), files)).rejects.toBe(original);
        expect(files.rm).toHaveBeenCalledTimes(1);
        expect(files.rm).toHaveBeenCalledWith("/fake/bulletin-board", {
          recursive: true,
          force: true,
        });
        if (cleanupFails) {
          expect(warn).toHaveBeenCalledWith(
            "Failed to remove BulletinBoard blob directory: cleanup denied",
            cleanupError,
          );
        } else {
          expect(warn).not.toHaveBeenCalled();
        }
      } finally {
        warn.mockRestore();
      }
    });
  }

  test("returns the blob file without removing its directory on success", async () => {
    const files = fakeFiles();
    const buffer = Buffer.from("blob");
    expect(await writeBulletinBoardTemp(buffer, files)).toBe("/fake/bulletin-board/blob.bplist");
    expect(files.writeFile).toHaveBeenCalledWith("/fake/bulletin-board/blob.bplist", buffer);
    expect(files.rm).not.toHaveBeenCalled();
  });
});
