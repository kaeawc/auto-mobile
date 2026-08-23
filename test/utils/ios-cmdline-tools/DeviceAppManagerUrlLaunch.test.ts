import { describe, expect, test } from "bun:test";
import { DeviceAppManager } from "../../../src/utils/ios-cmdline-tools/DeviceAppManager";
import { ActionableError } from "../../../src/models/ActionableError";
import type { ExecResult } from "../../../src/models";

const execResult = (stdout = ""): ExecResult => ({
  stdout,
  stderr: "",
  toString: () => stdout,
  trim: () => stdout.trim(),
  includes: (value: string) => stdout.includes(value),
});

interface Overrides {
  platform?: () => NodeJS.Platform;
  execute?: (file: string, args: string[]) => Promise<ExecResult>;
}

interface Harness {
  inspector: DeviceAppManager;
  commands: string[][];
}

// Build a DeviceAppManager wired for the URL-launch surface only. The
// open-URL primitive (isAvailable / launchWithPayloadUrl) touches nothing but
// `platform` and argv executor, so the file/temp deps are stubbed to throw — any use
// would be a real regression the test should catch.
const makeInspector = (overrides: Overrides = {}): Harness => {
  const commands: string[][] = [];
  const unused = () => {
    throw new Error("unexpected filesystem dependency use in URL-launch path");
  };
  const inspector = new DeviceAppManager({
    platform: overrides.platform ?? (() => "darwin"),
    execute:
      overrides.execute ??
      (async (file: string, args: string[]) => {
        commands.push([file, ...args]);
        return execResult();
      }),
    readFile: unused,
    mkdtemp: unused,
    rm: unused,
    readdir: unused,
    stat: unused,
    tmpdir: () => "/tmp",
    logger: { debug: () => {}, warn: () => {} },
  });
  return { inspector, commands };
};

describe("DeviceAppManager.isUrlLaunchAvailable", () => {
  test("returns false on a non-darwin host without probing", async () => {
    const { inspector, commands } = makeInspector({ platform: () => "linux" });
    expect(await inspector.isUrlLaunchAvailable()).toBe(false);
    expect(commands).toHaveLength(0);
  });

  test("returns true on darwin when `devicectl --version` succeeds", async () => {
    const { inspector, commands } = makeInspector();
    expect(await inspector.isUrlLaunchAvailable()).toBe(true);
    expect(commands[0]).toEqual(["xcrun", "devicectl", "--version"]);
  });

  test("returns false on darwin when the devicectl probe throws", async () => {
    const { inspector } = makeInspector({
      execute: async () => {
        throw new Error("xcrun: devicectl not found");
      },
    });
    expect(await inspector.isUrlLaunchAvailable()).toBe(false);
  });
});

describe("DeviceAppManager.launchWithPayloadUrl", () => {
  test("passes device, URL, and bundle id as argv", async () => {
    const { inspector, commands } = makeInspector();
    await inspector.launchWithPayloadUrl(
      "00008110-000A4D",
      "com.apple.mobilesafari",
      "https://example.com/order/123",
    );

    expect(commands).toHaveLength(1);
    expect(commands[0]).toEqual([
      "xcrun",
      "devicectl",
      "device",
      "process",
      "launch",
      "--device",
      "00008110-000A4D",
      "--payload-url",
      "https://example.com/order/123",
      "--terminate-existing",
      "com.apple.mobilesafari",
    ]);
  });

  test("keeps shell-like URL content inside one argv value", async () => {
    const { inspector, commands } = makeInspector();
    await inspector.launchWithPayloadUrl("udid", "com.apple.mobilesafari", "https://x/'; rm -rf /");
    expect(commands[0]).toContain("https://x/'; rm -rf /");
    expect(commands[0]).toHaveLength(11);
  });

  test("throws an explicit macOS ActionableError on a non-darwin host", async () => {
    const { inspector, commands } = makeInspector({ platform: () => "linux" });
    await expect(
      inspector.launchWithPayloadUrl("udid", "com.apple.mobilesafari", "https://example.com"),
    ).rejects.toThrow(/macOS/);
    await expect(
      inspector.launchWithPayloadUrl("udid", "com.apple.mobilesafari", "https://example.com"),
    ).rejects.toBeInstanceOf(ActionableError);
    expect(commands).toHaveLength(0);
  });

  test("wraps an underlying devicectl exec failure in an ActionableError with context", async () => {
    const { inspector } = makeInspector({
      execute: async () => {
        throw new Error("device locked");
      },
    });
    const thrown = await inspector
      .launchWithPayloadUrl("udid", "com.apple.mobilesafari", "https://example.com")
      .then(
        () => {
          throw new Error("expected reject");
        },
        (e: unknown) => e,
      );
    expect(thrown).toBeInstanceOf(ActionableError);
    // Underlying diagnostic preserved …
    expect((thrown as Error).message).toContain("device locked");
    // … plus actionable context (which app/what failed).
    expect((thrown as Error).message).toContain("com.apple.mobilesafari");
  });
});
