import { loggerCallsWithPrefix } from "../../helpers/loggerCallsWithPrefix";
import { expect, describe, test, beforeEach, afterEach, spyOn } from "bun:test";
import { PostNotification } from "../../../src/features/utility/PostNotification";
import { FakeAdbExecutor } from "../../fakes/FakeAdbExecutor";
import { FakeWindow } from "../../fakes/FakeWindow";
import { BootedDevice } from "../../../src/models";
import { FakeFileSystem } from "../../fakes/FakeFileSystem";
import path from "path";
import { DAEMON_LAUNCH_CWD_ENV } from "../../../src/utils/workingDirectory";

import { logger } from "../../../src/utils/logger";

describe("PostNotification", () => {
  let warn: ReturnType<typeof spyOn<typeof logger, "warn">>;
  let device: BootedDevice;
  let fakeAdb: FakeAdbExecutor;
  let fakeWindow: FakeWindow;
  const originalLaunchCwd = process.env[DAEMON_LAUNCH_CWD_ENV];

  beforeEach(() => {
    warn = spyOn(logger, "warn").mockImplementation(() => {});
    device = {
      deviceId: "test-device",
      platform: "android",
    } as BootedDevice;

    fakeAdb = new FakeAdbExecutor();
    fakeWindow = new FakeWindow();
    fakeWindow.configureCachedActiveWindow({
      appId: "com.example.app",
      activityName: "MainActivity",
      layoutSeqSum: 1,
    } as any);
    fakeWindow.configureActiveWindow({
      appId: "com.example.app",
      activityName: "MainActivity",
      layoutSeqSum: 1,
    } as any);
  });

  afterEach(() => {
    warn.mockRestore();
    if (originalLaunchCwd === undefined) {
      delete process.env[DAEMON_LAUNCH_CWD_ENV];
    } else {
      process.env[DAEMON_LAUNCH_CWD_ENV] = originalLaunchCwd;
    }
  });

  // Signature bytes only: the host sniffs the container, it never decodes pixels.
  const PNG_BYTES = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);
  const IMAGE_DIR = path.join(path.sep, "fake-host", "images");
  const newNotifier = (fileSystem: FakeFileSystem) =>
    new PostNotification(device, fakeAdb, fakeWindow, null, fileSystem);
  const configureBroadcastResult = (code: number) => {
    configureReceiverProbe();
    fakeAdb.setCommandResponse("am broadcast", {
      stdout: `Broadcast completed: result=${code}`,
      stderr: "",
    });
  };

  const configureReceiverProbe = (appId: string = "com.example.app") => {
    fakeAdb.setCommandResponse("cmd package query-receivers", {
      stdout: `1 receivers found:\n    ${appId}/dev.jasonpearson.automobile.sdk.notifications.AutoMobileNotificationReceiver`,
      stderr: "",
    });
  };

  test("logs failures preparing SDK extras and preserves the Android failure", async () => {
    const error = new Error("action unavailable");
    const postNotification = new PostNotification(device, fakeAdb, fakeWindow);
    const result = await postNotification.execute({
      title: "Hello",
      body: "World",
      appId: "com.example.app",
      actions: [
        {
          get label(): string {
            throw error;
          },
          actionId: "open",
        },
      ],
    });
    expect(result).toEqual({
      success: false,
      supported: false,
      error: "Failed to post notification: action unavailable",
    });
    expect(
      loggerCallsWithPrefix(
        warn.mock.calls,
        "[PostNotification]",
        "Failed to post notification:",
        "Image file not found at ",
        "Failed to push image to device:",
      ),
    ).toHaveLength(1);
    expect(warn).toHaveBeenCalledWith("Failed to post notification: action unavailable", error);
  });

  test("logs missing host images and preserves the image failure", async () => {
    const imagePath = path.join(IMAGE_DIR, "missing.png");
    const result = await newNotifier(new FakeFileSystem()).execute({
      title: "Picture",
      body: "Body",
      imageType: "bigPicture",
      imagePath,
    });
    expect(result).toEqual({
      success: false,
      supported: false,
      imageType: "bigPicture",
      error: `Image file not found at ${imagePath}`,
    });
    const warnings = loggerCallsWithPrefix(
      warn.mock.calls,
      "[PostNotification]",
      "Failed to post notification:",
      "Image file not found at ",
      "Failed to push image to device:",
    );
    expect(warnings).toHaveLength(1);
    expect(warnings[0][0]).toStartWith(`Image file not found at ${imagePath}: `);
    expect(warnings[0][1]).toBeInstanceOf(Error);
    expect(fakeAdb.getExecutedCommands()).toHaveLength(0);
  });

  test("logs image push failures and preserves the image failure", async () => {
    const imagePath = path.join(IMAGE_DIR, "image.png");
    const error = new Error("push failed");
    fakeAdb.setCommandError("push ", error);
    const fileSystem = new FakeFileSystem();
    fileSystem.setBinaryFile(imagePath, PNG_BYTES);
    const result = await newNotifier(fileSystem).execute({
      title: "Picture",
      body: "Body",
      imageType: "bigPicture",
      imagePath,
    });
    expect(result).toEqual({
      success: false,
      supported: false,
      imageType: "bigPicture",
      error: "Failed to push image to device: push failed",
    });
    expect(
      loggerCallsWithPrefix(
        warn.mock.calls,
        "[PostNotification]",
        "Failed to post notification:",
        "Image file not found at ",
        "Failed to push image to device:",
      ),
    ).toHaveLength(1);
    expect(warn).toHaveBeenCalledWith("Failed to push image to device: push failed", error);
  });

  test("posts via SDK receiver when available", async () => {
    configureReceiverProbe();
    fakeAdb.setCommandResponse("am broadcast", {
      stdout: "Broadcast completed: result=1",
      stderr: "",
    });

    const postNotification = new PostNotification(device, fakeAdb as any, fakeWindow as any);
    const result = await postNotification.execute({
      title: "Hello",
      body: "World",
      actions: [{ label: "Open", actionId: "open_action" }],
    });

    expect(result.success).toBe(true);
    expect(result.supported).toBe(true);
    expect(result.method).toBe("sdk");
    expect(fakeAdb.wasCommandExecuted("am broadcast -n com.example.app")).toBe(true);
    expect(fakeAdb.wasCommandExecuted("actions_json")).toBe(true);
  });

  test("honors explicit Android appId instead of cached active window", async () => {
    fakeWindow.configureCachedActiveWindow({
      appId: "com.google.android.apps.nexuslauncher",
      activityName: "NexusLauncherActivity",
      layoutSeqSum: 1,
    } as any);
    configureReceiverProbe("dev.jasonpearson.automobile.playground");
    fakeAdb.setCommandResponse("am broadcast", {
      stdout: "Broadcast completed: result=1",
      stderr: "",
    });

    const postNotification = new PostNotification(device, fakeAdb as any, fakeWindow as any);
    const result = await postNotification.execute({
      title: "AutoMobile Test",
      body: "Body",
      appId: "dev.jasonpearson.automobile.playground",
    });

    expect(result.success).toBe(true);
    expect(result.appId).toBe("dev.jasonpearson.automobile.playground");
    expect(
      fakeAdb.wasCommandExecuted("am broadcast -n dev.jasonpearson.automobile.playground"),
    ).toBe(true);
    expect(
      fakeAdb.wasCommandExecuted("am broadcast -n com.google.android.apps.nexuslauncher"),
    ).toBe(false);
    expect(fakeWindow.getGetCachedActiveWindowCallCount()).toBe(0);
    expect(fakeWindow.getGetActiveCallCount()).toBe(0);
  });

  test("rejects invalid explicit Android appId before SDK broadcast", async () => {
    const postNotification = new PostNotification(device, fakeAdb as any, fakeWindow as any);
    const result = await postNotification.execute({
      title: "AutoMobile Test",
      body: "Body",
      appId: "dev.jasonpearson.automobile.playground; echo injected",
    });

    expect(result.success).toBe(false);
    expect(result.supported).toBe(false);
    expect(result.error).toContain("Invalid Android appId");
    expect(fakeAdb.wasCommandExecuted("am broadcast")).toBe(false);
  });

  test("refreshes active window instead of using stale cache when appId is omitted", async () => {
    fakeWindow.configureCachedActiveWindow({
      appId: "com.google.android.apps.nexuslauncher",
      activityName: "NexusLauncherActivity",
      layoutSeqSum: 1,
    } as any);
    fakeWindow.configureActiveWindow({
      appId: "dev.jasonpearson.automobile.playground",
      activityName: "MainActivity",
      layoutSeqSum: 2,
    } as any);
    configureReceiverProbe("dev.jasonpearson.automobile.playground");
    fakeAdb.setCommandResponse("am broadcast", {
      stdout: "Broadcast completed: result=1",
      stderr: "",
    });

    const postNotification = new PostNotification(device, fakeAdb as any, fakeWindow as any);
    const result = await postNotification.execute({
      title: "AutoMobile Test",
      body: "Body",
    });

    expect(result.success).toBe(true);
    expect(result.appId).toBe("dev.jasonpearson.automobile.playground");
    expect(
      fakeAdb.wasCommandExecuted("am broadcast -n dev.jasonpearson.automobile.playground"),
    ).toBe(true);
    expect(
      fakeAdb.wasCommandExecuted("am broadcast -n com.google.android.apps.nexuslauncher"),
    ).toBe(false);
    expect(fakeWindow.getGetActiveCallCount()).toBe(1);
  });

  test("fails when SDK receiver is missing", async () => {
    configureReceiverProbe();
    fakeAdb.setCommandResponse("am broadcast", {
      stdout: "Error: No receiver found",
      stderr: "",
    });

    const postNotification = new PostNotification(device, fakeAdb as any, fakeWindow as any);
    const result = await postNotification.execute({
      title: "Fallback",
      body: "Body",
    });

    expect(result.success).toBe(false);
    expect(result.supported).toBe(false);
    expect(result.error).toContain("receiver not found");
  });

  test("requires imagePath for bigPicture imageType", async () => {
    const postNotification = new PostNotification(device, fakeAdb as any, fakeWindow as any);
    const result = await postNotification.execute({
      title: "Big",
      body: "Picture",
      imageType: "bigPicture",
    });

    expect(result.success).toBe(false);
    expect(result.supported).toBe(false);
    expect(result.error).toContain("imagePath is required");
  });

  test("does not retry when SDK receiver reports failure", async () => {
    configureReceiverProbe();
    fakeAdb.setCommandResponse("am broadcast", {
      stdout: "Broadcast completed: result=0",
      stderr: "",
    });

    const postNotification = new PostNotification(device, fakeAdb as any, fakeWindow as any);
    const result = await postNotification.execute({
      title: "Fail",
      body: "Body",
    });

    expect(result.success).toBe(false);
    expect(result.supported).toBe(true);
    expect(result.method).toBe("sdk");
  });

  test("pushes host image for bigPicture imageType", async () => {
    const imagePath = path.join(IMAGE_DIR, "image.png");
    const fileSystem = new FakeFileSystem();
    fileSystem.setBinaryFile(imagePath, PNG_BYTES);
    configureBroadcastResult(1);

    const result = await newNotifier(fileSystem).execute({
      title: "Picture",
      body: "Body",
      imageType: "bigPicture",
      imagePath,
    });

    expect(result.success).toBe(true);
    expect(result.warning).toBeUndefined();
    expect(fakeAdb.wasCommandExecuted("shell mkdir -p /sdcard/Download/automobile")).toBe(true);
    expect(fakeAdb.wasCommandExecuted("push")).toBe(true);
    expect(
      fakeAdb.getCommandCalls().find((call) => call.command.startsWith("push "))?.timeoutMs,
    ).toBe(60_000);
    expect(fakeAdb.wasCommandExecuted("/sdcard/Download/automobile/image.png")).toBe(true);
    expect(fakeAdb.wasCommandExecuted("image_path")).toBe(true);
  });

  test("resolves relative bigPicture image path from daemon launch cwd", async () => {
    const launchDir = path.join(path.sep, "fake-host", "launch-cwd");
    const imagePath = path.join(launchDir, "fixtures", "pic.png");
    const fileSystem = new FakeFileSystem();
    fileSystem.setBinaryFile(imagePath, PNG_BYTES);
    process.env[DAEMON_LAUNCH_CWD_ENV] = launchDir;
    configureBroadcastResult(1);

    const result = await newNotifier(fileSystem).execute({
      title: "Picture",
      body: "Body",
      imageType: "bigPicture",
      imagePath: path.join("fixtures", "pic.png"),
    });

    expect(result.success).toBe(true);
    const pushCommand = fakeAdb
      .getExecutedCommands()
      .find((command) => command.startsWith("push "));
    expect(pushCommand?.replace(/\\\\/g, "\\")).toContain(`"${imagePath}"`);
    expect(fakeAdb.wasCommandExecuted("/sdcard/Download/automobile/pic.png")).toBe(true);
  });

  describe("host image validation (#10014)", () => {
    const bigPicture = (imagePath: string) => ({
      title: "Picture",
      body: "Body",
      imageType: "bigPicture" as const,
      imagePath,
      appId: "com.example.app",
    });

    test("rejects an empty image file without pushing or broadcasting", async () => {
      const imagePath = path.join(IMAGE_DIR, "empty.png");
      const fileSystem = new FakeFileSystem();
      fileSystem.setBinaryFile(imagePath, Buffer.alloc(0));
      const result = await newNotifier(fileSystem).execute(bigPicture(imagePath));
      expect(result.success).toBe(false);
      expect(result.error).toBe(`Image file is empty: ${imagePath}`);
      expect(fakeAdb.getExecutedCommands()).toHaveLength(0);
    });

    test("rejects a file that is not a supported image type", async () => {
      const imagePath = path.join(IMAGE_DIR, "notes.png");
      const fileSystem = new FakeFileSystem();
      fileSystem.setFile(imagePath, "fake-image-content");
      const result = await newNotifier(fileSystem).execute(bigPicture(imagePath));
      expect(result.success).toBe(false);
      expect(result.error).toContain("Unsupported image type");
      expect(result.error).toContain(imagePath);
      expect(fakeAdb.getExecutedCommands()).toHaveLength(0);
    });

    test("accepts GIF and BMP signatures that BitmapFactory can decode", async () => {
      for (const [name, bytes] of [
        ["a.gif", Buffer.from("GIF89a\0\0")],
        ["b.bmp", Buffer.from("BM\0\0\0\0")],
      ] as const) {
        const imagePath = path.join(IMAGE_DIR, name);
        const fileSystem = new FakeFileSystem();
        fileSystem.setBinaryFile(imagePath, bytes);
        configureBroadcastResult(1);
        const result = await newNotifier(fileSystem).execute(bigPicture(imagePath));
        expect(result.success).toBe(true);
      }
    });

    test("rejects a path that is not a regular file", async () => {
      class DirectoryFileSystem extends FakeFileSystem {
        async stat() {
          return { size: 4096, mtimeMs: 0, isFile: () => false };
        }
      }
      const imagePath = path.join(IMAGE_DIR, "folder");
      const result = await newNotifier(new DirectoryFileSystem()).execute(bigPicture(imagePath));
      expect(result.success).toBe(false);
      expect(result.error).toBe(`Image path is not a file: ${imagePath}`);
      expect(fakeAdb.getExecutedCommands()).toHaveLength(0);
    });

    test("reports an unreadable file as an actionable error", async () => {
      class UnreadableFileSystem extends FakeFileSystem {
        async readFileBuffer(): Promise<Buffer> {
          throw new Error("EACCES: permission denied");
        }
      }
      const imagePath = path.join(IMAGE_DIR, "locked.png");
      const fileSystem = new UnreadableFileSystem();
      fileSystem.setBinaryFile(imagePath, PNG_BYTES);
      const result = await newNotifier(fileSystem).execute(bigPicture(imagePath));
      expect(result.success).toBe(false);
      expect(result.error).toContain("not readable");
      expect(result.error).toContain("EACCES");
      expect(fakeAdb.getExecutedCommands()).toHaveLength(0);
    });
  });

  describe("imagePath without bigPicture (#10014)", () => {
    test("does not push or send image_path and warns that the image was ignored", async () => {
      configureBroadcastResult(1);
      const result = await new PostNotification(device, fakeAdb, fakeWindow).execute({
        title: "Hello",
        body: "World",
        imagePath: "./hero.png",
        appId: "com.example.app",
      });

      expect(result.success).toBe(true);
      expect(result.warning).toContain("imagePath was ignored");
      expect(result.warning).toContain("bigPicture");
      expect(fakeAdb.wasCommandExecuted("image_path")).toBe(false);
      expect(fakeAdb.wasCommandExecuted("hero.png")).toBe(false);
      expect(fakeAdb.wasCommandExecuted("push ")).toBe(false);
    });

    test("explicit normal imageType with imagePath also warns", async () => {
      configureBroadcastResult(1);
      const result = await new PostNotification(device, fakeAdb, fakeWindow).execute({
        title: "Hello",
        body: "World",
        imageType: "normal",
        imagePath: "./x.png",
        appId: "com.example.app",
      });
      expect(result.success).toBe(true);
      expect(result.warning).toContain("imagePath was ignored");
      expect(fakeAdb.wasCommandExecuted("image_path")).toBe(false);
    });

    test("no warning when imagePath is absent", async () => {
      configureBroadcastResult(1);
      const result = await new PostNotification(device, fakeAdb, fakeWindow).execute({
        title: "Hello",
        body: "World",
        appId: "com.example.app",
      });
      expect(result.success).toBe(true);
      expect(result.warning).toBeUndefined();
    });
  });

  describe("receiver result code 2: posted without image (#10014)", () => {
    test("maps result=2 to a posted result carrying a warning, not a clean success", async () => {
      const imagePath = path.join(IMAGE_DIR, "image.png");
      const fileSystem = new FakeFileSystem();
      fileSystem.setBinaryFile(imagePath, PNG_BYTES);
      configureBroadcastResult(2);
      const result = await newNotifier(fileSystem).execute({
        title: "Picture",
        body: "Body",
        imageType: "bigPicture",
        imagePath,
        appId: "com.example.app",
      });
      expect(result.success).toBe(true);
      expect(result.method).toBe("sdk");
      expect(result.warning).toContain("could not load the bigPicture image");
    });

    test("result=0 stays a failure", async () => {
      configureBroadcastResult(0);
      const failed = await new PostNotification(device, fakeAdb, fakeWindow).execute({
        title: "Hello",
        body: "World",
        appId: "com.example.app",
      });
      expect(failed.success).toBe(false);
      expect(failed.error).toBe("SDK notification receiver reported a failure.");
    });
  });

  test("reports an absent receiver without broadcasting", async () => {
    fakeAdb.setCommandResponse("cmd package query-receivers", {
      stdout: "No receivers found",
      stderr: "",
    });

    const postNotification = new PostNotification(device, fakeAdb as any, fakeWindow as any);
    const result = await postNotification.execute({ title: "Missing", body: "Receiver" });

    expect(result.success).toBe(false);
    expect(result.supported).toBe(false);
    expect(result.method).toBeUndefined();
    expect(result.error).toBe("AutoMobile notification receiver not found in the target app.");
    expect(fakeAdb.wasCommandExecuted("am broadcast")).toBe(false);
  });

  test("accepts the receiver's short-form component name", async () => {
    const appId = "dev.jasonpearson.automobile.sdk.notifications";
    fakeAdb.setCommandResponse("cmd package query-receivers", {
      stdout: `1 receivers found:\n    ${appId}/.AutoMobileNotificationReceiver`,
      stderr: "",
    });
    fakeAdb.setCommandResponse("am broadcast", {
      stdout: "Broadcast completed: result=1",
      stderr: "",
    });

    const postNotification = new PostNotification(device, fakeAdb as any, fakeWindow as any);
    const result = await postNotification.execute({
      title: "Short form",
      body: "Receiver",
      appId,
    });

    expect(result.success).toBe(true);
    expect(result.supported).toBe(true);
    expect(fakeAdb.wasCommandExecuted("am broadcast")).toBe(true);
  });

  test("does not accept another receiver from the target package", async () => {
    fakeAdb.setCommandResponse("cmd package query-receivers", {
      stdout: "1 receivers found:\n    com.example.app/.SomeOtherReceiver",
      stderr: "",
    });

    const postNotification = new PostNotification(device, fakeAdb as any, fakeWindow as any);
    const result = await postNotification.execute({ title: "Other", body: "Receiver" });

    expect(result).toEqual({
      success: false,
      supported: false,
      imageType: "normal",
      appId: "com.example.app",
      error: "AutoMobile notification receiver not found in the target app.",
    });
    expect(fakeAdb.wasCommandExecuted("am broadcast")).toBe(false);
  });

  test("broadcast failure is reported after the probe confirms the receiver", async () => {
    configureReceiverProbe();
    fakeAdb.setCommandResponse("am broadcast", {
      stdout: "Broadcast completed: result=0",
      stderr: "",
    });

    const postNotification = new PostNotification(device, fakeAdb as any, fakeWindow as any);
    const result = await postNotification.execute({ title: "Fail", body: "Broadcast" });

    expect(result).toEqual({
      success: false,
      supported: true,
      method: "sdk",
      imageType: "normal",
      appId: "com.example.app",
      error: "SDK notification receiver reported a failure.",
    });
  });

  test("broadcast success is returned after the probe confirms the receiver", async () => {
    configureReceiverProbe();
    fakeAdb.setCommandResponse("am broadcast", {
      stdout: "Broadcast completed: result=1",
      stderr: "",
    });

    const postNotification = new PostNotification(device, fakeAdb as any, fakeWindow as any);
    const result = await postNotification.execute({ title: "Success", body: "Broadcast" });

    expect(result.success).toBe(true);
    expect(result.supported).toBe(true);
    expect(result.method).toBe("sdk");
  });

  test("falls back to broadcast when the receiver probe fails", async () => {
    fakeAdb.setCommandError("cmd package query-receivers", new Error("unsupported command"));
    fakeAdb.setCommandResponse("am broadcast", {
      stdout: "Broadcast completed: result=1",
      stderr: "",
    });

    const postNotification = new PostNotification(device, fakeAdb as any, fakeWindow as any);
    const result = await postNotification.execute({ title: "Fallback", body: "Broadcast" });

    expect(result.success).toBe(true);
    expect(result.supported).toBe(true);
    expect(result.method).toBe("sdk");
    expect(fakeAdb.wasCommandExecuted("am broadcast")).toBe(true);
  });

  test("falls back to broadcast when the receiver probe output is unknown", async () => {
    fakeAdb.setCommandResponse("cmd package query-receivers", {
      stdout: "Unknown command: query-receivers",
      stderr: "",
    });
    fakeAdb.setCommandResponse("am broadcast", {
      stdout: "Broadcast completed: result=1",
      stderr: "",
    });

    const postNotification = new PostNotification(device, fakeAdb as any, fakeWindow as any);
    const result = await postNotification.execute({ title: "Fallback", body: "Broadcast" });

    expect(result.success).toBe(true);
    expect(result.supported).toBe(true);
    expect(result.method).toBe("sdk");
    expect(fakeAdb.wasCommandExecuted("am broadcast")).toBe(true);
  });
});
