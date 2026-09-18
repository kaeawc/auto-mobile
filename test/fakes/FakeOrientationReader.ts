import type { BootedDevice } from "../../src/models";
import type { OrientationReader } from "../../src/features/action/OrientationReader";

type Orientation = "portrait" | "landscape" | null;

/** Deterministic orientation-reader fake for consumers of the read seam. */
export class FakeOrientationReader implements OrientationReader {
  private result: Orientation = null;
  private readonly results: Orientation[] = [];

  setResult(result: Orientation): void {
    this.result = result;
  }

  enqueueResults(...results: Orientation[]): void {
    this.results.push(...results);
  }

  async readOrientation(_device: BootedDevice): Promise<Orientation> {
    return this.results.shift() ?? this.result;
  }
}
