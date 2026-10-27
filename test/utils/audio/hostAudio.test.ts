import { afterEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";
import {
  HostAudioProbe,
  hostAudioTransport,
  readHostAudio,
  type CoreAudioHal,
  type RawAudioDevice,
} from "../../../src/utils/audio/hostAudio";
import {
  androidEmulatorAudioCapabilities,
  iosSimulatorAudioCapabilities,
} from "../../../src/utils/audio/audioCapabilities";
import {
  hostAudioSnapshot,
  refreshHostAudio,
  setHostAudioProbeForTesting,
} from "../../../src/utils/audio/defaultHostAudioProbe";
import {
  buildAndroidAvdCapabilityInventory,
  iosSimulatorCapabilityInventory,
} from "../../../src/utils/virtualDeviceCapabilities";
import { parseAvdConfig } from "../../../src/utils/android-cmdline-tools/AvdConfigReader";

interface CapturedHal {
  defaults: { input: number | null; output: number | null };
  devices: Record<string, RawAudioDevice>;
}

const fixtureDir = path.resolve(import.meta.dir, "../../fixtures");
const captured: CapturedHal = JSON.parse(
  readFileSync(path.join(fixtureDir, "host-audio/coreaudio-macbook-pro.json"), "utf8"),
);

/** A fake HAL over a table of devices; defaults are mutable to model a default-device change. */
class FakeHal implements CoreAudioHal {
  describeCalls = 0;
  constructor(
    public defaults: { input?: number; output?: number },
    private readonly devices: Record<string, RawAudioDevice>,
  ) {}

  defaultDeviceId(direction: "input" | "output"): number | undefined {
    return this.defaults[direction];
  }

  describe(id: number): RawAudioDevice | undefined {
    this.describeCalls++;
    return this.devices[String(id)];
  }
}

const capturedHal = () =>
  new FakeHal(
    { input: captured.defaults.input ?? undefined, output: captured.defaults.output ?? undefined },
    captured.devices,
  );

const LOOPBACK: RawAudioDevice = {
  name: "BlackHole 2ch",
  transportCode: "virt",
  inputStreams: 1,
  outputStreams: 1,
};

const state = (inventory: { capabilities: { id: string; state: string }[] }, id: string) =>
  inventory.capabilities.find((capability) => capability.id === id)?.state;

describe("host audio probe (captured CoreAudio HAL output)", () => {
  test("a Mac with built-in speakers and microphone has input and output but no loopback", () => {
    const host = readHostAudio(capturedHal(), "darwin");
    expect(host.probed).toBe(true);
    expect(host.input).toEqual({
      name: "MacBook Pro Microphone",
      transport: "built_in",
      inputStreams: 1,
      outputStreams: 0,
    });
    expect(host.output?.name).toBe("MacBook Pro Speakers");
    expect(host.outputCaptureable).toBe(false);
  });

  test("a headless host with speakers and no input reports input unsupported with a reason", () => {
    const hal = new FakeHal({ output: 72 }, captured.devices);
    const inventory = iosSimulatorCapabilityInventory({
      hostAudio: readHostAudio(hal, "darwin"),
    });
    expect(state(inventory, "ios.simulator.audioInput")).toBe("unsupported");
    expect(
      inventory.capabilities.find((c) => c.id === "ios.simulator.audioInput")?.reason,
    ).toContain("No host audio input device; install a virtual loopback device");
    expect(state(inventory, "ios.simulator.audioOutput")).toBe("available");
    expect(state(inventory, "ios.simulator.audioOutputCapture")).toBe("unsupported");
  });

  test("a loopback device as default input and output makes all three iOS entries supported", () => {
    const hal = new FakeHal({ input: 1, output: 1 }, { "1": LOOPBACK });
    const entries = iosSimulatorAudioCapabilities(readHostAudio(hal, "darwin"));
    expect(entries.map((entry) => [entry.id, entry.state])).toEqual([
      ["ios.simulator.audioInput", "available"],
      ["ios.simulator.audioOutput", "available"],
      ["ios.simulator.audioOutputCapture", "available"],
    ]);
    expect(entries[0]?.reason).toContain("BlackHole 2ch (virtual)");
  });

  test("a loopback driver that reports a built-in transport is recognized by name", () => {
    const hal = new FakeHal(
      { input: 1, output: 1 },
      { "1": { ...LOOPBACK, name: "Loopback Audio", transportCode: "bltn" } },
    );
    expect(readHostAudio(hal, "darwin").outputCaptureable).toBe(true);
  });

  test("a default device with no stream in its direction does not count", () => {
    const hal = new FakeHal({ input: 72, output: 79 }, captured.devices);
    const host = readHostAudio(hal, "darwin");
    expect(host.input).toBeNull();
    expect(host.output).toBeNull();
  });

  test("transport four-character codes map to named transports", () => {
    expect(hostAudioTransport("bltn")).toBe("built_in");
    expect(hostAudioTransport("virt")).toBe("virtual");
    expect(hostAudioTransport("usb ")).toBe("usb");
    expect(hostAudioTransport("zzzz")).toBe("unknown");
    expect(hostAudioTransport(undefined)).toBe("unknown");
  });

  test("a host that was not probed adds no audio entries", () => {
    const host = new HostAudioProbe(undefined, "linux").snapshot();
    expect(host.probed).toBe(false);
    expect(iosSimulatorAudioCapabilities(host)).toEqual([]);
    expect(iosSimulatorCapabilityInventory({}).capabilities.map((c) => c.id)).not.toContain(
      "ios.simulator.audioInput",
    );
  });
});

describe("host audio cache", () => {
  test("is cached until a default device changes, then re-probed", () => {
    const hal = capturedHal();
    const probe = new HostAudioProbe(hal, "darwin");
    const first = probe.snapshot();
    expect(probe.snapshot()).toBe(first);
    const describesAfterFirst = hal.describeCalls;
    expect(describesAfterFirst).toBeGreaterThan(0);
    probe.snapshot();
    expect(hal.describeCalls).toBe(describesAfterFirst);
    hal.defaults = { output: 72 };
    const changed = probe.snapshot();
    expect(changed).not.toBe(first);
    expect(changed.input).toBeNull();
  });

  test("refresh forces a re-probe", () => {
    const hal = capturedHal();
    const probe = new HostAudioProbe(hal, "darwin");
    const first = probe.snapshot();
    expect(probe.refresh()).not.toBe(first);
  });
});

describe("default probe", () => {
  afterEach(() => setHostAudioProbeForTesting(undefined));

  test("is not probed under test unless a fake is injected", () => {
    expect(hostAudioSnapshot().probed).toBe(false);
    setHostAudioProbeForTesting(new HostAudioProbe(capturedHal(), "darwin"));
    expect(hostAudioSnapshot().probed).toBe(true);
    expect(refreshHostAudio().input?.name).toBe("MacBook Pro Microphone");
  });
});

describe("Android emulator audio (captured AVD config)", () => {
  const configText = readFileSync(path.join(fixtureDir, "android-avd-audio/config.ini"), "utf8");
  const props = (text: string) =>
    Object.fromEntries(
      text
        .split("\n")
        .map((line) => line.split("="))
        .filter((parts) => parts.length === 2)
        .map(([key, value]) => [key!.trim(), value!.trim()]),
    );
  const probed = readHostAudio(capturedHal(), "darwin");
  const noInputHost = readHostAudio(new FakeHal({ output: 72 }, captured.devices), "darwin");

  test("the captured AVD enables audio in both directions when the host has an input", () => {
    const inventory = buildAndroidAvdCapabilityInventory(props(configText), {
      launchWithoutAudio: false,
      hostAudio: probed,
    });
    expect(state(inventory, "android.emulator.audioInput")).toBe("available");
    expect(state(inventory, "android.emulator.audioOutput")).toBe("available");
  });

  test("hw.audioInput=no reports input unsupported and leaves output alone", () => {
    const edited = configText.replace("hw.audioInput=yes", "hw.audioInput=no");
    const inventory = buildAndroidAvdCapabilityInventory(props(edited), {
      launchWithoutAudio: false,
      hostAudio: probed,
    });
    expect(state(inventory, "android.emulator.audioInput")).toBe("unsupported");
    expect(state(inventory, "android.emulator.audioOutput")).toBe("available");
  });

  test("-no-audio at launch makes both directions unsupported", () => {
    const inventory = buildAndroidAvdCapabilityInventory(props(configText), {
      launchWithoutAudio: true,
      hostAudio: probed,
    });
    expect(state(inventory, "android.emulator.audioInput")).toBe("unsupported");
    expect(state(inventory, "android.emulator.audioOutput")).toBe("unsupported");
  });

  test("a host with no input makes emulator input unsupported with the actionable reason", () => {
    const entries = androidEmulatorAudioCapabilities({
      config: props(configText),
      launchWithoutAudio: false,
      host: noInputHost,
    });
    const input = entries.find((entry) => entry.id === "android.emulator.audioInput");
    expect(input?.state).toBe("unsupported");
    expect(input?.reason).toContain("No host audio input device");
    expect(entries.find((entry) => entry.id === "android.emulator.audioOutput")?.state).toBe(
      "available",
    );
  });

  test("an unprobed host leaves input to the AVD config alone", () => {
    const entries = androidEmulatorAudioCapabilities({
      config: props(configText),
      launchWithoutAudio: false,
      host: new HostAudioProbe(undefined, "linux").snapshot(),
    });
    expect(entries.map((entry) => [entry.id, entry.state])).toEqual([
      ["android.emulator.audioInput", "available"],
      ["android.emulator.audioOutput", "available"],
    ]);
  });

  test("keys the config does not state are left out", () => {
    expect(
      androidEmulatorAudioCapabilities({
        config: {},
        launchWithoutAudio: false,
        host: probed,
      }),
    ).toEqual([]);
  });

  test("the AVD reader derives the entries from config.ini (host unprobed under test)", () => {
    const capabilities = parseAvdConfig(configText).capabilityInventory?.capabilities ?? [];
    expect(capabilities.find((c) => c.id === "android.emulator.audioInput")?.state).toBe(
      "available",
    );
    expect(capabilities.find((c) => c.id === "android.emulator.audioOutput")?.state).toBe(
      "available",
    );
  });
});
