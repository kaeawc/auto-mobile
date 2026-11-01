import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  AvdFixtureIdentityProbe,
  type AvdFixtureIdentityDeps,
} from "../../../src/features/snapshot/avdFixtureIdentityProbe";
import type { AvdConfig } from "../../../src/utils/android-cmdline-tools/AvdConfigReader";

const sha = (text: string) => createHash("sha256").update(text).digest("hex");

/** Stateful fakes for every host read the probe makes. */
function fakeDeps(overrides: Partial<AvdFixtureIdentityDeps> = {}) {
  const files = new Map<string, { ino: number; birthtimeMs: number }>([
    ["/avd/pixel.avd/userdata-qemu.img", { ino: 42, birthtimeMs: 1_730_000_000_000 }],
  ]);
  const config: AvdConfig = {
    systemImagePackage: "system-images;android-35;google_apis;arm64-v8a",
    systemImagePath: "system-images/android-35/google_apis/arm64-v8a/",
    hardware: { "hw.ramSize": "2048" } as AvdConfig["hardware"],
  };
  const deps: AvdFixtureIdentityDeps = {
    config: { readConfig: async (name) => (name === "pixel" ? config : null) },
    avdDirectory: {
      resolveAvdDirectory: async (name) => (name === "pixel" ? "/avd/pixel.avd" : null),
    },
    imageMetadata: async () => "Pkg.Revision=7\n",
    emulatorVersion: async () => "Android emulator version 35.2.10.0 (build_id 123)\nCopyright",
    fileIdentity: async (path) => files.get(path) ?? null,
    ...overrides,
  };
  return { deps, files, config };
}

describe("AvdFixtureIdentityProbe (#14065)", () => {
  test("reads image, config, emulator version and userdata generation for the AVD", async () => {
    const { deps, config } = fakeDeps();
    expect(await new AvdFixtureIdentityProbe(deps).currentIdentity("pixel")).toEqual({
      avdName: "pixel",
      systemImageId: `system-images;android-35;google_apis;arm64-v8a:${sha("Pkg.Revision=7\n")}`,
      avdConfigHash: sha(JSON.stringify(config.hardware)),
      emulatorVersion: "Android emulator version 35.2.10.0 (build_id 123)",
      userdataGeneration: `42:${1_730_000_000_000}`,
    });
  });

  test("a re-created userdata image (as -wipe-data does) changes only the userdata generation", async () => {
    const { deps, files } = fakeDeps();
    const probe = new AvdFixtureIdentityProbe(deps);
    const before = await probe.currentIdentity("pixel");
    files.set("/avd/pixel.avd/userdata-qemu.img", { ino: 77, birthtimeMs: 1_730_000_500_000 });
    const after = await probe.currentIdentity("pixel");
    expect(after).toEqual({ ...before, userdataGeneration: `77:${1_730_000_500_000}` });
  });

  test("an AVD that has never booted has no userdata generation yet", async () => {
    const { deps, files } = fakeDeps();
    files.clear();
    expect(
      (await new AvdFixtureIdentityProbe(deps).currentIdentity("pixel")).userdataGeneration,
    ).toBe("none");
  });

  test("refuses an AVD that is not on this host, or lacks system-image metadata", async () => {
    const { deps, config } = fakeDeps();
    const probe = new AvdFixtureIdentityProbe(deps);
    await expect(probe.currentIdentity("missing")).rejects.toThrow("missing");
    delete config.systemImagePackage;
    await expect(probe.currentIdentity("pixel")).rejects.toThrow("system-image");
  });

  test("refuses an empty emulator version rather than recording one", async () => {
    const { deps } = fakeDeps({ emulatorVersion: async () => "  \n" });
    await expect(new AvdFixtureIdentityProbe(deps).currentIdentity("pixel")).rejects.toThrow(
      "emulator version",
    );
  });
});
