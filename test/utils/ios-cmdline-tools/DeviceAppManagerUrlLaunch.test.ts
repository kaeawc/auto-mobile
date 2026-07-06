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

interface HostControlOverrides {
  shouldUseHostControl?: () => boolean;
  isRunningInDocker?: () => boolean;
}

interface Overrides {
  platform?: () => NodeJS.Platform;
  exec?: (command: string) => Promise<ExecResult>;
  hostControl?: HostControlOverrides;
}

interface Harness {
  inspector: DeviceAppManager;
  commands: string[];
}

// Build a DeviceAppManager wired for the URL-launch surface only. The
// open-URL primitive (isAvailable / launchWithPayloadUrl) touches nothing but
// `platform`, `exec`, and the two host-control flags, so the file/temp deps are
// stubbed to throw — any use would be a real regression the test should catch.
const makeInspector = (overrides: Overrides = {}): Harness => {
  const commands: string[] = [];
  const unused = () => { throw new Error("unexpected filesystem dependency use in URL-launch path"); };
  const inspector = new DeviceAppManager({
    platform: overrides.platform ?? (() => "darwin"),
    exec: overrides.exec ?? (async (command: string) => {
      commands.push(command);
      return execResult();
    }),
    readFile: unused,
    mkdtemp: unused,
    rm: unused,
    readdir: unused,
    stat: unused,
    tmpdir: () => "/tmp",
    logger: { debug: () => {}, warn: () => {} },
    hostControl: {
      shouldUseHostControl: overrides.hostControl?.shouldUseHostControl ?? (() => false),
      isRunningInDocker: overrides.hostControl?.isRunningInDocker ?? (() => false),
      isAvailable: async () => false,
      getAppBundleHash: async () => ({ success: false }),
      uninstallApp: async () => ({ success: false }),
      installApp: async () => ({ success: false }),
    },
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
    expect(commands[0]).toContain("devicectl");
    expect(commands[0]).toContain("--version");
  });

  test("returns false on darwin when the devicectl probe throws", async () => {
    const { inspector } = makeInspector({
      exec: async () => { throw new Error("xcrun: devicectl not found"); },
    });
    expect(await inspector.isUrlLaunchAvailable()).toBe(false);
  });

  test("reports available under host control so the caller reaches the explicit launch error", async () => {
    const { inspector, commands } = makeInspector({
      platform: () => "linux",
      hostControl: { shouldUseHostControl: () => true, isRunningInDocker: () => true },
    });
    expect(await inspector.isUrlLaunchAvailable()).toBe(true);
    expect(commands).toHaveLength(0);
  });
});

describe("DeviceAppManager.launchWithPayloadUrl", () => {
  test("builds the devicectl command: device unquoted, url + bundle quoted, terminate-existing", async () => {
    const { inspector, commands } = makeInspector();
    await inspector.launchWithPayloadUrl("00008110-000A4D", "com.apple.mobilesafari", "https://example.com/order/123");

    expect(commands).toHaveLength(1);
    const cmd = commands[0];
    expect(cmd).toContain("xcrun devicectl device process launch");
    expect(cmd).toContain("--device 00008110-000A4D");
    expect(cmd).toContain("--payload-url 'https://example.com/order/123'");
    expect(cmd).toContain("--terminate-existing");
    expect(cmd).toContain("'com.apple.mobilesafari'");
  });

  test("single-quote-escapes a url to prevent shell injection", async () => {
    const { inspector, commands } = makeInspector();
    await inspector.launchWithPayloadUrl("udid", "com.apple.mobilesafari", "https://x/'; rm -rf /");
    expect(commands[0]).toContain("--payload-url 'https://x/'\\''; rm -rf /'");
  });

  test("throws an explicit macOS ActionableError on a non-darwin host", async () => {
    const { inspector, commands } = makeInspector({ platform: () => "linux" });
    await expect(
      inspector.launchWithPayloadUrl("udid", "com.apple.mobilesafari", "https://example.com")
    ).rejects.toThrow(/macOS/);
    await expect(
      inspector.launchWithPayloadUrl("udid", "com.apple.mobilesafari", "https://example.com")
    ).rejects.toBeInstanceOf(ActionableError);
    expect(commands).toHaveLength(0);
  });

  test("throws an explicit host-control ActionableError under Docker host control", async () => {
    const { inspector, commands } = makeInspector({
      hostControl: { shouldUseHostControl: () => true, isRunningInDocker: () => true },
    });
    await expect(
      inspector.launchWithPayloadUrl("udid", "com.apple.mobilesafari", "https://example.com")
    ).rejects.toThrow(/host control/i);
    await expect(
      inspector.launchWithPayloadUrl("udid", "com.apple.mobilesafari", "https://example.com")
    ).rejects.toBeInstanceOf(ActionableError);
    expect(commands).toHaveLength(0);
  });

  test("wraps an underlying devicectl exec failure in an ActionableError with context", async () => {
    const { inspector } = makeInspector({
      exec: async () => { throw new Error("device locked"); },
    });
    const thrown = await inspector
      .launchWithPayloadUrl("udid", "com.apple.mobilesafari", "https://example.com")
      .then(() => { throw new Error("expected reject"); }, (e: unknown) => e);
    expect(thrown).toBeInstanceOf(ActionableError);
    // Underlying diagnostic preserved …
    expect((thrown as Error).message).toContain("device locked");
    // … plus actionable context (which app/what failed).
    expect((thrown as Error).message).toContain("com.apple.mobilesafari");
  });
});
