import type {
  AndroidCapacitySample,
  AndroidCapacitySource,
} from "../../src/features/bootAdmission/AndroidCapacitySource";

const GIB = 1024 ** 3;

/** Scripted Android capacity: tests mutate the fields between samples. */
export class FakeAndroidCapacitySource implements AndroidCapacitySource {
  emulatorSerials: string[] = [];
  /** Undefined models an unreadable process table. */
  emulatorProcessRssBytes: number[] | undefined = [];
  host = { totalMemoryBytes: 64 * GIB, cpuCount: 16 };
  samples = 0;
  /** Called before each sample is returned, e.g. to change the fleet mid-wait. */
  onSample: ((sampleNumber: number) => void) | undefined;

  async sample(): Promise<AndroidCapacitySample> {
    this.samples += 1;
    this.onSample?.(this.samples);
    return {
      emulatorSerials: [...this.emulatorSerials],
      emulatorProcessRssBytes: this.emulatorProcessRssBytes
        ? [...this.emulatorProcessRssBytes]
        : undefined,
      host: { ...this.host },
      errors: [],
    };
  }
}
