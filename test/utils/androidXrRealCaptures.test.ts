import { readFileSync } from "node:fs";
import { describe, expect, it } from "bun:test";
import { pickAndroidSystemImage } from "../../src/devices/deviceProvisioning";
import { AvdManagerClient } from "../../src/utils/android-cmdline-tools/AvdManagerClient";
import { parseAvdConfig } from "../../src/utils/android-cmdline-tools/AvdConfigReader";
import { avdConfigFormFactor } from "../../src/utils/android-cmdline-tools/avdDeviceInfoEnrichment";
import { parseSystemImages } from "../../src/utils/android-cmdline-tools/avdmanager";
import { FakeChildProcess } from "../fakes/FakeChildProcess";
import { FakeTimer } from "../fakes/FakeTimer";

const fixture = (name: string): string =>
  readFileSync(new URL(`../fixtures/android-xr/${name}`, import.meta.url), "utf8");

describe("Android XR real captures", () => {
  it("parses and selects the installed headset image", () => {
    const images = parseSystemImages(
      fixture("sdkmanager-list-installed-xr-headset.txt"),
      undefined,
      "installed",
    );
    expect(images.map(({ packageName }) => packageName)).toContain(
      "system-images;android-34;google-xr;arm64-v8a",
    );
    expect(pickAndroidSystemImage(images, { formFactor: "xr-headset" }, "arm64").packageName).toBe(
      "system-images;android-34;google-xr;arm64-v8a",
    );
  });

  it("classifies the captured AVD config as a headset from its XR tag", () => {
    const config = parseAvdConfig(fixture("headset-avd-config.ini"));
    expect(config.tag).toBe("android-xr");
    expect(config.systemImagePath).toBe("system-images/android-34/google-xr/arm64-v8a/");
    expect(avdConfigFormFactor(config)).toBe("xr-headset");
  });

  it("parses and classifies the captured avdmanager headset entry", async () => {
    const timer = new FakeTimer();
    const child = new FakeChildProcess(timer);
    const client = new AvdManagerClient({
      detectAndroidCommandLineTools: async () => [
        {
          path: "/sdk/cmdline-tools/latest",
          source: "manual",
          available_tools: ["avdmanager"],
        },
      ],
      getAndroidHomeWithSystemImages: () => null,
      getBestAndroidToolsLocation: (locations) => locations[0] ?? null,
      validateRequiredTools: () => ({ valid: true, missing: [] }),
      existsSync: (path) => path.endsWith("avdmanager") || path.endsWith("system-images"),
      spawn: () => child,
      logger: { info() {}, warn() {}, error() {} },
      timer,
      environment: { ANDROID_HOME: "/sdk" },
      platform: "linux",
    });

    child.addStdoutData(fixture("avdmanager-list-avd-xr-headset.txt"));
    const pending = client.listDeviceImages();
    await new Promise<void>((resolve) => setImmediate(resolve));
    child.simulateSpawn();
    child.simulateExit(0);
    await timer.advanceTimersByTimeAsync(0);
    const [avd] = await pending;

    expect(avd).toMatchObject({
      name: "AutoMobile-android-xr-headset-34-8f12f88d",
      path: "<home>/.android/avd/AutoMobile-android-xr-headset-34-8f12f88d.avd",
      target: "Android XR (Google Inc.)",
    });
    expect(avd.basedOn).toContain("Tag/ABI: android-xr/arm64-v8a");
  });
});
