import { describe, expect, test } from "bun:test";
import { PostNotification } from "../../../src/features/utility/PostNotification";
import type { BootedDevice } from "../../../src/models";
import {
  SimCtlClient,
  type SimCtlFileSystem,
} from "../../../src/utils/ios-cmdline-tools/SimCtlClient";
import { createExecResult } from "../../../src/utils/execResult";
import { checkPostNotificationPlatformConstraints } from "../../../src/server/notificationTools";
import {
  APPLE_PLATFORM_SUPPORTED_TOOLS,
  assertToolSupportsDevicePlatform,
} from "../../../src/server/applePlatformToolSupport";

import { loadTvosSimctlFixture } from "../../helpers/tvosSimctlFixtures";

// `simctl push` on a tvOS 26.5 Apple TV simulator, captured in #17526.
const capture = loadTvosSimctlFixture("push");
// Bundle ID used in the capture.
const BUNDLE = "dev.jasonpearson.automobile.ctrlproxy.tv";

const TV_UDID = "5B7E1C3D-2A4F-4E6B-8C9D-1E2F3A4B5C6D";
const tv: BootedDevice = { name: "Apple TV 4K", deviceId: TV_UDID, platform: "tvos" };

function memoryFileSystem(): SimCtlFileSystem & { writes: Map<string, string> } {
  const writes = new Map<string, string>();
  return {
    writes,
    mkdtemp: async (prefix: string) => `${prefix}fake`,
    writeFile: async (path: string, data: string) => {
      writes.set(path, data);
    },
    readFile: async (path: string) => writes.get(path) ?? "",
    readFileBuffer: async (path: string) => Buffer.from(writes.get(path) ?? ""),
    rm: async () => {},
  };
}

function simctlWithPushResult(push: () => ReturnType<typeof createExecResult>) {
  const calls: Array<{ file: string; args: string[] }> = [];
  const fileSystem = memoryFileSystem();
  const execAsync = async (file: string, args: string[]) => {
    calls.push({ file, args });
    if (args.join(" ") === "simctl --version") {
      return createExecResult("simctl version 1.0.0", "");
    }
    if (args.includes("log")) {
      throw new Error("tvOS must not read notification delivery logs");
    }
    return args[1] === "push" ? push() : createExecResult("", "");
  };
  const simctl = new SimCtlClient(tv, execAsync, { fileSystem, platform: "darwin" });
  return {
    simctl,
    fileSystem,
    logCalls: () => calls.filter(({ args }) => args.includes("log")),
    pushCalls: () => calls.filter(({ args }) => args[1] === "push"),
  };
}

describe("postNotification on an Apple TV simulator (#17526)", () => {
  test("is on the tvOS allowlist and requires a bundle ID", () => {
    expect(APPLE_PLATFORM_SUPPORTED_TOOLS.tvos.has("postNotification")).toBe(true);
    expect(() => assertToolSupportsDevicePlatform("postNotification", tv)).not.toThrow();
    expect(checkPostNotificationPlatformConstraints("tvos", {})).toEqual({
      path: "appId",
      message: "appId is required when platform is tvos",
    });
  });

  test("pushes the APNs payload with simctl push and reports the captured delivery", async () => {
    const { simctl, fileSystem, pushCalls, logCalls } = simctlWithPushResult(() =>
      createExecResult(capture.stdout, capture.stderr),
    );
    const notificationAuthorization = {
      read: async () => {
        throw new Error("tvOS must not read the iOS BulletinBoard store");
      },
    };

    const result = await new PostNotification(tv, { simctl, notificationAuthorization }).execute({
      title: "x",
      body: "y",
      appId: BUNDLE,
    });

    expect(capture.exitCode).toBe(0);
    expect(capture.stderr).toBe("");
    expect(result).toEqual({
      success: true,
      supported: true,
      method: "simctlPush",
      appId: BUNDLE,
      channelId: undefined,
      warning: undefined,
    });
    expect(pushCalls()).toHaveLength(1);
    expect(logCalls()).toHaveLength(0);
    const { file, args } = pushCalls()[0];
    const payloadPath = args[4];
    // The capture used stdin ("-"); production supplies the equivalent APNs file.
    expect(file).toBe("xcrun");
    expect(args).toEqual(["simctl", "push", TV_UDID, BUNDLE, payloadPath]);
    expect(payloadPath.endsWith("payload.apns")).toBe(true);
    expect(JSON.parse(fileSystem.writes.get(payloadPath) ?? "{}")).toMatchObject({
      aps: { alert: { title: "x", body: "y" } },
      "Simulator Target Bundle": BUNDLE,
    });
  });

  test("requires appId before pushing and names tvOS", async () => {
    const { simctl, pushCalls } = simctlWithPushResult(() => createExecResult("", ""));

    const result = await new PostNotification(tv, { simctl }).execute({ title: "T", body: "B" });

    expect(result.error).toBe(
      "appId (bundle identifier) is required to post a notification on tvOS.",
    );
    expect(pushCalls()).toEqual([]);
  });

  test("a failed push is reported as a failure", async () => {
    const { simctl } = simctlWithPushResult(() => {
      throw new Error("Invalid device: Apple TV");
    });

    const result = await new PostNotification(tv, { simctl }).execute({
      title: "T",
      body: "B",
      appId: BUNDLE,
    });

    expect(result.success).toBe(false);
    expect(result.supported).toBe(true);
    expect(result.error).toContain("Invalid device: Apple TV");
  });
});
