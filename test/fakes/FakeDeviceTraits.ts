import type {
  AndroidDeviceTraits,
  DeviceTraits,
  DeviceTraitsReadOptions,
} from "../../src/utils/android-cmdline-tools/deviceTraits";
import type { AdbCommandRunner } from "../../src/utils/android-cmdline-tools/interfaces/AdbExecutor";

/** Stock-emulator traits; override any field per test. */
export function androidDeviceTraits(
  overrides: Partial<AndroidDeviceTraits> = {},
): AndroidDeviceTraits {
  return {
    isEmulator: true,
    model: "sdk_gphone64_arm64",
    sdk: 35,
    abi: "arm64-v8a",
    manufacturer: "Google",
    brand: "google",
    skin: null,
    formFactor: null,
    ...overrides,
  };
}

/** Physical-handset traits; override any field per test. */
export function physicalDeviceTraits(
  overrides: Partial<AndroidDeviceTraits> = {},
): AndroidDeviceTraits {
  return androidDeviceTraits({
    isEmulator: false,
    model: "Pixel 8",
    manufacturer: "Google",
    brand: "google",
    ...overrides,
  });
}

/** Answers configured traits without touching adb; records every read. */
export class FakeDeviceTraits implements DeviceTraits {
  readonly reads: Array<{ deviceId: string; options?: DeviceTraitsReadOptions }> = [];
  private readonly byDevice = new Map<string, AndroidDeviceTraits | Error>();

  constructor(private fallback: AndroidDeviceTraits | Error = androidDeviceTraits()) {}

  /** Answer for every device without its own entry. */
  setTraits(traits: AndroidDeviceTraits | Error): void {
    this.fallback = traits;
  }

  /** Answer for one device. */
  setTraitsFor(deviceId: string, traits: AndroidDeviceTraits | Error): void {
    this.byDevice.set(deviceId, traits);
  }

  async read(
    _adb: AdbCommandRunner,
    deviceId: string,
    options?: DeviceTraitsReadOptions,
  ): Promise<AndroidDeviceTraits> {
    this.reads.push({ deviceId, ...(options ? { options } : {}) });
    const answer = this.byDevice.get(deviceId) ?? this.fallback;
    if (answer instanceof Error) {
      throw answer;
    }
    return answer;
  }
}
