import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SwiftcIosFilesFixtureBuilder } from "../../src/server/IosFilesFixtureBuilder";
import { DefaultHostCommandExecutor } from "../../src/utils/HostCommandExecutor";

// Real Xcode toolchain, no simulator: proves the embedded sources still compile and
// that the bundle carries the keys iOS needs to expose Documents in Files.
const cacheRoot = mkdtempSync(join(tmpdir(), "files-fixture-build-"));
afterAll(() => rmSync(cacheRoot, { recursive: true, force: true }));

describe("SwiftcIosFilesFixtureBuilder with the Xcode toolchain", () => {
  test("compiles a signed bundle that enables Files sharing", async () => {
    const host = new DefaultHostCommandExecutor();
    const builder = new SwiftcIosFilesFixtureBuilder({ host, cacheRoot: () => cacheRoot });
    const version = await builder.version();
    const app = await builder.ensureBuilt();

    expect(app).toBe(join(cacheRoot, version, "FilesFixture.app"));
    const read = async (key: string) =>
      (
        await host.executeCommand("plutil", ["-extract", key, "raw", join(app, "Info.plist")])
      ).stdout.trim();
    expect(await read("CFBundleIdentifier")).toBe("dev.jasonpearson.automobile.FilesFixture");
    expect(await read("CFBundleVersion")).toBe(version);
    expect(await read("UIFileSharingEnabled")).toBe("true");
    expect(await read("LSSupportsOpeningDocumentsInPlace")).toBe("true");
    await host.executeCommand("codesign", ["--verify", "--strict", app]);
    expect(await builder.ensureBuilt()).toBe(app);
  }, 180_000);
});
