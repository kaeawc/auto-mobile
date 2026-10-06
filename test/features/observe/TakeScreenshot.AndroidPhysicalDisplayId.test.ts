import { FakeScreenshotPathProtection } from "../../fakes/FakeScreenshotPathProtection";
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { AndroidPhysicalDisplayIdResolver } from "../../../src/features/observe/android/AndroidPhysicalDisplayId";
import { TakeScreenshot } from "../../../src/features/observe/TakeScreenshot";
import type { ScreenshotFileWriter } from "../../../src/features/observe/screenshot/ScreenshotFileWriter";
import { FakeAdbClientFactory } from "../../fakes/FakeAdbClientFactory";
import { FakeAdbExecutor } from "../../fakes/FakeAdbExecutor";
import { FakeFileSystem } from "../../fakes/FakeFileSystem";
import { FakeIdGenerator } from "../../fakes/FakeIdGenerator";
import { FakeTimer } from "../../fakes/FakeTimer";
import { androidDevice } from "./takeScreenshotTestHelpers";

const fixtureDirectory = "test/features/observe/android/fixtures";
const singleDisplayId = "4619827259835644673";
const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

const screenshotWriter: ScreenshotFileWriter = {
  async write(): Promise<void> {},
  async remove(): Promise<void> {},
};

function captureBase64(
  screenshot: TakeScreenshot,
  path: string,
  options: { format: "png"; displayId?: number } = { format: "png" },
): Promise<unknown> {
  const capture = Reflect.get(screenshot, "captureScreenshotBase64");
  if (typeof capture !== "function") {
    throw new Error("captureScreenshotBase64 test seam is unavailable");
  }
  return Reflect.apply(capture, screenshot, [path, options]) as Promise<unknown>;
}

function configureDisplayFixtures(adb: FakeAdbExecutor): void {
  adb.setCommandResponse("dumpsys SurfaceFlinger", {
    stdout: readFileSync(`${fixtureDirectory}/surfaceflinger-two-displays.txt`, "utf8"),
    stderr: "",
  });
  adb.setCommandResponse("cmd display get-displays", {
    stdout: readFileSync(`${fixtureDirectory}/cmd-display-two-displays.txt`, "utf8"),
    stderr: "",
  });
}

function createScreenshot(
  adb: FakeAdbExecutor,
  timer: FakeTimer,
  displayRevision: (deviceId: string) => number = () => 0,
): TakeScreenshot {
  return new TakeScreenshot(
    androidDevice("display-test-device"),
    new FakeAdbClientFactory(adb),
    timer,
    undefined,
    screenshotWriter,
    new FakeFileSystem(),
    () => "/screenshots/cache",
    new AndroidPhysicalDisplayIdResolver({ timer, displayRevision }),
    undefined,
    { pathProtection: new FakeScreenshotPathProtection(new FakeTimer()) },
  );
}

describe("TakeScreenshot Android physical display selection", function () {
  test("uses a unique temp path for single-display screencap", async function () {
    const adb = new FakeAdbExecutor();
    adb.setCommandResponse("dumpsys SurfaceFlinger", {
      stdout: `Display ${singleDisplayId} (HWC display 0): port=1`,
      stderr: "",
    });
    adb.setCommandResponse("cmd display get-displays", { stdout: "", stderr: "" });
    adb.setCommandResponse("screencap", { stdout: png.toString("base64"), stderr: "" });

    const screenshot = createScreenshot(adb, new FakeTimer());
    await captureBase64(screenshot, "/screenshots/single.png");
    adb.clearHistory();
    await captureBase64(screenshot, "/screenshots/single-again.png");

    const commands = adb.getExecutedCommands();
    expect(commands.some((command) => command.includes("/data/local/tmp/am-shot-"))).toBe(true);
    expect(commands.some((command) => command.includes("/sdcard/screenshot.png"))).toBe(false);
    expect(commands.filter((command) => command.includes("dumpsys SurfaceFlinger"))).toHaveLength(
      0,
    );
    expect(commands.filter((command) => command.includes("cmd display get-displays"))).toHaveLength(
      0,
    );
    expect(commands.filter((command) => command.includes("screencap"))).toHaveLength(1);
    expect(commands.find((command) => command.includes("screencap"))).toContain("screencap -p");
  });

  test("caches a single-display result within the TTL", async function () {
    const adb = new FakeAdbExecutor();
    adb.setCommandResponse("dumpsys SurfaceFlinger", {
      stdout: `Display ${singleDisplayId} (HWC display 0): port=1`,
      stderr: "",
    });
    adb.setCommandResponse("cmd display get-displays", { stdout: "", stderr: "" });
    adb.setCommandResponse("screencap", { stdout: png.toString("base64"), stderr: "" });
    const timer = new FakeTimer();
    const screenshot = createScreenshot(adb, timer);

    await captureBase64(screenshot, "/screenshots/single.png");
    const firstCommands = adb.getExecutedCommands();
    expect(
      firstCommands.filter((command) => command.includes("dumpsys SurfaceFlinger")),
    ).toHaveLength(1);
    expect(
      firstCommands.filter((command) => command.includes("cmd display get-displays")),
    ).toHaveLength(1);
    adb.clearHistory();
    await captureBase64(screenshot, "/screenshots/single-again.png");

    const commands = adb.getExecutedCommands();
    expect(commands.filter((command) => command.includes("dumpsys SurfaceFlinger"))).toHaveLength(
      0,
    );
    expect(commands.filter((command) => command.includes("cmd display get-displays"))).toHaveLength(
      0,
    );
    expect(commands.find((command) => command.includes("screencap"))).toContain("screencap -p");
    expect(commands.find((command) => command.includes("screencap"))).not.toContain("screencap -d");
  });

  test("selects the default physical display on a multi-display device", async function () {
    const adb = new FakeAdbExecutor();
    configureDisplayFixtures(adb);
    adb.setCommandResponse("screencap", { stdout: png.toString("base64"), stderr: "" });

    await captureBase64(createScreenshot(adb, new FakeTimer()), "/screenshots/multi.png");

    expect(adb.getExecutedCommands().find((command) => command.includes("screencap"))).toContain(
      `screencap -d ${singleDisplayId} -p`,
    );
  });

  test("keeps concurrent captures isolated and preserves their PNG bytes", async function () {
    const adb = new FakeAdbExecutor();
    const firstPng = Buffer.concat([png, Buffer.from([1])]);
    const secondPng = Buffer.concat([png, Buffer.from([2])]);
    adb.setCommandResponseSequence("screencap", [
      { stdout: firstPng.toString("base64"), stderr: "" },
      { stdout: secondPng.toString("base64"), stderr: "" },
    ]);
    const written = new Map<string, Buffer>();
    const writer: ScreenshotFileWriter = {
      async write(filePath, data): Promise<void> {
        written.set(filePath, Buffer.from(data));
      },
      async remove(): Promise<void> {},
    };
    const screenshot = new TakeScreenshot(
      androidDevice("concurrent-capture-device"),
      new FakeAdbClientFactory(adb),
      new FakeTimer(),
      new FakeIdGenerator(["capture-one", "capture-two"]),
      writer,
      new FakeFileSystem(),
      () => "/screenshots/cache",
      undefined,
      undefined,
      { pathProtection: new FakeScreenshotPathProtection(new FakeTimer()) },
    );

    await Promise.all([
      captureBase64(screenshot, "/screenshots/one.png"),
      captureBase64(screenshot, "/screenshots/two.png"),
    ]);

    expect(written.get("/screenshots/one.png")).toEqual(firstPng);
    expect(written.get("/screenshots/two.png")).toEqual(secondPng);
    const captureCommands = adb
      .getExecutedCommands()
      .filter((command) => command.includes("screencap"));
    expect(captureCommands).toHaveLength(2);
    expect(captureCommands[0]).toContain("/data/local/tmp/am-shot-capture-one-");
    expect(captureCommands[1]).toContain("/data/local/tmp/am-shot-capture-two-");
  });

  test("rejects decoded screencap data without the PNG signature", async function () {
    const adb = new FakeAdbExecutor();
    adb.setCommandResponse("dumpsys SurfaceFlinger", {
      stdout: `Display ${singleDisplayId} (HWC display 0): port=1`,
      stderr: "",
    });
    adb.setCommandResponse("cmd display get-displays", { stdout: "", stderr: "" });
    adb.setCommandResponse("screencap", {
      stdout: Buffer.from("[Warning] Multiple displays detected").toString("base64"),
      stderr: "",
    });

    await expect(
      captureBase64(createScreenshot(adb, new FakeTimer()), "/screenshots/bad.png"),
    ).rejects.toThrow("Android screencap returned data without a PNG signature");
  });

  test("strips warning text printed before base64 screencap output", async function () {
    const adb = new FakeAdbExecutor();
    adb.setCommandResponse("screencap", {
      stdout: `WARNING: display fallback\n${png.toString("base64")}`,
      stderr: "",
    });
    const written = new Map<string, Buffer>();
    const writer: ScreenshotFileWriter = {
      async write(filePath, data): Promise<void> {
        written.set(filePath, Buffer.from(data));
      },
      async remove(): Promise<void> {},
    };
    const screenshot = new TakeScreenshot(
      androidDevice("warning-output-device"),
      new FakeAdbClientFactory(adb),
      new FakeTimer(),
      new FakeIdGenerator(["warning"]),
      writer,
      new FakeFileSystem(),
      () => "/screenshots/cache",
      undefined,
      undefined,
      { pathProtection: new FakeScreenshotPathProtection(new FakeTimer()) },
    );

    await captureBase64(screenshot, "/screenshots/warning.png");

    expect(written.get("/screenshots/warning.png")).toEqual(png);
  });

  test("caches a resolved ID for 10 seconds and refreshes after expiry", async function () {
    const adb = new FakeAdbExecutor();
    configureDisplayFixtures(adb);
    const timer = new FakeTimer();
    const resolver = new AndroidPhysicalDisplayIdResolver({ timer, displayRevision: () => 0 });

    expect(await resolver.resolve(adb, "display-test-device")).toBe(singleDisplayId);
    adb.clearHistory();
    expect(await resolver.resolve(adb, "display-test-device")).toBe(singleDisplayId);
    expect(adb.getExecutedCommands()).toHaveLength(0);

    timer.advanceTime(10_001);
    expect(await resolver.resolve(adb, "display-test-device")).toBe(singleDisplayId);
    expect(adb.getExecutedCommands()).toHaveLength(2);
  });

  test("refreshes a resolved ID after a revision bump within the TTL", async function () {
    const adb = new FakeAdbExecutor();
    configureDisplayFixtures(adb);
    let revision = 0;
    const resolver = new AndroidPhysicalDisplayIdResolver({
      timer: new FakeTimer(),
      displayRevision: () => revision,
    });

    expect(await resolver.resolve(adb, "display-test-device")).toBe(singleDisplayId);
    adb.clearHistory();
    revision++;

    expect(await resolver.resolve(adb, "display-test-device")).toBe(singleDisplayId);
    expect(adb.getExecutedCommands()).toEqual([
      "shell dumpsys SurfaceFlinger --display-id",
      "shell cmd display get-displays",
    ]);
    adb.clearHistory();
    expect(await resolver.resolve(adb, "display-test-device")).toBe(singleDisplayId);
    expect(adb.getExecutedCommands()).toHaveLength(0);
  });

  test("does not cache an in-flight lookup across a revision bump", async function () {
    const adb = new FakeAdbExecutor();
    configureDisplayFixtures(adb);
    let revision = 0;
    const resolver = new AndroidPhysicalDisplayIdResolver({
      timer: new FakeTimer(),
      displayRevision: () => revision,
    });

    const lookup = resolver.resolve(adb, "display-test-device");
    // Fake ADB records both commands synchronously; the resolver is still
    // awaiting their promises when this transition happens.
    expect(adb.getExecutedCommands()).toHaveLength(2);
    revision++;
    expect(await lookup).toBe(singleDisplayId);
    adb.clearHistory();

    expect(await resolver.resolve(adb, "display-test-device")).toBe(singleDisplayId);
    expect(adb.getExecutedCommands()).toEqual([
      "shell dumpsys SurfaceFlinger --display-id",
      "shell cmd display get-displays",
    ]);
  });

  test("a device revision bump leaves other devices cached", async function () {
    const adbA = new FakeAdbExecutor();
    const adbB = new FakeAdbExecutor();
    configureDisplayFixtures(adbA);
    configureDisplayFixtures(adbB);
    const revisions = new Map([
      ["device-a", 0],
      ["device-b", 0],
    ]);
    const resolver = new AndroidPhysicalDisplayIdResolver({
      timer: new FakeTimer(),
      displayRevision: (deviceId) => revisions.get(deviceId) ?? 0,
    });

    expect(await resolver.resolve(adbA, "device-a")).toBe(singleDisplayId);
    expect(await resolver.resolve(adbB, "device-b")).toBe(singleDisplayId);
    adbA.clearHistory();
    adbB.clearHistory();
    revisions.set("device-a", 1);

    expect(await resolver.resolve(adbB, "device-b")).toBe(singleDisplayId);
    expect(adbB.getExecutedCommands()).toHaveLength(0);
    expect(await resolver.resolve(adbA, "device-a")).toBe(singleDisplayId);
    expect(adbA.getExecutedCommands()).toEqual([
      "shell dumpsys SurfaceFlinger --display-id",
      "shell cmd display get-displays",
    ]);
  });

  test("TakeScreenshot refreshes physical display discovery after a revision bump", async function () {
    const adb = new FakeAdbExecutor();
    configureDisplayFixtures(adb);
    adb.setCommandResponse("screencap", { stdout: png.toString("base64"), stderr: "" });
    let revision = 0;
    const screenshot = createScreenshot(adb, new FakeTimer(), () => revision);

    await captureBase64(screenshot, "/screenshots/before-transition.png");
    adb.clearHistory();
    revision++;
    await captureBase64(screenshot, "/screenshots/after-transition.png");

    const commands = adb.getExecutedCommands();
    expect(commands.filter((command) => command.includes("dumpsys SurfaceFlinger"))).toHaveLength(
      1,
    );
    expect(commands.filter((command) => command.includes("cmd display get-displays"))).toHaveLength(
      1,
    );
    expect(commands.find((command) => command.includes("screencap"))).toContain(
      `screencap -d ${singleDisplayId} -p`,
    );
  });

  describe("explicit logical display id", function () {
    const fixtures = "test/fixtures";
    // Captured `cmd display get-displays`: logical 0 -> local:4619827259835644672,
    // logical 3 -> local:4619827259835644673.
    const foldDisplays = readFileSync(`${fixtures}/android-display/fold-displays.txt`, "utf8");
    // Captured single-record list from a Pixel Fold AVD: logical 0 -> local:4619827259835644672.
    const foldOpenDisplays = readFileSync(
      `${fixtures}/android-fold-displays/fold-open-get-displays.txt`,
      "utf8",
    );
    // Captured list whose logical 2 is a VIRTUAL display with no physical id.
    const virtualDisplays = readFileSync(
      `${fixtureDirectory}/cmd-display-two-displays.txt`,
      "utf8",
    );

    function screencapCommand(adb: FakeAdbExecutor): string {
      return adb.getExecutedCommands().findLast((command) => command.includes("screencap")) ?? "";
    }

    function adbWithDisplays(stdout: string): FakeAdbExecutor {
      const adb = new FakeAdbExecutor();
      adb.setCommandResponse("cmd display get-displays", { stdout, stderr: "" });
      adb.setCommandResponse("screencap", { stdout: png.toString("base64"), stderr: "" });
      return adb;
    }

    test("passes the physical id of a non-zero logical display, never the logical id", async function () {
      const adb = adbWithDisplays(foldDisplays);

      await captureBase64(createScreenshot(adb, new FakeTimer()), "/screenshots/cover.png", {
        format: "png",
        displayId: 3,
      });

      expect(screencapCommand(adb)).toContain("screencap -d 4619827259835644673 -p");
      expect(screencapCommand(adb)).not.toContain("screencap -d 3 ");
    });

    test("passes the physical id for logical display 0 instead of the rejected -d 0", async function () {
      const adb = adbWithDisplays(foldOpenDisplays);

      await captureBase64(createScreenshot(adb, new FakeTimer()), "/screenshots/inner.png", {
        format: "png",
        displayId: 0,
      });

      expect(screencapCommand(adb)).toContain(`screencap -d ${"4619827259835644672"} -p`);
      expect(screencapCommand(adb)).not.toContain("screencap -d 0 ");
      expect(adb.getExecutedCommands().some((c) => c.includes("dumpsys SurfaceFlinger"))).toBe(
        false,
      );
    });

    test("fails with an actionable error for a non-default display with no physical id", async function () {
      const adb = adbWithDisplays(virtualDisplays);

      await expect(
        captureBase64(createScreenshot(adb, new FakeTimer()), "/screenshots/virtual.png", {
          format: "png",
          displayId: 2,
        }),
      ).rejects.toThrow("Cannot screenshot Android display 2");
      expect(screencapCommand(adb)).toBe("");
    });

    test("fails instead of sending the logical id when the display list cannot be read", async function () {
      const adb = adbWithDisplays("");
      adb.setCommandError("cmd display get-displays", new Error("service unavailable"));

      await expect(
        captureBase64(createScreenshot(adb, new FakeTimer()), "/screenshots/unreadable.png", {
          format: "png",
          displayId: 3,
        }),
      ).rejects.toThrow("Cannot screenshot Android display 3");
      expect(screencapCommand(adb)).toBe("");
    });

    test("omits -d for default display 0 when no physical id can be resolved", async function () {
      const adb = adbWithDisplays("");
      adb.setCommandError("cmd display get-displays", new Error("service unavailable"));

      await captureBase64(createScreenshot(adb, new FakeTimer()), "/screenshots/default0.png", {
        format: "png",
        displayId: 0,
      });

      expect(screencapCommand(adb)).toContain("screencap -p");
      expect(screencapCommand(adb)).not.toContain("screencap -d");
    });

    test("refetches once when the cached list lacks the requested logical id", async function () {
      const adb = adbWithDisplays(foldOpenDisplays);
      const screenshot = createScreenshot(adb, new FakeTimer());
      const lookups = () =>
        adb.getExecutedCommands().filter((command) => command.includes("cmd display get-displays"));

      await captureBase64(screenshot, "/screenshots/one.png", { format: "png", displayId: 0 });
      expect(lookups()).toHaveLength(1);

      // A display appears (hot-plug / fold transition) after the list was cached.
      adb.setCommandResponse("cmd display get-displays", { stdout: foldDisplays, stderr: "" });
      await captureBase64(screenshot, "/screenshots/two.png", { format: "png", displayId: 3 });

      expect(lookups()).toHaveLength(2);
      expect(screencapCommand(adb)).toContain("screencap -d 4619827259835644673 -p");
    });

    test("refetches at most once per call when the id is still missing", async function () {
      const adb = adbWithDisplays(foldOpenDisplays);
      const screenshot = createScreenshot(adb, new FakeTimer());
      const lookups = () =>
        adb.getExecutedCommands().filter((command) => command.includes("cmd display get-displays"));

      await captureBase64(screenshot, "/screenshots/one.png", { format: "png", displayId: 0 });
      await expect(
        captureBase64(screenshot, "/screenshots/two.png", { format: "png", displayId: 3 }),
      ).rejects.toThrow("Cannot screenshot Android display 3");

      expect(lookups()).toHaveLength(2);
    });

    test("caches the display list within the TTL and refreshes after a revision bump", async function () {
      const adb = adbWithDisplays(foldDisplays);
      let revision = 0;
      const screenshot = createScreenshot(adb, new FakeTimer(), () => revision);
      const lookups = () =>
        adb.getExecutedCommands().filter((command) => command.includes("cmd display get-displays"));

      await captureBase64(screenshot, "/screenshots/one.png", { format: "png", displayId: 3 });
      await captureBase64(screenshot, "/screenshots/two.png", { format: "png", displayId: 0 });
      expect(lookups()).toHaveLength(1);

      revision++;
      await captureBase64(screenshot, "/screenshots/three.png", { format: "png", displayId: 3 });
      expect(lookups()).toHaveLength(2);
    });

    test("leaves the default-display command unchanged when no display is requested", async function () {
      const adb = new FakeAdbExecutor();
      configureDisplayFixtures(adb);
      adb.setCommandResponse("screencap", { stdout: png.toString("base64"), stderr: "" });

      await captureBase64(createScreenshot(adb, new FakeTimer()), "/screenshots/default.png");

      expect(screencapCommand(adb)).toContain(`screencap -d ${singleDisplayId} -p`);
    });
  });
});
