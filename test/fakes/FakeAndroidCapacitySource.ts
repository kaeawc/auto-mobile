import type {
  AndroidCapacitySample,
  AndroidCapacitySource,
  ProcessTableFailure,
} from "../../src/features/bootAdmission/AndroidCapacitySource";

const GIB = 1024 ** 3;

/** Scripted Android capacity: tests mutate the fields between samples. */
export class FakeAndroidCapacitySource implements AndroidCapacitySource {
  emulatorSerials: string[] = [];
  /** Undefined models an unreadable process table. */
  emulatorProcessRssBytes: number[] | undefined = [];
  /** Pids of those processes, in order; undefined models a source that cannot tell. */
  emulatorProcessPids: number[] | undefined;
  host = { totalMemoryBytes: 64 * GIB, cpuCount: 16 };
  /** Set to model a failed adb listing (`emulatorSerials` is then ignored). */
  serialListingError: string | undefined;
  processTableFailure: ProcessTableFailure | undefined;
  samples = 0;
  /** Called before each sample is returned, e.g. to change the fleet mid-wait. */
  onSample: ((sampleNumber: number) => void) | undefined;

  async sample(): Promise<AndroidCapacitySample> {
    this.samples += 1;
    this.onSample?.(this.samples);
    const listingFailed = this.serialListingError !== undefined;
    return {
      emulatorSerials: listingFailed ? [] : [...this.emulatorSerials],
      emulatorProcessRssBytes: this.emulatorProcessRssBytes
        ? [...this.emulatorProcessRssBytes]
        : undefined,
      ...(this.emulatorProcessRssBytes && this.emulatorProcessPids
        ? { emulatorProcessIds: this.emulatorProcessPids.map((pid) => ({ pid, ppid: 1 })) }
        : {}),
      host: { ...this.host },
      errors: [
        ...(listingFailed ? [`adb: ${this.serialListingError}`] : []),
        ...(this.emulatorProcessRssBytes ? [] : ["ps: unavailable"]),
      ],
      ...(this.emulatorProcessRssBytes === undefined && this.processTableFailure
        ? { processTableFailure: this.processTableFailure }
        : {}),
      ...(listingFailed ? { serialListingFailed: true as const } : {}),
    };
  }
}
