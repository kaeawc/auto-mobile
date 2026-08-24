import { expect, describe, test, beforeEach, afterEach } from "bun:test";
import { PostNotification } from "../../../src/features/utility/PostNotification";
import { FakeAdbExecutor } from "../../fakes/FakeAdbExecutor";
import { FakeWindow } from "../../fakes/FakeWindow";
import { BootedDevice } from "../../../src/models";
import { mkdir, mkdtemp, rm, writeFile } from "fs/promises";
import os from "os";
import path from "path";
import { DAEMON_LAUNCH_CWD_ENV } from "../../../src/utils/workingDirectory";

describe("PostNotification", () => {
  let device: BootedDevice;
  let fakeAdb: FakeAdbExecutor;
  let fakeWindow: FakeWindow;
  const originalLaunchCwd = process.env[DAEMON_LAUNCH_CWD_ENV];

  beforeEach(() => {
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
    if (originalLaunchCwd === undefined) {
      delete process.env[DAEMON_LAUNCH_CWD_ENV];
    } else {
      process.env[DAEMON_LAUNCH_CWD_ENV] = originalLaunchCwd;
    }
  });

  test("posts via SDK receiver when available", async () => {
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
    const tmpDir = await mkdtemp(path.join(os.tmpdir(), "automobile-notif-"));
    const imagePath = path.join(tmpDir, "image.png");
    await writeFile(imagePath, "fake-image-content");

    fakeAdb.setCommandResponse("am broadcast", {
      stdout: "Broadcast completed: result=1",
      stderr: "",
    });

    const postNotification = new PostNotification(device, fakeAdb as any, fakeWindow as any);
    const result = await postNotification.execute({
      title: "Picture",
      body: "Body",
      imageType: "bigPicture",
      imagePath,
    });

    try {
      expect(result.success).toBe(true);
      expect(fakeAdb.wasCommandExecuted("shell mkdir -p /sdcard/Download/automobile")).toBe(true);
      expect(fakeAdb.wasCommandExecuted("push")).toBe(true);
      expect(fakeAdb.wasCommandExecuted("/sdcard/Download/automobile/image.png")).toBe(true);
      expect(fakeAdb.wasCommandExecuted("image_path")).toBe(true);
    } finally {
      await rm(tmpDir, { recursive: true, force: true });
    }
  });

  test("resolves relative bigPicture image path from daemon launch cwd", async () => {
    const tmpDir = await mkdtemp(path.join(os.tmpdir(), "automobile-notif-launch-cwd-"));
    const fixturesDir = path.join(tmpDir, "fixtures");
    const imagePath = path.join(fixturesDir, "pic.png");
    await mkdir(fixturesDir, { recursive: true });
    await writeFile(imagePath, "fake-image-content");
    process.env[DAEMON_LAUNCH_CWD_ENV] = tmpDir;

    fakeAdb.setCommandResponse("am broadcast", {
      stdout: "Broadcast completed: result=1",
      stderr: "",
    });

    const postNotification = new PostNotification(device, fakeAdb as any, fakeWindow as any);
    const result = await postNotification.execute({
      title: "Picture",
      body: "Body",
      imageType: "bigPicture",
      imagePath: path.join("fixtures", "pic.png"),
    });

    try {
      expect(result.success).toBe(true);
      const pushCommand = fakeAdb
        .getExecutedCommands()
        .find((command) => command.startsWith("push "));
      expect(pushCommand?.replace(/\\\\/g, "\\")).toContain(`"${imagePath}"`);
      expect(fakeAdb.wasCommandExecuted("/sdcard/Download/automobile/pic.png")).toBe(true);
    } finally {
      await rm(tmpDir, { recursive: true, force: true });
    }
  });
});
