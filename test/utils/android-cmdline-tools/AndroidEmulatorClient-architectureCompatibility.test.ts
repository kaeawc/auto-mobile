import { describe, expect, test } from "bun:test";
import { AndroidEmulatorClient } from "../../../src/utils/android-cmdline-tools/AndroidEmulatorClient";
import type { AvdConfig } from "../../../src/utils/android-cmdline-tools/AvdConfigReader";
import type { ExecResult } from "../../../src/models";
import { FakeAvdConfigReader } from "../../fakes/FakeAvdConfigReader";
import { FakeTimer } from "../../fakes/FakeTimer";

interface ArchitectureCompatibilityResult {
  compatible: boolean;
  hostArch: string;
  avdArch?: string;
  reason?: string;
}

interface ArchitectureCompatibilityClient {
  checkArchitectureCompatibility(avdName: string): Promise<ArchitectureCompatibilityResult>;
}

const result = (): ExecResult => ({
  stdout: "",
  stderr: "",
  toString: () => "",
  trim: () => "",
  includes: () => false,
});

function createClient(config: AvdConfig | null, hostArchitecture: string) {
  const commandCalls: string[][] = [];
  const reader = new FakeAvdConfigReader(config);
  const client = new AndroidEmulatorClient(
    async (_file, args) => {
      commandCalls.push(args);
      return result();
    },
    null,
    new FakeTimer(),
    undefined,
    reader,
    "linux",
    hostArchitecture,
  );
  (client as unknown as { ensureEmulatorPath: () => Promise<string> }).ensureEmulatorPath =
    async () => "emulator";

  return {
    client: client as unknown as ArchitectureCompatibilityClient,
    commandCalls,
    reader,
  };
}

describe("AndroidEmulatorClient architecture compatibility", () => {
  test("reads compatible AVD architecture from config without launching an emulator probe", async () => {
    const { client, commandCalls, reader } = createClient({ architecture: "arm64-v8a" }, "arm64");

    const compatibility = await client.checkArchitectureCompatibility("Pixel_9");

    expect(compatibility.compatible).toBe(true);
    expect(compatibility.hostArch).toBe("arm64");
    expect(compatibility.avdArch).toBe("arm64-v8a");
    expect(reader.readConfigCalls).toEqual(["Pixel_9"]);
    expect(commandCalls).toEqual([]);
  });

  test("rejects an incompatible configured architecture without spawning a probe", async () => {
    const { client, commandCalls } = createClient({ architecture: "x86_64" }, "arm64");

    const compatibility = await client.checkArchitectureCompatibility("Pixel_9");

    expect(compatibility.compatible).toBe(false);
    expect(compatibility.reason).toContain("x86_64");
    expect(commandCalls).toEqual([]);
  });

  test("allows launch when config architecture is unavailable without spawning a probe", async () => {
    const { client, commandCalls, reader } = createClient(null, "arm64");

    const compatibility = await client.checkArchitectureCompatibility("Pixel_9");

    expect(compatibility.compatible).toBe(true);
    expect(compatibility.avdArch).toBeUndefined();
    expect(reader.readConfigCalls).toEqual(["Pixel_9"]);
    expect(commandCalls).toEqual([]);
  });
});
