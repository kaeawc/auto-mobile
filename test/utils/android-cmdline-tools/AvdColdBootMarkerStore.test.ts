import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { FileAvdConfigReader } from "../../../src/utils/android-cmdline-tools/AvdConfigReader";
import {
  AVD_COLD_BOOT_MARKER,
  FileAvdColdBootMarkerStore,
} from "../../../src/utils/android-cmdline-tools/AvdColdBootMarkerStore";
import { FakeFileSystem } from "../../fakes/FakeFileSystem";

describe("FileAvdColdBootMarkerStore", () => {
  for (const redirected of [false, true]) {
    test(`round trips across store instances in resolved AVD directory, redirected=${redirected}`, async () => {
      const files = new FakeFileSystem();
      const home = join("/test", "custom-avd-home");
      const directory = redirected
        ? join("/test", "external", "Pixel.avd")
        : join(home, "Pixel.avd");
      files.setDirectory(directory);
      if (redirected) {
        files.setFile(join(home, "Pixel.ini"), `path=${directory}\n`);
      }
      const resolver = new FileAvdConfigReader(
        (p) => files.readFile(p),
        (p) => files.existsSync(p),
        home,
        "/sdk",
      );
      const markerFiles = {
        readFile: async (target: string) => {
          if (!files.existsSync(target)) {
            throw Object.assign(new Error("missing marker"), { code: "ENOENT" });
          }
          return files.readFile(target);
        },
        writeFile: (target: string, content: string) => files.writeFile(target, content),
        unlink: (target: string) => files.unlink(target),
      };
      const first = new FileAvdColdBootMarkerStore(resolver, markerFiles);
      expect(await first.isMarked("Pixel")).toBe(false);
      await first.mark("Pixel");
      // existsSync normalizes separators; getWrittenFiles() keys are "/"-joined even on Windows.
      expect(files.existsSync(join(directory, AVD_COLD_BOOT_MARKER))).toBe(true);
      // A new instance models a restarted daemon; no process-local state is shared.
      const restarted = new FileAvdColdBootMarkerStore(resolver, markerFiles);
      expect(await restarted.isMarked("Pixel")).toBe(true);

      await restarted.clear("Pixel");
      expect(await first.isMarked("Pixel")).toBe(false);
      await restarted.clear("Pixel");
    });
  }

  for (const operation of ["isMarked", "mark", "clear"] as const) {
    test(`propagates unexpected ${operation} errors for caller warning and recovery`, async () => {
      const failure = async (): Promise<never> => {
        throw new Error("permission denied");
      };
      const store = new FileAvdColdBootMarkerStore(
        {
          getAvdHome: () => "/test",
          resolveAvdDirectory: async () => "/test/Pixel.avd",
        },
        { readFile: failure, writeFile: failure, unlink: failure },
      );
      await expect(store[operation]("Pixel")).rejects.toThrow("permission denied");
    });
  }

  test("mark resolves false and writes nothing for a name with no AVD directory", async () => {
    const writes: string[] = [];
    const store = new FileAvdColdBootMarkerStore(
      { getAvdHome: () => "/test", resolveAvdDirectory: async () => null },
      {
        readFile: async () => "",
        writeFile: async (target: string) => {
          writes.push(target);
        },
        unlink: async () => {},
      },
    );
    expect(await store.mark("Pixel_9_Runtime")).toBe(false);
    expect(writes).toEqual([]);
  });
});
