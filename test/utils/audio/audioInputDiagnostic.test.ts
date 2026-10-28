import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";
import type { BootedDevice } from "../../../src/models";
import { AUDIO_INPUT_UNAVAILABLE } from "../../../src/models/AudioInputDiagnostic";
import {
  audioInputDiagnosticFromCapabilities,
  createAudioInputDiagnosticResolver,
} from "../../../src/utils/audio/audioInputDiagnostic";
import {
  HostAudioProbe,
  unprobedHostAudio,
  type CoreAudioHal,
  type RawAudioDevice,
} from "../../../src/utils/audio/hostAudio";
import { buildAndroidAvdCapabilityInventory } from "../../../src/utils/virtualDeviceCapabilities";
import { parseAvdConfig } from "../../../src/utils/android-cmdline-tools/AvdConfigReader";
import { FakeAvdConfigReader } from "../../fakes/FakeAvdConfigReader";

const MIC: RawAudioDevice = {
  name: "MacBook Pro Microphone",
  transportCode: "bltn",
  inputStreams: 1,
  outputStreams: 0,
};
const SPEAKERS: RawAudioDevice = {
  name: "Mac mini Speakers",
  transportCode: "bltn",
  inputStreams: 0,
  outputStreams: 1,
};
const LOOPBACK: RawAudioDevice = {
  name: "BlackHole 2ch",
  transportCode: "virt",
  inputStreams: 1,
  outputStreams: 1,
};

/** A HAL whose default devices can be changed, as plugging in or removing a device does. */
class FakeHal implements CoreAudioHal {
  constructor(
    public defaults: { input?: number; output?: number },
    private readonly devices: Record<number, RawAudioDevice>,
  ) {}

  defaultDeviceId(direction: "input" | "output"): number | undefined {
    return this.defaults[direction];
  }

  describe(id: number): RawAudioDevice | undefined {
    return this.devices[id];
  }
}

const DEVICES = { 1: MIC, 2: SPEAKERS, 3: LOOPBACK };
const simulator: BootedDevice = {
  name: "iPhone 16",
  platform: "ios",
  deviceId: "12345678-1234-1234-1234-123456789ABC",
};
const physicalIphone: BootedDevice = {
  name: "iPhone",
  platform: "ios",
  deviceId: "00008110-001234567890ABCD",
};

function resolverFor(hal: FakeHal) {
  const probe = new HostAudioProbe(hal, "darwin");
  return createAudioInputDiagnosticResolver(() => probe.snapshot());
}

function emulator(config: Record<string, string>, launchWithoutAudio = false): BootedDevice {
  return {
    name: "Pixel",
    platform: "android",
    deviceId: "emulator-5554",
    capabilityInventory: buildAndroidAvdCapabilityInventory(config, {
      launchWithoutAudio,
      hostAudio: unprobedHostAudio("linux", "not probed"),
    }),
  };
}

describe("audio_input_unavailable diagnostic", () => {
  test("a simulator on a host with no input device gets the typed, non-retryable diagnostic", async () => {
    const diagnostic = await resolverFor(new FakeHal({ output: 2 }, DEVICES))(simulator);
    expect(diagnostic?.code).toBe(AUDIO_INPUT_UNAVAILABLE);
    expect(diagnostic?.retryable).toBe(false);
    expect(diagnostic?.message).toStartWith("No host audio input device;");
    expect(diagnostic?.message).toContain("do not retry");
  });

  test("a host with a real or loopback default input emits nothing", async () => {
    expect(
      await resolverFor(new FakeHal({ input: 1, output: 2 }, DEVICES))(simulator),
    ).toBeUndefined();
    expect(
      await resolverFor(new FakeHal({ input: 3, output: 3 }, DEVICES))(simulator),
    ).toBeUndefined();
  });

  test("the diagnostic follows the live default input as it is removed and restored", async () => {
    const hal = new FakeHal({ input: 1, output: 2 }, DEVICES);
    const resolve = resolverFor(hal);
    expect(await resolve(simulator)).toBeUndefined();
    hal.defaults.input = undefined;
    expect((await resolve(simulator))?.code).toBe(AUDIO_INPUT_UNAVAILABLE);
    hal.defaults.input = 3;
    expect(await resolve(simulator)).toBeUndefined();
  });

  test("an unprobed host and a physical iPhone never get the diagnostic", async () => {
    const unprobed = createAudioInputDiagnosticResolver(() => unprobedHostAudio("linux", "n/a"));
    expect(await unprobed(simulator)).toBeUndefined();
    expect(await resolverFor(new FakeHal({ output: 2 }, DEVICES))(physicalIphone)).toBeUndefined();
  });

  test("an emulator launched with -no-audio or with hw.audioInput=no gets the same code", async () => {
    const resolve = createAudioInputDiagnosticResolver(() => unprobedHostAudio("linux", "n/a"));
    const noAudio = await resolve(emulator({ "hw.audioInput": "yes" }, true));
    expect(noAudio?.code).toBe(AUDIO_INPUT_UNAVAILABLE);
    expect(noAudio?.message).toContain("-no-audio");
    expect((await resolve(emulator({ "hw.audioInput": "no" })))?.message).toContain(
      "hw.audioInput=no",
    );
  });

  test("an emulator with audio input enabled, or with no inventory, emits nothing", async () => {
    const resolve = createAudioInputDiagnosticResolver(() => unprobedHostAudio("linux", "n/a"));
    expect(await resolve(emulator({ "hw.audioInput": "yes" }))).toBeUndefined();
    expect(
      await resolve({ name: "Pixel", platform: "android", deviceId: "emulator-5554" }),
    ).toBeUndefined();
  });

  test("an unavailable output entry alone is not an input diagnostic", () => {
    expect(
      audioInputDiagnosticFromCapabilities([
        { id: "android.emulator.audioOutput", state: "unsupported", source: "avd_config" },
        { id: "android.emulator.audioInput", state: "available", source: "avd_config" },
      ]),
    ).toBeUndefined();
  });

  describe("an emulator that arrives without an inventory (the daemon session path)", () => {
    const configIni = readFileSync(
      path.resolve(import.meta.dir, "../../fixtures/android-avd-audio/config.ini"),
      "utf8",
    );
    const bare: BootedDevice = { name: "Pixel_9", platform: "android", deviceId: "emulator-5554" };
    const unprobed = () => unprobedHostAudio("linux", "n/a");

    test("reads hw.audioInput=no from its AVD config", async () => {
      const reader = FakeAvdConfigReader.forAvds({
        Pixel_9: parseAvdConfig(configIni.replace("hw.audioInput=yes", "hw.audioInput=no")),
      });
      const diagnostic = await createAudioInputDiagnosticResolver(unprobed, reader)(bare);
      expect(diagnostic?.message).toContain("hw.audioInput=no");
      expect(reader.readConfigCalls).toEqual(["Pixel_9"]);
    });

    test("an AVD with audio input, or an unknown AVD, emits nothing", async () => {
      const reader = FakeAvdConfigReader.forAvds({ Pixel_9: parseAvdConfig(configIni) });
      const resolve = createAudioInputDiagnosticResolver(unprobed, reader);
      expect(await resolve(bare)).toBeUndefined();
      expect(await resolve({ ...bare, name: "Missing" })).toBeUndefined();
    });

    test("a device that already has an inventory, or is not an emulator, reads no config", async () => {
      const reader = FakeAvdConfigReader.forAvds({ Pixel_9: parseAvdConfig(configIni) });
      const resolve = createAudioInputDiagnosticResolver(unprobed, reader);
      await resolve(emulator({ "hw.audioInput": "yes" }));
      await resolve({ ...bare, deviceId: "R5CT1234ABC" });
      expect(reader.readConfigCalls).toEqual([]);
    });

    test("an unreadable AVD config leaves input unknown rather than unavailable", async () => {
      const throwing = {
        readConfig: async (): Promise<null> => {
          throw new Error("EACCES");
        },
      };
      expect(await createAudioInputDiagnosticResolver(unprobed, throwing)(bare)).toBeUndefined();
    });
  });
});
