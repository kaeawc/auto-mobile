import { describe, expect, test } from "bun:test";
import { DeviceCtlClient, type DeviceCtlDependencies } from "../../../src/utils/ios-cmdline-tools/DeviceCtlClient";
import type { ExecResult } from "../../../src/models";

const execResult = (stdout = ""): ExecResult => ({
  stdout,
  stderr: "",
  toString: () => stdout,
  trim: () => stdout.trim(),
  includes: (value: string) => stdout.includes(value),
});

interface Harness {
  client: DeviceCtlClient;
  commands: string[];
}

const makeClient = (overrides: Partial<DeviceCtlDependencies> = {}): Harness => {
  const commands: string[] = [];
  const deps: DeviceCtlDependencies = {
    platform: () => "darwin",
    exec: async (command: string) => {
      commands.push(command);
      return execResult();
    },
    hostControl: {
      shouldUseHostControl: () => false,
      isRunningInDocker: () => false,
    },
    ...overrides,
  };
  return { client: new DeviceCtlClient(deps), commands };
};

describe("DeviceCtlClient.isAvailable", () => {
  test("returns false on a non-darwin host without probing", async () => {
    const { client, commands } = makeClient({ platform: () => "linux" });
    expect(await client.isAvailable()).toBe(false);
    expect(commands).toHaveLength(0);
  });

  test("returns true on darwin when `devicectl --version` succeeds", async () => {
    const { client, commands } = makeClient();
    expect(await client.isAvailable()).toBe(true);
    expect(commands[0]).toContain("devicectl");
    expect(commands[0]).toContain("--version");
  });

  test("returns false on darwin when the devicectl probe throws", async () => {
    const { client } = makeClient({
      exec: async () => { throw new Error("xcrun: devicectl not found"); },
    });
    expect(await client.isAvailable()).toBe(false);
  });

  test("reports available under host control so the caller reaches the explicit launch error", async () => {
    const { client, commands } = makeClient({
      platform: () => "linux",
      hostControl: { shouldUseHostControl: () => true, isRunningInDocker: () => true },
    });
    expect(await client.isAvailable()).toBe(true);
    expect(commands).toHaveLength(0);
  });
});

describe("DeviceCtlClient.launchWithPayloadUrl", () => {
  test("builds the devicectl command: device unquoted, url + bundle quoted, terminate-existing", async () => {
    const { client, commands } = makeClient();
    await client.launchWithPayloadUrl("00008110-000A4D", "com.apple.mobilesafari", "https://example.com/order/123");

    expect(commands).toHaveLength(1);
    const cmd = commands[0];
    expect(cmd).toContain("xcrun devicectl device process launch");
    expect(cmd).toContain("--device 00008110-000A4D");
    expect(cmd).toContain("--payload-url 'https://example.com/order/123'");
    expect(cmd).toContain("--terminate-existing");
    expect(cmd).toContain("'com.apple.mobilesafari'");
  });

  test("single-quote-escapes a url to prevent shell injection", async () => {
    const { client, commands } = makeClient();
    await client.launchWithPayloadUrl("udid", "com.apple.mobilesafari", "https://x/'; rm -rf /");
    expect(commands[0]).toContain("--payload-url 'https://x/'\\''; rm -rf /'");
  });

  test("throws an explicit macOS error on a non-darwin host", async () => {
    const { client, commands } = makeClient({ platform: () => "linux" });
    await expect(
      client.launchWithPayloadUrl("udid", "com.apple.mobilesafari", "https://example.com")
    ).rejects.toThrow(/macOS/);
    expect(commands).toHaveLength(0);
  });

  test("throws an explicit host-control error under Docker host control", async () => {
    const { client, commands } = makeClient({
      hostControl: { shouldUseHostControl: () => true, isRunningInDocker: () => true },
    });
    await expect(
      client.launchWithPayloadUrl("udid", "com.apple.mobilesafari", "https://example.com")
    ).rejects.toThrow(/host control/i);
    expect(commands).toHaveLength(0);
  });

  test("propagates an underlying devicectl exec failure", async () => {
    const { client } = makeClient({
      exec: async () => { throw new Error("device locked"); },
    });
    await expect(
      client.launchWithPayloadUrl("udid", "com.apple.mobilesafari", "https://example.com")
    ).rejects.toThrow(/device locked/);
  });
});
