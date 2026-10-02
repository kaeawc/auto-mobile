import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { DeviceAppManager } from "../../../src/utils/ios-cmdline-tools/DeviceAppManager";
import { ActionableError } from "../../../src/models/ActionableError";
import type { ExecResult } from "../../../src/models";
import type { HostCommandOptions } from "../../../src/utils/HostCommandExecutor";
import { throwIfAborted } from "../../../src/utils/toolUtils";

const execResult = (stdout = ""): ExecResult => ({
  stdout,
  stderr: "",
  toString: () => stdout,
  trim: () => stdout.trim(),
  includes: (value: string) => stdout.includes(value),
});

interface Overrides {
  platform?: () => NodeJS.Platform;
  execute?: (file: string, args: string[], options?: HostCommandOptions) => Promise<ExecResult>;
}

interface Harness {
  inspector: DeviceAppManager;
  commands: string[][];
}

// These command paths touch only `platform` and argv execution, so file/temp
// dependencies throw if used unexpectedly.
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

describe("DeviceAppManager.getDevicectlVersion", () => {
  test("returns command stdout through the injected executor", async () => {
    const capturedVersion = readFileSync(
      join(process.cwd(), "test/fixtures/ios-devicectl/version.txt"),
      "utf8",
    );
    const commands: string[][] = [];
    const { inspector } = makeInspector({
      execute: async (file, args) => {
        commands.push([file, ...args]);
        return execResult(capturedVersion);
      },
    });

    expect(await inspector.getDevicectlVersion()).toBe(capturedVersion);
    expect(commands).toEqual([["xcrun", "devicectl", "--version"]]);
  });
});

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
  test("pre-aborted launch never executes devicectl", async () => {
    const { inspector, commands } = makeInspector();
    const controller = new AbortController();
    controller.abort();
    await expect(
      inspector.launchWithPayloadUrl(
        "udid",
        "com.apple.mobilesafari",
        "https://example.com",
        controller.signal,
      ),
    ).rejects.toThrow("Operation cancelled");
    expect(commands).toEqual([]);
  }, 100);

  test("launch forwards host command cancellation without wrapping it", async () => {
    const controller = new AbortController();
    let received: HostCommandOptions | undefined;
    const started = Promise.withResolvers<void>();
    const failure = Promise.withResolvers<ExecResult>();
    const { inspector } = makeInspector({
      execute: async (_file, _args, options) => {
        received = options;
        controller.signal.addEventListener(
          "abort",
          () => {
            try {
              throwIfAborted(controller.signal);
            } catch (error) {
              failure.reject(error);
            }
          },
          { once: true },
        );
        started.resolve();
        return failure.promise;
      },
    });
    const pending = inspector.launchWithPayloadUrl(
      "udid",
      "com.apple.mobilesafari",
      "https://example.com",
      controller.signal,
    );
    await started.promise;
    controller.abort();
    await expect(pending).rejects.toThrow(/^Operation cancelled$/);
    expect(received?.signal).toBe(controller.signal);
  }, 100);

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
