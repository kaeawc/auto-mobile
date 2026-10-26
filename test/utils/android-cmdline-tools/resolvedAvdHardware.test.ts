import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  FileAvdConfigReader,
  parseAvdConfig,
  parseResolvedAvdHardware,
} from "../../../src/utils/android-cmdline-tools/AvdConfigReader";

const FIXTURES = join(import.meta.dir, "../../fixtures/android-avd-hardware-qemu");
const fixture = (name: string) => readFileSync(join(FIXTURES, name), "utf8");

// Captured from real AVDs: every one had `hw.ramSize=2G` in config.ini (#15475).
describe("resolved AVD hardware from hardware-qemu.ini", () => {
  test.each([
    ["api30-google_apis.hardware-qemu.ini", 2048],
    ["api36-google_apis.hardware-qemu.ini", 2560],
    ["api37-google_apis.hardware-qemu.ini", 4096],
  ])("%s resolves %d MB, four vCPUs and a software renderer", (name, ramMb) => {
    expect(parseResolvedAvdHardware(fixture(name))).toEqual({
      ramMb,
      cpuCores: 4,
      gpuMode: "lavapipe",
    });
  });

  test("the configured value is a different number from the resolved one", () => {
    const configured = parseAvdConfig("hw.ramSize=2G\nhw.cpu.ncore=4\n");
    expect(configured.ramSizeMb).toBe(2048);
    expect(parseResolvedAvdHardware(fixture("api37-google_apis.hardware-qemu.ini")).ramMb).toBe(
      4096,
    );
  });

  test("missing, zero and non-numeric values are left out rather than guessed", () => {
    expect(parseResolvedAvdHardware("")).toEqual({});
    expect(
      parseResolvedAvdHardware("hw.ramSize = 0\nhw.cpu.ncore = four\nhw.gpu.mode =\n"),
    ).toEqual({});
    expect(parseResolvedAvdHardware("# comment\nhw.ramSize = 2G\n")).toEqual({});
  });
});

describe("FileAvdConfigReader.readResolvedHardware", () => {
  function reader(files: Record<string, string>) {
    return new FileAvdConfigReader(
      async (path) => {
        const content = files[path];
        if (content === undefined) throw new Error(`ENOENT ${path}`);
        return content;
      },
      (path) => path in files || path === "/avd/Pixel.avd",
      "/avd",
    );
  }

  test("reads the file beside config.ini", async () => {
    const files = {
      "/avd/Pixel.avd/hardware-qemu.ini": fixture("api36-google_apis.hardware-qemu.ini"),
    };
    expect(await reader(files).readResolvedHardware("Pixel")).toMatchObject({ ramMb: 2560 });
  });

  test("an AVD that never launched has no resolved hardware", async () => {
    expect(await reader({}).readResolvedHardware("Pixel")).toBeNull();
    expect(await reader({}).readResolvedHardware("Missing")).toBeNull();
  });
});
